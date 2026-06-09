import path from "path";
import { fileURLToPath } from "url";
import { getLatestCommit, getDiff, getRepoName } from "./git.js";
import { takeScreenshots, getSiteContext } from "./screenshot.js";
import type { ScreenshotJob } from "./screenshot.js";
import { analyzeCommit } from "./llm.js";
import { DesignGraph } from "./graph.js";
import { deriveContainmentParents } from "./layout.js";
import { resolveBranch, resolveParentBranch, MAIN_BRANCH } from "./branch.js";
import { createCommitNode } from "../miro/miroClient.js";
import type { CommitData, IterationNode, ScreenshotTarget } from "./types.js";

/**
 * How to re-screenshot an ancestor branch whose stored target is missing
 * (legacy branches created before per-branch target persistence). main -> full
 * page; any other branch -> its class as a best-effort component selector.
 */
function fallbackTarget(branchId: string): ScreenshotTarget {
  if (branchId === MAIN_BRANCH) return { mode: "full" };
  return { mode: "selector", value: `[class~="${branchId}"]` };
}

/**
 * A named component IS a container, so it must be screenshotted as that
 * container — never the whole page. If a target for a named component is
 * full-page (the LLM bailed to "full", or a legacy branch stored one), coerce
 * it to the component's own container selector so we frame the component and
 * never stamp the branch with a page-sized rect that corrupts spatial nesting.
 * main keeps its legitimate full-page capture.
 */
function containerTarget(branchId: string, target: ScreenshotTarget): ScreenshotTarget {
  if (branchId !== MAIN_BRANCH && target.mode === "full") {
    return fallbackTarget(branchId);
  }
  return target;
}

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
  const repoPath = path.resolve(process.argv[2] ?? process.cwd());
  const { hash, message } = await getLatestCommit(repoPath);
  const diff = await getDiff(hash, repoPath);
  const repoName = await getRepoName(repoPath);

  const commit: CommitData = {
    hash,
    message,
    diff,
    timestamp: Date.now(),
    repoName,
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
  // outputPath -> node id, so geometry returned by the screenshotter can be
  // written back onto the right node after captures finish.
  const nodeByOutput = new Map<string, string>();

  // Persist the commit, branches, and component nodes atomically. Screenshots
  // (async IO) happen afterwards, outside the transaction.
  graph.transaction(() => {
    graph.upsertCommit(commit);

    // Ensure the root exists so cascading updates can always reach it; it is
    // captured full-page.
    graph.ensureBranch(MAIN_BRANCH, null, null, "/", { mode: "full" });

    // Branches created in THIS commit (trigger cascading ancestor updates) and
    // branches that already received a node this commit (skipped by the cascade).
    const newBranches: string[] = [];
    const nodedBranches = new Set<string>();

    const addNodeAndJob = (
      branchId: string,
      summary: string,
      type: IterationNode["type"],
      target: ScreenshotTarget,
      navPath: string
    ): { parentId: string | null; screenshotPath: string } => {
      // Parent node is the current tip of this branch (null if just created).
      const parentId = graph.getBranchTip(branchId);
      const screenshotPath = path.join(
        "captures",
        repoName,
        commit.hash,
        `${branchId}.png`
      );

      graph.addNode({
        id: `${commit.hash}:${branchId}`,
        commitHash: commit.hash,
        branchId,
        parentId,
        summary,
        type,
        screenshotPath,
        timestamp: commit.timestamp,
      });
      nodedBranches.add(branchId);

      const outputPath = path.join(TRACKER_ROOT, screenshotPath);
      nodeByOutput.set(outputPath, `${commit.hash}:${branchId}`);
      jobs.push({ outputPath, target, navPath });

      return { parentId, screenshotPath };
    };

    for (const change of components) {
      const branchId = resolveBranch(change.component);
      const navPath = change.path ?? "/";
      const target = containerTarget(branchId, change.screenshotTarget);

      if (!graph.branchExists(branchId)) {
        const parentBranchId =
          branchId === MAIN_BRANCH
            ? null
            : resolveParentBranch(change.parentBranch, graph.getBranchNames());
        const forkNodeId = parentBranchId ? graph.getBranchTip(parentBranchId) : null;
        graph.ensureBranch(branchId, parentBranchId, forkNodeId, navPath, target);
        if (branchId !== MAIN_BRANCH) newBranches.push(branchId);
      } else {
        // Refresh how to re-screenshot this component for future cascades.
        graph.setBranchCapture(branchId, navPath, target);
      }

      const { parentId, screenshotPath } = addNodeAndJob(
        branchId,
        change.summary,
        change.type,
        target,
        navPath
      );

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

    // Cascading ancestor updates: whenever a new component (branch) is added,
    // every ancestor up to the root gets a fresh node re-capturing its own
    // component, reflecting the new descendant. Append-only: each ancestor gains
    // one new node (deduped per commit), never overwriting prior history.
    const triggeredBy = new Map<string, Set<string>>();
    for (const created of newBranches) {
      let current = graph.getBranch(created)?.parentBranchId ?? null;
      while (current) {
        if (!triggeredBy.has(current)) triggeredBy.set(current, new Set());
        triggeredBy.get(current)!.add(created);
        current = graph.getBranch(current)?.parentBranchId ?? null;
      }
    }

    for (const [ancestor, children] of triggeredBy) {
      // A branch directly changed this commit already has an up-to-date node.
      if (nodedBranches.has(ancestor)) continue;

      const branch = graph.getBranch(ancestor);
      const target = containerTarget(ancestor, branch?.target ?? fallbackTarget(ancestor));
      const navPath = branch?.navPath ?? "/";
      const summary = `Updated to reflect new nested component(s): ${[...children]
        .sort()
        .join(", ")}`;

      const { parentId, screenshotPath } = addNodeAndJob(
        ancestor,
        summary,
        "UI_CHANGE",
        target,
        navPath
      );

      entries.push({
        branchId: ancestor,
        parentBranchId: branch?.parentBranchId ?? null,
        parentId,
        type: "UI_CHANGE",
        summary,
        screenshotPath,
      });
    }
  });

  logCommit(commit.hash, repoName, entries);

  const results = await takeScreenshots(jobs, CAPTURE_URL);

  // Persist each captured element's geometry onto its node so the spatial board
  // can nest/position branches by real on-screen containment.
  graph.transaction(() => {
    for (const { outputPath, geometry } of results) {
      if (!geometry) continue;
      const nodeId = nodeByOutput.get(outputPath);
      if (nodeId) graph.setNodeGeometry(nodeId, geometry);
    }
  });

  // Now that each branch's container geometry is known, derive branch nesting
  // from spatial containment and persist it so the stored tree matches the
  // board: every branch with container geometry nests under the smallest OTHER
  // branch whose container encloses it (main/page ends up the root). The LLM
  // parentBranch remains the fallback for branches that never got geometry, so
  // those are left untouched here.
  const { branches, nodes } = graph.exportGraph();
  const derived = deriveContainmentParents(branches, nodes);
  graph.transaction(() => {
    for (const [branchId, parentBranchId] of derived) {
      graph.setBranchParent(branchId, parentBranchId);
    }
  });

  graph.close();

  // Mirror this commit's capture onto the Miro timeline board.
  await createCommitNode(commit);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
