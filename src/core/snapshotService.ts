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
import { contains, deriveContainmentParents, geometryByBranch } from "../../tracker/layout.js";
import { planFolderLayout } from "../../tracker/treeStore.js";
import { planDuplicateCollapse, planBranchPromotion } from "../../tracker/prune.js";
import { MAIN_BRANCH } from "../../tracker/branch.js";
import { renderBoardFromGraph, type RenderedBoardNode } from "../../miro/miroClient.js";
import { writeMiroItemMap } from "./miroItemMap.js";
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

export type RenderDesignSnapshotBoardOptions = {
  repoPath?: string;
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
 * The clean (unboxed) sidecar for a full-page `main` capture. The DOM climb
 * writes `main.png` (with the change-highlight box) and a `main-original.png`
 * copy without it; the sidecar must follow `main.png` whenever it moves or is
 * removed so the commit-overview tree can still find it by name convention.
 */
function originalSidecarPath(pngPath: string): string {
  return pngPath.replace(/\.png$/i, "-original.png");
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
      // Keep the clean main sidecar adjacent to its boxed counterpart.
      const sidecarFrom = originalSidecarPath(from);
      if (await fse.pathExists(sidecarFrom)) {
        await fse.move(sidecarFrom, originalSidecarPath(to), { overwrite: true });
      }
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

    // Build one capture job per detected change. Container identity (which
    // screenshots group together) is now derived from the LIVE DOM at capture
    // time — a stable, instance-unique container key — NOT from the LLM. So we
    // do NOT create component branches/nodes here; that happens after capture,
    // keyed by the real DOM container. `main` is ensured up front so cascading
    // updates can always reach the root.
    type JobSpec = {
      summary: string;
      type: IterationNode["type"];
      navPath: string;
      target: ScreenshotTarget;
    };
    const jobSpecById = new Map<string, JobSpec>();

    graph.transaction(() => {
      graph.upsertCommit(commit);
      graph.ensureBranch(MAIN_BRANCH, null, null, "/", { mode: "full" });
    });

    components.forEach((change, index) => {
      const navPath = change.path ?? "/";
      const isFull = change.screenshotTarget.mode === "full";
      const jobId = `c${index}`;
      // A full/global change has no isolable container, so it lands on `main` and
      // keeps the conventional main.png name (so the clean-sidecar logic applies).
      // A located change writes to a neutral path; its real branch (folder) is
      // assigned after the DOM key is known, and the folder mirror renames it.
      const fileName = isFull ? `${MAIN_BRANCH}.png` : `__${jobId}.png`;
      const screenshotPath = path.join("captures", repoName, commit.hash, fileName);
      const outputPath = path.join(DESIGNTRAIL_ROOT, screenshotPath);
      jobSpecById.set(jobId, {
        summary: change.summary,
        type: change.type,
        navPath,
        target: change.screenshotTarget,
      });
      jobs.push({ jobId, outputPath, target: change.screenshotTarget, navPath });
    });

    const { results, ancestors, ancestry } = await takeScreenshots(jobs, CAPTURE_URL);
    screenshots = results;

    // Create/reuse each captured component's branch from its DOM container key.
    // Grouping is deterministic and DOM-driven: two sibling cards that share a
    // class get distinct keys (so distinct branches), and the SAME container
    // reuses its branch across commits because the key is deterministic.
    graph.transaction(() => {
      for (const result of results) {
        const spec = result.jobId ? jobSpecById.get(result.jobId) : undefined;
        if (!spec) continue;
        const branchId = result.branchId ?? MAIN_BRANCH;
        const navPath = result.navPath ?? spec.navPath;

        if (branchId !== MAIN_BRANCH) {
          if (!graph.branchExists(branchId)) {
            // Provisional parent = main; real nesting is fixed below from the DOM
            // containment chain.
            const forkNodeId = graph.getBranchTip(MAIN_BRANCH);
            graph.ensureBranch(branchId, MAIN_BRANCH, forkNodeId, navPath, spec.target);
          } else {
            graph.setBranchCapture(branchId, navPath, spec.target);
          }
        }

        const parentId = graph.getBranchTip(branchId);
        const nodeId = `${commit.hash}:${branchId}`;
        const screenshotPath = path.relative(DESIGNTRAIL_ROOT, result.outputPath);

        graph.addNode({
          id: nodeId,
          commitHash: commit.hash,
          branchId,
          parentId,
          summary: spec.summary,
          type: spec.type,
          screenshotPath,
          timestamp: commit.timestamp,
        });

        nodeByOutput.set(result.outputPath, nodeId);
        const branchRecord = graph.getBranch(branchId);
        entries.push({
          nodeId,
          branchId,
          parentBranchId: branchRecord?.parentBranchId ?? null,
          parentId,
          type: spec.type,
          summary: spec.summary,
          annotation: null,
          screenshotPath,
        });
      }
    });

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
          // Provisional parent = main; real nesting is fixed below from the DOM
          // containment chain. Re-capture target = the container's own (valid
          // CSS) selector from the DOM-key walk, falling back to a class guess.
          const forkNodeId = graph.getBranchTip(MAIN_BRANCH);
          const target: ScreenshotTarget = ancestor.selector
            ? { mode: "selector", value: ancestor.selector }
            : fallbackTarget(branchId);
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
            if (abs) {
              await fse.remove(abs);
              // Drop the clean main sidecar too, so no orphan is left behind.
              await fse.remove(originalSidecarPath(abs));
            }
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
    // The DOM climb is authoritative for nesting, but only apply an ancestry edge
    // when geometry actually confirms the climbed parent encloses the child (or
    // the parent is `main`, the universal root, or geometry is unknown so we
    // can't disprove it). This guards against an overflow/clipped ancestor whose
    // measured box is smaller than its child being forced in as the parent,
    // keeping the invariant that a child is always a smaller, contained box.
    const branchGeometry = geometryByBranch(branches, nodes);
    for (const [child, parent] of ancestry) {
      const childGeom = branchGeometry.get(child);
      const parentGeom = branchGeometry.get(parent);
      if (parent === MAIN_BRANCH || !childGeom || !parentGeom || contains(parentGeom, childGeom)) {
        derived.set(child, parent);
      }
    }

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

  await writeMiroItemMap({ repoName, repoPath, miroNodes });

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

  await writeMiroItemMap({ repoName, repoPath, miroNodes });

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

export async function renderDesignSnapshotBoard(
  options: RenderDesignSnapshotBoardOptions = {}
): Promise<RenderedBoardNode[]> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const repoName = await getRepoName(repoPath);
  const graph = await DesignGraph.load(repoName);

  let boardExport: {
    branches: BranchRecord[];
    nodes: IterationNode[];
    commits: Map<string, CommitData>;
    annotations: AnnotationRecord[];
  };

  try {
    const graphSnapshot = graph.exportGraph();
    boardExport = {
      branches: graphSnapshot.branches,
      nodes: graphSnapshot.nodes,
      commits: graph.getCommits(),
      annotations: graphSnapshot.annotations,
    };
  } finally {
    graph.close();
  }

  const miroNodes = await renderBoardFromGraph(
    boardExport.branches,
    boardExport.nodes,
    boardExport.commits,
    boardExport.annotations
  );

  await writeMiroItemMap({ repoName, repoPath, miroNodes });

  return miroNodes;
}
