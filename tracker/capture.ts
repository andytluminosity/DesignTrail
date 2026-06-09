import path from "path";
import { fileURLToPath } from "url";
import { getLatestCommit, getDiff, getRepoName } from "./git.js";
import { takeScreenshots, getSiteContext } from "./screenshot.js";
import type { ScreenshotJob } from "./screenshot.js";
import { analyzeCommit } from "./llm.js";
import { DesignGraph } from "./graph.js";
import { resolveBranch, resolveParentBranch, MAIN_BRANCH } from "./branch.js";
import type { CommitData, IterationNode } from "./types.js";

// Resolve the tracker's own root (DesignTrail) so the pipeline works no matter
// which repo's git hook triggered it (e.g. DesignTrail itself or TempRepo).
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load env (OPENAI_API_KEY, optional CAPTURE_URL) from the tracker root, since
// the current working directory will be the committing repo, not DesignTrail.
try {
  process.loadEnvFile(path.join(TRACKER_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

type DebugEntry = {
  branchId: string;
  parentBranchId: string | null;
  parentId: string | null;
  type: string;
  summary: string;
  screenshotPath: string;
};

function logCommit(hash: string, repo: string, entries: DebugEntry[]): void {
  console.log("========================");
  console.log(`COMMIT: ${hash}   REPO: ${repo}`);
  for (const e of entries) {
    console.log("");
    console.log(`COMPONENT: ${e.branchId}`);
    console.log(`  PARENT BRANCH: ${e.parentBranchId ?? "none"}`);
    console.log(`  PARENT NODE:   ${e.parentId ?? "none"}`);
    console.log(`  TYPE:          ${e.type}`);
    console.log(`  SUMMARY:       ${e.summary}`);
    console.log(`  SCREENSHOT:    ${e.screenshotPath}`);
  }
  console.log("========================");
}

async function main(): Promise<void> {
  const { hash, message } = await getLatestCommit();
  const diff = await getDiff(hash);
  const repoName = await getRepoName();

  const commit: CommitData = {
    hash,
    message,
    diff,
    timestamp: Date.now(),
  };

  const graph = await DesignGraph.load(repoName);

  // Read the live DOM (across pages) first so the LLM targets elements that
  // actually exist, and pass the existing branch tree so it reuses/nests
  // component branches correctly.
  const siteContext = await getSiteContext(CAPTURE_URL);

  const { components } = await analyzeCommit({
    diff: commit.diff,
    commitMessage: commit.message,
    siteContext,
    existingBranches: graph.getBranches(),
  });

  const jobs: ScreenshotJob[] = [];
  const entries: DebugEntry[] = [];

  // Persist the commit, branches, and component nodes atomically. Screenshots
  // (async IO) happen afterwards, outside the transaction.
  graph.transaction(() => {
    graph.upsertCommit(commit);

    for (const change of components) {
      const branchId = resolveBranch(change.component);

      if (!graph.branchExists(branchId)) {
        const parentBranchId =
          branchId === MAIN_BRANCH
            ? null
            : resolveParentBranch(change.parentBranch, graph.getBranchNames());
        const forkNodeId = parentBranchId ? graph.getBranchTip(parentBranchId) : null;
        graph.ensureBranch(branchId, parentBranchId, forkNodeId);
      }

      // Parent node is the current tip of this component branch (null if the
      // branch was just created in this commit).
      const parentId = graph.getBranchTip(branchId);

      const screenshotPath = path.join("captures", repoName, commit.hash, `${branchId}.png`);

      const node: IterationNode = {
        id: `${commit.hash}:${branchId}`,
        commitHash: commit.hash,
        branchId,
        parentId,
        summary: change.summary,
        type: change.type,
        screenshotPath,
        timestamp: commit.timestamp,
      };
      graph.addNode(node);

      jobs.push({
        outputPath: path.join(TRACKER_ROOT, screenshotPath),
        target: change.screenshotTarget,
        navPath: change.path ?? "/",
      });

      const branchRecord = graph.getBranch(branchId);
      entries.push({
        branchId,
        parentBranchId: branchRecord?.parentBranchId ?? null,
        parentId,
        type: change.type,
        summary: change.summary,
        screenshotPath,
      });
    }
  });

  logCommit(commit.hash, repoName, entries);

  await takeScreenshots(jobs, CAPTURE_URL);

  graph.close();
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
