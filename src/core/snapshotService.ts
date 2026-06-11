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
import { planDuplicateCollapse, planBranchPromotion } from "../../tracker/prune.js";
import { resolveBranch, resolveParentBranch, MAIN_BRANCH } from "../../tracker/branch.js";
import type { RenderedBoardNode } from "../../miro/miroClient.js";
import type {
  CommitData,
  IterationNode,
  ScreenshotResult,
  ScreenshotTarget,
} from "../../tracker/types.js";

export type CreateDesignSnapshotOptions = {
  annotation?: string;
  repoPath?: string;
  source?: string;
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
  miroNodes: RenderedBoardNode[];
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
    });

    const { results, ancestors, ancestry } = await takeScreenshots(jobs, CAPTURE_URL);
    screenshots = results;

    // Climb-the-DOM ancestor capture: takeScreenshots walked the live container
    // chain above each located component up to the page root, capturing every
    // ancestor container (branch id derived from its DOM identity) plus a
    // full-page `main`. Materialize each as a node on its branch, reusing the
    // branch when it already exists. Branches a level-0 component already noded
    // this commit were skipped during capture, so there is no collision here.
    graph.transaction(() => {
      for (const ancestor of ancestors) {
        const { branchId, outputPath, navPath } = ancestor;

        if (branchId !== MAIN_BRANCH && !graph.branchExists(branchId)) {
          // Provisional parent = main; real nesting is fixed below from geometry.
          const forkNodeId = graph.getBranchTip(MAIN_BRANCH);
          const target = fallbackTarget(branchId);
          graph.ensureBranch(branchId, MAIN_BRANCH, forkNodeId, navPath, target);
        }

        const parentId = graph.getBranchTip(branchId);
        const nodeId = `${commit.hash}:${branchId}`;
        const screenshotPath = path.relative(DESIGNTRAIL_ROOT, outputPath);

        graph.addNode({
          id: nodeId,
          commitHash: commit.hash,
          branchId,
          parentId,
          summary: "Updated to reflect a nested change",
          type: "UI_CHANGE",
          screenshotPath,
          timestamp: commit.timestamp,
        });

        nodeByOutput.set(outputPath, nodeId);
        const branchRecord = graph.getBranch(branchId);
        const entry: DesignSnapshotEntry = {
          branchId,
          parentBranchId: branchRecord?.parentBranchId ?? null,
          parentId,
          type: "UI_CHANGE",
          summary: "Updated to reflect a nested change",
          annotation: null,
          screenshotPath,
        };
        entries.push(entry);
        screenshots.push({ outputPath, geometry: ancestor.geometry });
      }
    });

    // Hash every newly captured screenshot and persist it on its node, so the
    // whole-graph duplicate collapse below can run off stored hashes (steady
    // state only re-reads this commit's new files).
    const newHashes = await Promise.all(
      [...nodeByOutput.entries()].map(async ([outputPath, nodeId]) => ({
        nodeId,
        hash: await hashFile(outputPath),
      }))
    );
    graph.transaction(() => {
      for (const { nodeId, hash } of newHashes) {
        if (hash) graph.setNodeScreenshotHash(nodeId, hash);
      }
    });

    // Phase 1: collapse byte-identical screenshots across the WHOLE graph so each
    // unique image survives exactly once — the destructive db equivalent of the
    // renderer's canonical-survivor map. Replaces the old per-branch-vs-parent
    // dedup (a strict subset). Runs before annotation/geometry so removed
    // captures aren't annotated. Re-points any parentId / forkNodeId that
    // referenced a dropped duplicate onto the surviving node.
    {
      const { branches: allBranches, nodes: allNodes } = graph.exportGraph();
      const storedHashes = graph.getNodeHashes();
      const hashByNodeId = new Map<string, string | null>();
      const backfill: { nodeId: string; hash: string }[] = [];
      for (const node of allNodes) {
        let hash = storedHashes.get(node.id) ?? null;
        if (hash == null) {
          // Legacy node without a stored hash: hash its file once and backfill.
          hash = await hashFile(path.join(DESIGNTRAIL_ROOT, node.screenshotPath));
          if (hash) backfill.push({ nodeId: node.id, hash });
        }
        hashByNodeId.set(node.id, hash);
      }
      if (backfill.length > 0) {
        graph.transaction(() => {
          for (const { nodeId, hash } of backfill) graph.setNodeScreenshotHash(nodeId, hash);
        });
      }

      const collapse = planDuplicateCollapse(allBranches, allNodes, hashByNodeId);
      if (collapse.deletedNodeIds.length > 0) {
        graph.transaction(() => {
          for (const { id, parentId } of collapse.nodeParentUpdates) {
            graph.setNodeParent(id, parentId);
          }
          for (const { id, forkNodeId } of collapse.branchForkUpdates) {
            graph.setBranchForkNode(id, forkNodeId);
          }
          for (const id of collapse.deletedNodeIds) graph.deleteNode(id);
        });

        // Remove the duplicate PNGs from disk. New-this-commit duplicates live at
        // their pre-mirror outputPath; older duplicates at their stored path.
        const outputByNodeId = new Map(
          [...nodeByOutput.entries()].map(([out, id]) => [id, out] as const)
        );
        const nodeById = new Map(allNodes.map((n) => [n.id, n]));
        await Promise.all(
          collapse.deletedNodeIds.map(async (id) => {
            const abs =
              outputByNodeId.get(id) ??
              (nodeById.has(id)
                ? path.join(DESIGNTRAIL_ROOT, nodeById.get(id)!.screenshotPath)
                : undefined);
            if (abs) await fse.remove(abs);
          })
        );

        const deleted = new Set(collapse.deletedNodeIds);
        screenshots = screenshots.filter((s) => {
          const id = nodeByOutput.get(s.outputPath);
          if (id && deleted.has(id)) {
            nodeByOutput.delete(s.outputPath);
            return false;
          }
          return true;
        });
        entries = entries.filter((e) => !deleted.has(`${commit.hash}:${e.branchId}`));
      }
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
    // Parent of each branch: the true DOM containment succession from the climb
    // is authoritative (it captures overflow/equal-rect nesting that bounding-box
    // geometry cannot), and bounding-box containment fills in any branch the
    // climb didn't touch this run.
    const derived = new Map<string, string | null>(
      deriveContainmentParents(branches, nodes)
    );
    for (const [child, parent] of ancestry) derived.set(child, parent);

    // Nodes export in chronological (rowid) order, so each branch's list is
    // oldest-first and the fork node can be picked by timestamp.
    const nodesByBranch = new Map<string, IterationNode[]>();
    for (const node of nodes) {
      const list = nodesByBranch.get(node.branchId) ?? [];
      list.push(node);
      nodesByBranch.set(node.branchId, list);
    }

    // Pick the node on the (new) parent branch this branch forks from: the
    // parent's state when the child first appeared (latest parent node at/just
    // before the child's first node), falling back to the parent's first node.
    // null when there is no parent or the parent has no nodes, in which case no
    // fork edge is drawn. This keeps fork_node_id on the direct parent branch so
    // every stored fork edge crosses exactly one level.
    const reconcileFork = (
      branchId: string,
      parentBranchId: string | null
    ): string | null => {
      if (!parentBranchId) return null;
      const parentNodes = nodesByBranch.get(parentBranchId) ?? [];
      if (parentNodes.length === 0) return null;
      const childFirst = nodesByBranch.get(branchId)?.[0];
      if (!childFirst) return parentNodes[0].id;
      let fork = parentNodes[0];
      for (const candidate of parentNodes) {
        if (candidate.timestamp <= childFirst.timestamp) fork = candidate;
        else break;
      }
      return fork.id;
    };

    graph.transaction(() => {
      for (const [branchId, parentBranchId] of derived) {
        graph.setBranchParent(branchId, parentBranchId);
        graph.setBranchForkNode(branchId, reconcileFork(branchId, parentBranchId));
      }
    });

    // Phase 2: promote away branches left node-less by the duplicate collapse,
    // hoisting their children up — the db equivalent of the renderer's
    // promoteCollapsedBranches. Runs on the reconciled tree so the stored tree
    // equals the drawn tree, before the folder mirror renumbers files.
    {
      const { branches: pBranches, nodes: pNodes } = graph.exportGraph();
      const promotion = planBranchPromotion(pBranches, pNodes);
      if (promotion.deletedBranchIds.length > 0 || promotion.branchUpdates.length > 0) {
        graph.transaction(() => {
          for (const update of promotion.branchUpdates) {
            graph.setBranchParent(update.id, update.parentBranchId);
            graph.setBranchForkNode(update.id, update.forkNodeId);
          }
          for (const id of promotion.deletedBranchIds) graph.deleteBranch(id);
        });
      }
    }

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

  } finally {
    graph.close();
  }

  // Miro rendering is intentionally out-of-band because it wipes and rebuilds
  // the entire board. Run `npm run render-miro -- <repo>` when a board refresh is desired.
  const miroNodes: RenderedBoardNode[] = [];

  return {
    commit,
    repoName,
    repoPath,
    entries,
    screenshots,
    miroNodes,
  };
}
