import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { getLatestCommit, getDiff, getRepoName } from "../../tracker/git.js";
import { takeScreenshots, getSiteContext } from "../../tracker/screenshot.js";
import type { ScreenshotJob } from "../../tracker/screenshot.js";
import { analyzeCommit } from "../../tracker/llm.js";
import { annotateScreenshots } from "../../tracker/annotate.js";
import { DesignGraph } from "../../tracker/graph.js";
import { deriveContainmentParents } from "../../tracker/layout.js";
import { planFolderLayout } from "../../tracker/treeStore.js";
import { resolveBranch, resolveParentBranch, MAIN_BRANCH } from "../../tracker/branch.js";
import { renderBoardFromGraph } from "../../miro/miroClient.js";
import type {
  BranchRecord,
  CommitData,
  IterationNode,
  ScreenshotResult,
  ScreenshotTarget,
} from "../../tracker/types.js";

export type CreateDesignSnapshotOptions = {
  annotation?: string;
  repoPath?: string;
  source?: string;
  syncMiro?: boolean;
};

export type DesignSnapshotEntry = {
  branchId: string;
  parentBranchId: string | null;
  parentId: string | null;
  type: string;
  summary: string;
  annotation: string | null;
  screenshotPath: string;
};

export type DesignSnapshotResult = {
  commit: CommitData;
  repoName: string;
  repoPath: string;
  entries: DesignSnapshotEntry[];
  screenshots: ScreenshotResult[];
  miroNodes: Awaited<ReturnType<typeof renderBoardFromGraph>>;
};

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
 * container, never the whole page. main keeps its legitimate full-page capture.
 */
function containerTarget(branchId: string, target: ScreenshotTarget): ScreenshotTarget {
  if (branchId !== MAIN_BRANCH && target.mode === "full") {
    return fallbackTarget(branchId);
  }
  return target;
}

// Resolve DesignTrail root so the workflow works no matter which repo invokes it.
const DESIGNTRAIL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Recursively removes directories left empty under `dir` after screenshots move
 * into the nested branch tree. `dir` itself is preserved.
 */
async function pruneEmptyDirs(dir: string): Promise<void> {
  if (!(await fse.pathExists(dir))) return;
  for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name);
      await pruneEmptyDirs(child);
      const remaining = await fse.readdir(child);
      if (remaining.length === 0) await fse.remove(child);
    }
  }
}

/**
 * Mirrors the finalized branch tree onto disk and repoints node screenshot paths
 * so SQLite remains the source of truth for the current PNG location.
 */
async function materializeFolderTree(
  graph: DesignGraph,
  repoName: string
): Promise<Map<string, string>> {
  const { branches, nodes } = graph.exportGraph();
  const moves = planFolderLayout(branches, nodes, repoName);
  const screenshotPathByNodeId = new Map(
    moves.map((move) => [move.nodeId, move.desiredPath])
  );

  const applied: { nodeId: string; desiredPath: string }[] = [];
  for (const move of moves) {
    if (move.currentPath === move.desiredPath) continue;
    const from = path.join(DESIGNTRAIL_ROOT, move.currentPath);
    const to = path.join(DESIGNTRAIL_ROOT, move.desiredPath);
    if (move.currentPath && (await fse.pathExists(from))) {
      await fse.move(from, to, { overwrite: true });
    }
    applied.push({ nodeId: move.nodeId, desiredPath: move.desiredPath });
  }

  graph.transaction(() => {
    for (const { nodeId, desiredPath } of applied) {
      graph.setNodeScreenshotPath(nodeId, desiredPath);
    }
  });

  await pruneEmptyDirs(path.join(DESIGNTRAIL_ROOT, "captures", repoName));
  return screenshotPathByNodeId;
}

try {
  process.loadEnvFile(path.join(DESIGNTRAIL_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** SHA-256 of a file's bytes, or null if it can't be read. */
async function hashFile(absPath: string): Promise<string | null> {
  try {
    const buf = await fse.readFile(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Creates a DesignTrail design snapshot for the latest commit in the target
 * repository. CLI callers can omit repoPath and use cwd; integrations should
 * pass repoPath explicitly so they do not need to mutate process state.
 */
export async function createDesignSnapshot(
  options?: CreateDesignSnapshotOptions
): Promise<DesignSnapshotResult> {
  const repoPath = path.resolve(options?.repoPath ?? process.cwd());
  const { hash, message } = await getLatestCommit(repoPath);
  const diff = await getDiff(hash, repoPath);
  const repoName = await getRepoName(repoPath);

  const commit: CommitData = {
    hash,
    message,
    diff,
    timestamp: Date.now(),
    repoName,
    source: normalizeOptional(options?.source),
    annotation: normalizeOptional(options?.annotation),
  };

  const graph = await DesignGraph.load(repoName);
  const jobs: ScreenshotJob[] = [];
  let entries: DesignSnapshotEntry[] = [];
  const nodeByOutput = new Map<string, string>();
  let screenshots: ScreenshotResult[] = [];
  // Full graph snapshot captured before the DB is closed, so the whole board can
  // be re-rendered as a tree (not just this commit's nodes).
  let boardExport: {
    branches: BranchRecord[];
    nodes: IterationNode[];
    commits: Map<string, CommitData>;
  } | null = null;

  try {
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

        const outputPath = path.join(DESIGNTRAIL_ROOT, screenshotPath);
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
          annotation: null,
          screenshotPath,
        });
      }

      // Cascading ancestor updates: whenever a new component (branch) is added,
      // every ancestor up to the root gets a fresh node re-capturing its own
      // component, reflecting the new descendant.
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
          annotation: null,
          screenshotPath,
        });
      }
    });

    screenshots = await takeScreenshots(jobs, CAPTURE_URL);

    // Drop captures that are byte-identical to the previous node on the SAME
    // branch. An unchanged capture records no new visual information and would
    // otherwise litter the branch with duplicate PNGs under different names —
    // most commonly a cascading `main` re-capture triggered by a change that is
    // only visible on another route. Comparing against the parent node (the
    // branch tip before this commit) keeps the per-branch history meaningful.
    const removedOutputs = new Set<string>();
    const removedNodeIds = new Set<string>();
    for (const { outputPath } of screenshots) {
      const nodeId = nodeByOutput.get(outputPath);
      if (!nodeId) continue;
      const node = graph.getNode(nodeId);
      if (!node?.parentId) continue;
      const parent = graph.getNode(node.parentId);
      if (!parent) continue;

      const [newHash, parentHash] = await Promise.all([
        hashFile(outputPath),
        hashFile(path.join(DESIGNTRAIL_ROOT, parent.screenshotPath)),
      ]);
      if (newHash && parentHash && newHash === parentHash) {
        removedOutputs.add(outputPath);
        removedNodeIds.add(nodeId);
      }
    }

    if (removedNodeIds.size > 0) {
      graph.transaction(() => {
        for (const id of removedNodeIds) graph.deleteNode(id);
      });
      await Promise.all([...removedOutputs].map((p) => fse.remove(p)));
      screenshots = screenshots.filter((s) => !removedOutputs.has(s.outputPath));
      entries = entries.filter(
        (e) => !removedNodeIds.has(`${commit.hash}:${e.branchId}`)
      );
    }

    // Generate a unique, design-oriented annotation (What changed + a hedged
    // guess at Why) for each surviving screenshot via a vision pass, then persist
    // it on the node and back onto the entry. Runs after dedup so removed
    // captures aren't annotated, and against the pre-mirror outputPath (the PNG
    // still lives there at this point).
    const entryByNodeId = new Map(
      entries.map((entry) => [`${commit.hash}:${entry.branchId}`, entry])
    );
    const annotationInputs = screenshots
      .map(({ outputPath }) => {
        const nodeId = nodeByOutput.get(outputPath);
        const entry = nodeId ? entryByNodeId.get(nodeId) : undefined;
        if (!entry) return null;
        return {
          outputPath,
          branchId: entry.branchId,
          summary: entry.summary,
          type: entry.type,
          commitMessage: commit.message,
          diff: commit.diff,
        };
      })
      .filter((input): input is NonNullable<typeof input> => input !== null);

    const annotations = await annotateScreenshots(annotationInputs);

    graph.transaction(() => {
      for (const { outputPath, annotation } of annotations) {
        const nodeId = nodeByOutput.get(outputPath);
        if (nodeId) {
          graph.setNodeAnnotation(nodeId, annotation);
          const entry = entryByNodeId.get(nodeId);
          if (entry) entry.annotation = annotation;
        }
      }
    });

    // Persist each captured element's geometry onto its node so the spatial board
    // can nest/position branches by real on-screen containment.
    graph.transaction(() => {
      for (const { outputPath, geometry } of screenshots) {
        if (!geometry) continue;
        const nodeId = nodeByOutput.get(outputPath);
        if (nodeId) graph.setNodeGeometry(nodeId, geometry);
      }
    });

    const { branches, nodes } = graph.exportGraph();
    const derived = deriveContainmentParents(branches, nodes);
    graph.transaction(() => {
      for (const [branchId, parentBranchId] of derived) {
        graph.setBranchParent(branchId, parentBranchId);
      }
    });

    const screenshotPathByNodeId = await materializeFolderTree(graph, repoName);
    for (const entry of entries) {
      entry.screenshotPath =
        screenshotPathByNodeId.get(`${commit.hash}:${entry.branchId}`) ??
        entry.screenshotPath;
    }
    screenshots = screenshots.map((screenshot) => {
      const nodeId = nodeByOutput.get(screenshot.outputPath);
      const screenshotPath = nodeId ? screenshotPathByNodeId.get(nodeId) : undefined;
      return screenshotPath
        ? { ...screenshot, outputPath: path.join(DESIGNTRAIL_ROOT, screenshotPath) }
        : screenshot;
    });

    // Snapshot the finalized graph (paths now point at the mirrored tree) plus
    // commit metadata so the Miro board can be wiped and re-rendered in full.
    const finalGraph = graph.exportGraph();
    boardExport = {
      branches: finalGraph.branches,
      nodes: finalGraph.nodes,
      commits: graph.getCommits(),
    };
  } finally {
    graph.close();
  }

  // Wipe the board and re-render the ENTIRE component tree (every commit's
  // screenshots), so locations are recomputed and the new commit is included.
  const miroNodes =
    options?.syncMiro === false || !boardExport
      ? []
      : await renderBoardFromGraph(
          boardExport.branches,
          boardExport.nodes,
          boardExport.commits
        );

  return {
    commit,
    repoName,
    repoPath,
    entries,
    screenshots,
    miroNodes,
  };
}
