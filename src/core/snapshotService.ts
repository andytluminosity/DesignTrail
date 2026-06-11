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
import { renderBoardFromGraph, type RenderedBoardNode } from "../../miro/miroClient.js";
import type {
  AnnotationChoice,
  AnnotationChoiceTarget,
  AnnotationColor,
  AnnotationMode,
  AnnotationRecord,
  AnnotationSource,
  BranchRecord,
  CommitData,
  IterationNode,
  ScreenshotResult,
  ScreenshotTarget,
} from "../../tracker/types.js";

export type CreateDesignSnapshotOptions = {
  annotationChoices?: AnnotationChoice[];
  defaultAnnotationMode?: AnnotationMode;
  resolveAnnotationChoices?: (
    targets: AnnotationChoiceTarget[]
  ) => Promise<AnnotationChoice[]>;
  /** @deprecated Use per-screenshot annotationChoices instead. */
  annotation?: string;
  /** @deprecated Use per-screenshot annotationChoices instead. */
  generateAiAnnotations?: boolean;
  repoPath?: string;
  source?: string;
  syncMiro?: boolean;
};

export type DesignSnapshotEntry = {
  nodeId: string;
  branchId: string;
  parentBranchId: string | null;
  parentId: string | null;
  type: string;
  summary: string;
  annotation: string | null;
  annotationMode?: AnnotationMode;
  manualAnnotation?: string | null;
  aiAnnotation?: string | null;
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

export type ApplyDesignSnapshotAnnotationsOptions = {
  annotationChoices: AnnotationChoice[];
  commitHash?: string;
  repoPath?: string;
  syncMiro?: boolean;
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

function annotationColorForSource(source: AnnotationSource): AnnotationColor | undefined {
  if (source === "ai") return "yellow";
  if (source === "user") return "blue";
  return undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildAnnotationRecord(
  nodeId: string,
  commitHash: string,
  source: AnnotationSource,
  content: string,
  createdAt: number
): AnnotationRecord {
  return {
    id: `${nodeId}:${source}`,
    nodeId,
    commitHash,
    source,
    content,
    color: annotationColorForSource(source),
    createdAt,
  };
}

type ResolvedAnnotationChoice = {
  mode: AnnotationMode;
  annotation?: string;
};

type AppliedAnnotation = {
  mode: AnnotationMode;
  manualAnnotation?: string;
  aiAnnotation?: string;
};

function wantsManualAnnotation(mode: AnnotationMode): boolean {
  return mode === "manual" || mode === "manual_and_ai";
}

function wantsAiAnnotation(mode: AnnotationMode): boolean {
  return mode === "ai" || mode === "manual_and_ai";
}

function choiceMatchesTarget(
  choice: AnnotationChoice,
  target: AnnotationChoiceTarget
): boolean {
  return (
    choice.nodeId === target.nodeId ||
    choice.branchId === target.branchId ||
    choice.screenshotPath === target.screenshotPath
  );
}

function resolveDefaultAnnotationMode(params: {
  defaultAnnotationMode?: AnnotationMode;
  legacyAnnotation?: string;
  legacyGenerateAiAnnotations?: boolean;
}): AnnotationMode {
  if (params.defaultAnnotationMode) return params.defaultAnnotationMode;

  if (params.legacyAnnotation) {
    return params.legacyGenerateAiAnnotations ? "manual_and_ai" : "manual";
  }

  return params.legacyGenerateAiAnnotations === false ? "skip" : "ai";
}

async function resolveAnnotationChoices(params: {
  targets: AnnotationChoiceTarget[];
  choices?: AnnotationChoice[];
  resolver?: (targets: AnnotationChoiceTarget[]) => Promise<AnnotationChoice[]>;
  defaultMode: AnnotationMode;
  legacyAnnotation?: string;
}): Promise<Map<string, ResolvedAnnotationChoice>> {
  const choices =
    params.choices ?? (params.resolver ? await params.resolver(params.targets) : []);
  const resolved = new Map<string, ResolvedAnnotationChoice>();

  for (const target of params.targets) {
    const choice = choices.find((candidate) => choiceMatchesTarget(candidate, target));
    const mode = choice?.mode ?? params.defaultMode;
    const annotation = normalizeOptional(
      choice?.annotation ??
        (wantsManualAnnotation(mode) ? params.legacyAnnotation : undefined)
    );
    resolved.set(target.nodeId, { mode, annotation });
  }

  return resolved;
}

function buildAnnotationTargets(entries: DesignSnapshotEntry[]): AnnotationChoiceTarget[] {
  return entries.map((entry) => ({
    nodeId: entry.nodeId,
    commitHash: entry.nodeId.split(":")[0] ?? "",
    branchId: entry.branchId,
    summary: entry.summary,
    type: entry.type,
    screenshotPath: entry.screenshotPath,
  }));
}

function buildEntriesForCommit(params: {
  branches: BranchRecord[];
  nodes: IterationNode[];
  commitHash: string;
}): DesignSnapshotEntry[] {
  const branchById = new Map(params.branches.map((branch) => [branch.id, branch]));
  return params.nodes
    .filter((node) => node.commitHash === params.commitHash)
    .map((node) => {
      const branch = branchById.get(node.branchId);
      return {
        nodeId: node.id,
        branchId: node.branchId,
        parentBranchId: branch?.parentBranchId ?? null,
        parentId: node.parentId,
        type: node.type,
        summary: node.summary,
        annotation: node.annotation ?? null,
        aiAnnotation: node.annotation ?? null,
        manualAnnotation: null,
        screenshotPath: node.screenshotPath,
      };
    });
}

function applyAnnotationsToEntries(
  entries: DesignSnapshotEntry[],
  applied: Map<string, AppliedAnnotation>
): void {
  for (const entry of entries) {
    const annotation = applied.get(entry.nodeId);
    entry.annotationMode = annotation?.mode ?? "skip";
    entry.manualAnnotation = annotation?.manualAnnotation ?? null;
    entry.aiAnnotation = annotation?.aiAnnotation ?? null;
    entry.annotation =
      annotation?.manualAnnotation ?? annotation?.aiAnnotation ?? null;
  }
}

async function applyAnnotationChoicesToGraph(params: {
  graph: DesignGraph;
  commit: CommitData;
  targets: AnnotationChoiceTarget[];
  choices?: AnnotationChoice[];
  resolver?: (targets: AnnotationChoiceTarget[]) => Promise<AnnotationChoice[]>;
  defaultMode: AnnotationMode;
  legacyAnnotation?: string;
}): Promise<Map<string, AppliedAnnotation>> {
  const resolved = await resolveAnnotationChoices({
    targets: params.targets,
    choices: params.choices,
    resolver: params.resolver,
    defaultMode: params.defaultMode,
    legacyAnnotation: params.legacyAnnotation,
  });
  const applied = new Map<string, AppliedAnnotation>();

  params.graph.transaction(() => {
    for (const target of params.targets) {
      const choice = resolved.get(target.nodeId) ?? { mode: params.defaultMode };
      const manualAnnotation =
        wantsManualAnnotation(choice.mode) && choice.annotation
          ? choice.annotation
          : undefined;

      params.graph.deleteAnnotation(target.nodeId, "user");
      params.graph.deleteAnnotation(target.nodeId, "ai");
      params.graph.clearNodeAnnotation(target.nodeId);

      const commitMessage = normalizeOptional(params.commit.message);
      if (commitMessage) {
        params.graph.upsertAnnotation(
          buildAnnotationRecord(
            target.nodeId,
            params.commit.hash,
            "commit_message",
            commitMessage,
            params.commit.timestamp
          )
        );
      }

      if (manualAnnotation) {
        params.graph.upsertAnnotation(
          buildAnnotationRecord(
            target.nodeId,
            params.commit.hash,
            "user",
            manualAnnotation,
            Date.now()
          )
        );
      }

      applied.set(target.nodeId, {
        mode: choice.mode,
        manualAnnotation,
      });
    }
  });

  const aiInputs = params.targets
    .filter((target) => wantsAiAnnotation(resolved.get(target.nodeId)?.mode ?? "skip"))
    .map((target) => ({
      outputPath: path.join(DESIGNTRAIL_ROOT, target.screenshotPath),
      branchId: target.branchId,
      summary: target.summary,
      type: target.type,
      commitMessage: params.commit.message,
      diff: params.commit.diff,
    }));

  const aiAnnotations = await annotateScreenshots(aiInputs);
  params.graph.transaction(() => {
    for (const { outputPath, annotation } of aiAnnotations) {
      const target = params.targets.find(
        (candidate) =>
          path.join(DESIGNTRAIL_ROOT, candidate.screenshotPath) === outputPath
      );
      if (!target) continue;

      params.graph.setNodeAnnotation(target.nodeId, annotation);
      const normalizedAnnotation = normalizeOptional(annotation);
      if (normalizedAnnotation) {
        params.graph.upsertAnnotation(
          buildAnnotationRecord(
            target.nodeId,
            params.commit.hash,
            "ai",
            normalizedAnnotation,
            Date.now()
          )
        );
      }

      const existing = applied.get(target.nodeId) ?? { mode: "ai" };
      applied.set(target.nodeId, {
        ...existing,
        aiAnnotation: normalizedAnnotation,
      });
    }
  });

  return applied;
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
  const manualAnnotation = normalizeOptional(options?.annotation);
  const generateAiAnnotations = options?.generateAiAnnotations ?? !manualAnnotation;
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
    annotation: manualAnnotation,
  };

  const graph = await DesignGraph.load(repoName);
  const jobs: ScreenshotJob[] = [];
  let entries: DesignSnapshotEntry[] = [];
  const nodeByOutput = new Map<string, string>();
  let screenshots: ScreenshotResult[] = [];
  let boardExport: {
    branches: BranchRecord[];
    nodes: IterationNode[];
    commits: Map<string, CommitData>;
    annotations: AnnotationRecord[];
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
          nodeId: `${commit.hash}:${branchId}`,
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
          nodeId,
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
      entries = entries.filter((e) => !removedNodeIds.has(e.nodeId));
    }

    const annotationTargets = buildAnnotationTargets(entries);
    const appliedAnnotations = await applyAnnotationChoicesToGraph({
      graph,
      commit,
      targets: annotationTargets,
      choices: options?.annotationChoices,
      resolver: options?.resolveAnnotationChoices,
      defaultMode: resolveDefaultAnnotationMode({
        defaultAnnotationMode: options?.defaultAnnotationMode,
        legacyAnnotation: manualAnnotation,
        legacyGenerateAiAnnotations: generateAiAnnotations,
      }),
      legacyAnnotation: manualAnnotation,
    });
    applyAnnotationsToEntries(entries, appliedAnnotations);

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

    const finalGraph = graph.exportGraph();
    boardExport = {
      branches: finalGraph.branches,
      nodes: finalGraph.nodes,
      commits: graph.getCommits(),
      annotations: finalGraph.annotations,
    };
  } finally {
    graph.close();
  }

  const miroNodes: RenderedBoardNode[] =
    options?.syncMiro === false || !boardExport
      ? []
      : await renderBoardFromGraph(
          boardExport.branches,
          boardExport.nodes,
          boardExport.commits,
          boardExport.annotations
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

export async function applyDesignSnapshotAnnotations(
  options: ApplyDesignSnapshotAnnotationsOptions
): Promise<DesignSnapshotResult> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const repoName = await getRepoName(repoPath);
  const commitHash = options.commitHash ?? (await getLatestCommit(repoPath)).hash;
  const graph = await DesignGraph.load(repoName);

  let commit: CommitData;
  let entries: DesignSnapshotEntry[] = [];
  let boardExport: {
    branches: BranchRecord[];
    nodes: IterationNode[];
    commits: Map<string, CommitData>;
    annotations: AnnotationRecord[];
  } | null = null;

  try {
    const capturedCommit = graph.getCommits().get(commitHash);
    if (!capturedCommit) {
      throw new Error(`No captured DesignTrail commit found for ${commitHash}`);
    }
    commit = capturedCommit;

    const graphSnapshot = graph.exportGraph();
    entries = buildEntriesForCommit({
      branches: graphSnapshot.branches,
      nodes: graphSnapshot.nodes,
      commitHash,
    });

    const appliedAnnotations = await applyAnnotationChoicesToGraph({
      graph,
      commit,
      targets: buildAnnotationTargets(entries),
      choices: options.annotationChoices,
      defaultMode: "skip",
    });
    applyAnnotationsToEntries(entries, appliedAnnotations);

    const finalGraph = graph.exportGraph();
    boardExport = {
      branches: finalGraph.branches,
      nodes: finalGraph.nodes,
      commits: graph.getCommits(),
      annotations: finalGraph.annotations,
    };
  } finally {
    graph.close();
  }

  const miroNodes =
    options.syncMiro === false || !boardExport
      ? []
      : await renderBoardFromGraph(
          boardExport.branches,
          boardExport.nodes,
          boardExport.commits,
          boardExport.annotations
        );

  return {
    commit,
    repoName,
    repoPath,
    entries,
    screenshots: entries.map((entry) => ({
      outputPath: path.join(DESIGNTRAIL_ROOT, entry.screenshotPath),
    })),
    miroNodes,
  };
}
