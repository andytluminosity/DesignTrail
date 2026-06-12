import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { getLatestCommit, getDiff, getRepoName } from "../../tracker/git.js";
import { takeScreenshots, getSiteContext } from "../../tracker/screenshot.js";
import type { ScreenshotJob } from "../../tracker/screenshot.js";
import { analyzeCommit } from "../../tracker/llm.js";
import { annotateScreenshots } from "../../tracker/annotate.js";
import { classifyComponent } from "../../tracker/classify.js";
import { DesignGraph } from "../../tracker/graph.js";
import { MAIN_BRANCH, slug } from "../../tracker/branch.js";
import {
  renderBoardFromGraph,
  type BoardGraph,
  type RenderedBoardNode,
} from "../../miro/miroClient.js";
import { writeMiroItemMap } from "./miroItemMap.js";
import type {
  AnnotationChoice,
  AnnotationChoiceTarget,
  AnnotationColor,
  AnnotationMode,
  AnnotationRecord,
  AnnotationSource,
  CommitData,
  CommitType,
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

// Resolve DesignTrail root so the workflow works no matter which repo invokes it.
const DESIGNTRAIL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

try {
  process.loadEnvFile(path.join(DESIGNTRAIL_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

// Tree 1 node id helpers. A page is identified by its route; a component by its
// DOM-derived branch id; a version by its commit + component.
function pageNodeId(navPath: string): string {
  return `page:${navPath}`;
}
function versionNodeId(commitHash: string, componentId: string): string {
  return `${commitHash}:${componentId}`;
}
/** Filesystem-safe folder segment for a route ("/" -> "root"). */
function navSlug(navPath: string): string {
  return slug(navPath) || "root";
}

// Everything renderBoardFromGraph needs, captured before the DB is closed.
type BoardExport = {
  tree1: BoardGraph;
  tree2: BoardGraph;
  tree3: BoardGraph;
  commits: Map<string, CommitData>;
  annotations: AnnotationRecord[];
};

function exportBoard(graph: DesignGraph): BoardExport {
  return {
    tree1: graph.exportTree1Graph(),
    tree2: graph.exportTree2Graph(),
    tree3: graph.exportTree3Graph(),
    commits: graph.getCommits(),
    annotations: graph.getAnnotations(),
  };
}

async function renderBoard(board: BoardExport): Promise<RenderedBoardNode[]> {
  return renderBoardFromGraph(
    board.tree1,
    board.tree2,
    board.tree3,
    board.commits,
    board.annotations
  );
}

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

/**
 * Rebuilds the annotation entries for an already-captured commit from the stored
 * Tree 1 nodes: the version leaves captured by that commit (plus any page node
 * whose latest capture is that commit). These are the screenshots a re-run of
 * the annotation flow can target.
 */
function buildEntriesForCommit(
  graph: DesignGraph,
  commitHash: string
): DesignSnapshotEntry[] {
  const rows = graph.getTree1Nodes();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter(
      (r) => (r.kind === "version" || r.kind === "page") && r.commitHash === commitHash
    )
    .map((r) => {
      const componentId = r.kind === "version" ? r.parentId : null;
      const component = componentId ? byId.get(componentId) : undefined;
      return {
        nodeId: r.id,
        branchId: componentId ?? r.id,
        parentBranchId: component?.parentId ?? null,
        parentId: null,
        type: r.type,
        summary: r.summary,
        annotation: r.annotation ?? null,
        aiAnnotation: r.annotation ?? null,
        manualAnnotation: null,
        screenshotPath: r.screenshotPath,
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
      params.graph.clearTree1NodeAnnotation(target.nodeId);

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

      params.graph.setTree1NodeAnnotation(target.nodeId, annotation);
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

// One component capture pending classification after persistence.
type PendingClassification = {
  componentKey: string;
  label: string;
  screenshotPath: string;
  screenshotAbs: string;
  hash: string | null;
};

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
  const shortHash = commit.hash.slice(0, 8);

  const graph = await DesignGraph.load(repoName);
  let entries: DesignSnapshotEntry[] = [];
  let screenshots: ScreenshotResult[] = [];
  let boardExport: BoardExport | null = null;

  try {
    // Read the live DOM (across pages) first so the LLM targets elements that
    // actually exist.
    const siteContext = await getSiteContext(CAPTURE_URL);
    const { components } = await analyzeCommit({
      diff: commit.diff,
      commitMessage: commit.message,
      siteContext,
    });

    graph.transaction(() => graph.upsertCommit(commit));

    // Split the detected changes into component captures (targeted) and the
    // routes that need a full-page capture. Every route touched by any change
    // gets exactly ONE full-page capture (the page node + commit overview), and
    // each targeted change gets its own container capture. No DOM climbing.
    type CompSpec = {
      jobId: string;
      summary: string;
      type: CommitType;
      navPath: string;
      target: ScreenshotTarget;
    };
    const compSpecs: CompSpec[] = [];
    const routeSummary = new Map<string, { summary: string; type: CommitType }>();
    const explicitFullRoutes = new Set<string>();

    components.forEach((change, index) => {
      const navPath = change.path ?? "/";
      if (change.screenshotTarget.mode === "full") {
        explicitFullRoutes.add(navPath);
        routeSummary.set(navPath, { summary: change.summary, type: change.type });
      } else {
        compSpecs.push({
          jobId: `c${index}`,
          summary: change.summary,
          type: change.type,
          navPath,
          target: change.screenshotTarget,
        });
        if (!routeSummary.has(navPath)) {
          routeSummary.set(navPath, { summary: "Page updated", type: change.type });
        }
      }
    });

    const jobs: ScreenshotJob[] = [];

    // Page jobs (one per route) write directly to their final per-commit path.
    type PageSpec = { jobId: string; navPath: string; summary: string; type: CommitType };
    const pageSpecById = new Map<string, PageSpec>();
    let routeIndex = 0;
    for (const [navPath, info] of routeSummary) {
      const jobId = `p${routeIndex++}`;
      const rel = path.join(
        "captures",
        repoName,
        "pages",
        navSlug(navPath),
        `${shortHash}.png`
      );
      jobs.push({
        jobId,
        outputPath: path.join(DESIGNTRAIL_ROOT, rel),
        target: { mode: "full" },
        navPath,
      });
      pageSpecById.set(jobId, { jobId, navPath, summary: info.summary, type: info.type });
    }

    // Component jobs write to a temp commit dir; they move to their final
    // component folder after the DOM key is known.
    const compSpecById = new Map(compSpecs.map((spec) => [spec.jobId, spec]));
    for (const spec of compSpecs) {
      const rel = path.join("captures", repoName, commit.hash, `__${spec.jobId}.png`);
      jobs.push({
        jobId: spec.jobId,
        outputPath: path.join(DESIGNTRAIL_ROOT, rel),
        target: spec.target,
        navPath: spec.navPath,
      });
    }

    // Highlight jobs: one extra full-page capture per route that has targeted
    // changes, outlining each changed container in a red dotted border. The
    // original page capture above is untouched; this variant branches off it in
    // the commit overview tree.
    const routeHighlightTargets = new Map<string, ScreenshotTarget[]>();
    for (const spec of compSpecs) {
      const list = routeHighlightTargets.get(spec.navPath) ?? [];
      list.push(spec.target);
      routeHighlightTargets.set(spec.navPath, list);
    }
    type HighlightSpec = { jobId: string; navPath: string };
    const highlightSpecById = new Map<string, HighlightSpec>();
    let highlightIndex = 0;
    for (const [navPath, targets] of routeHighlightTargets) {
      const jobId = `h${highlightIndex++}`;
      const rel = path.join(
        "captures",
        repoName,
        "pages",
        navSlug(navPath),
        `${shortHash}-highlight.png`
      );
      jobs.push({
        jobId,
        outputPath: path.join(DESIGNTRAIL_ROOT, rel),
        target: { mode: "full" },
        navPath,
        highlightTargets: targets,
      });
      highlightSpecById.set(jobId, { jobId, navPath });
    }

    const { results } = await takeScreenshots(jobs, CAPTURE_URL);
    screenshots = results;

    // --- Pages + commit overview (Tree 1 page nodes + Tree 3) ---------------
    for (const result of results) {
      const spec = result.jobId ? pageSpecById.get(result.jobId) : undefined;
      if (!spec) continue;
      const navPath = result.navPath ?? spec.navPath;
      const rel = path.relative(DESIGNTRAIL_ROOT, result.outputPath);
      const fileHash = await hashFile(result.outputPath);
      const pageId = pageNodeId(navPath);

      graph.transaction(() => {
        graph.upsertTree1Node({
          id: pageId,
          kind: "page",
          parentId: null,
          navPath,
          componentKey: null,
          label: navPath,
          commitHash: commit.hash,
          screenshotPath: rel,
          screenshotHash: fileHash,
          summary: spec.summary,
          type: spec.type,
          timestamp: commit.timestamp,
          geometry: result.geometry,
        });
        graph.upsertCommitScreenshot({
          id: `${commit.hash}:${navPath}`,
          commitHash: commit.hash,
          navPath,
          screenshotPath: rel,
          screenshotHash: fileHash,
          summary: spec.summary,
          timestamp: commit.timestamp,
          pageW: result.geometry?.pageW,
          pageH: result.geometry?.pageH,
        });
      });

      // A page-level (full) change annotates the page node; pages captured only
      // as the backdrop for a component change are not annotation targets.
      if (explicitFullRoutes.has(navPath)) {
        entries.push({
          nodeId: pageId,
          branchId: pageId,
          parentBranchId: null,
          parentId: null,
          type: spec.type,
          summary: spec.summary,
          annotation: null,
          screenshotPath: rel,
        });
      }
    }

    // --- Highlighted commit-overview variants (Tree 3 child nodes) -----------
    // Attach each highlight capture to its already-upserted commit-overview row.
    // A capture that outlined nothing is discarded so we never branch an
    // unhighlighted duplicate of the original.
    for (const result of results) {
      const spec = result.jobId ? highlightSpecById.get(result.jobId) : undefined;
      if (!spec) continue;
      const navPath = result.navPath ?? spec.navPath;
      if (!result.highlightCount) {
        await fse.remove(result.outputPath).catch(() => undefined);
        continue;
      }
      const rel = path.relative(DESIGNTRAIL_ROOT, result.outputPath);
      const fileHash = await hashFile(result.outputPath);
      graph.transaction(() =>
        graph.setCommitScreenshotHighlight(`${commit.hash}:${navPath}`, rel, fileHash)
      );
    }

    // --- Components + versions (Tree 1) + classifications (Tree 2) -----------
    const pendingClassifications: PendingClassification[] = [];
    for (const result of results) {
      const spec = result.jobId ? compSpecById.get(result.jobId) : undefined;
      if (!spec) continue;

      const componentKey = result.componentKey;
      const componentId = result.branchId;
      // A locate failure falls back to a full page (branchId "main", no key); the
      // route's page job already covered that, so drop the redundant capture.
      if (!componentKey || !componentId || componentId === MAIN_BRANCH) {
        await fse.remove(result.outputPath).catch(() => undefined);
        continue;
      }

      const navPath = result.navPath ?? spec.navPath;
      const fileHash = await hashFile(result.outputPath);

      // Byte-identical to the component's latest version => no new version.
      const latestHash = graph.getLatestVersionHash(componentId);
      if (fileHash && latestHash && fileHash === latestHash) {
        await fse.remove(result.outputPath).catch(() => undefined);
        continue;
      }

      const finalRel = path.join(
        "captures",
        repoName,
        "components",
        componentId,
        `${shortHash}.png`
      );
      const finalAbs = path.join(DESIGNTRAIL_ROOT, finalRel);
      await fse.ensureDir(path.dirname(finalAbs));
      await fse.move(result.outputPath, finalAbs, { overwrite: true });

      const pageId = pageNodeId(navPath);
      const versionId = versionNodeId(commit.hash, componentId);
      const label = result.label ?? componentId;

      graph.transaction(() => {
        graph.upsertTree1Node({
          id: componentId,
          kind: "component",
          parentId: pageId,
          navPath,
          componentKey,
          label,
          commitHash: commit.hash,
          screenshotPath: finalRel,
          screenshotHash: fileHash,
          summary: spec.summary,
          type: spec.type,
          timestamp: commit.timestamp,
          geometry: result.geometry,
        });
        graph.upsertTree1Node({
          id: versionId,
          kind: "version",
          parentId: componentId,
          navPath,
          componentKey,
          label,
          commitHash: commit.hash,
          screenshotPath: finalRel,
          screenshotHash: fileHash,
          summary: spec.summary,
          type: spec.type,
          timestamp: commit.timestamp,
          geometry: result.geometry,
        });
      });

      entries.push({
        nodeId: versionId,
        branchId: componentId,
        parentBranchId: pageId,
        parentId: null,
        type: spec.type,
        summary: spec.summary,
        annotation: null,
        screenshotPath: finalRel,
      });

      pendingClassifications.push({
        componentKey,
        label,
        screenshotPath: finalRel,
        screenshotAbs: finalAbs,
        hash: fileHash,
      });
    }

    // Tree 2 classification: classify a component the first time it is seen and
    // persist it; otherwise reuse the stored group and just refresh its latest
    // screenshot. Runs sequentially so freshly-added groups are reused.
    for (const pending of pendingClassifications) {
      const existing = graph.getClassification(pending.componentKey);
      if (existing) {
        graph.transaction(() =>
          graph.setClassificationScreenshot(
            pending.componentKey,
            pending.screenshotPath,
            pending.hash
          )
        );
        continue;
      }
      const { groupName } = await classifyComponent({
        screenshotPath: pending.screenshotAbs,
        label: pending.label,
        existingGroups: graph.getClassificationGroups(),
      });
      graph.transaction(() =>
        graph.upsertClassification({
          componentKey: pending.componentKey,
          groupName,
          label: pending.label,
          screenshotPath: pending.screenshotPath,
          screenshotHash: pending.hash,
          classifiedAt: Date.now(),
        })
      );
    }

    // Clean up the temp commit dir (component temp files were moved/removed).
    await fse
      .remove(path.join(DESIGNTRAIL_ROOT, "captures", repoName, commit.hash))
      .catch(() => undefined);

    const appliedAnnotations = await applyAnnotationChoicesToGraph({
      graph,
      commit,
      targets: buildAnnotationTargets(entries),
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

    boardExport = exportBoard(graph);
  } finally {
    graph.close();
  }

  const miroNodes: RenderedBoardNode[] =
    options?.syncMiro === false || !boardExport ? [] : await renderBoard(boardExport);

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
  let boardExport: BoardExport | null = null;

  try {
    const capturedCommit = graph.getCommits().get(commitHash);
    if (!capturedCommit) {
      throw new Error(`No captured DesignTrail commit found for ${commitHash}`);
    }
    commit = capturedCommit;

    entries = buildEntriesForCommit(graph, commitHash);

    const appliedAnnotations = await applyAnnotationChoicesToGraph({
      graph,
      commit,
      targets: buildAnnotationTargets(entries),
      choices: options.annotationChoices,
      defaultMode: "skip",
    });
    applyAnnotationsToEntries(entries, appliedAnnotations);

    boardExport = exportBoard(graph);
  } finally {
    graph.close();
  }

  const miroNodes =
    options.syncMiro === false || !boardExport ? [] : await renderBoard(boardExport);

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

  let boardExport: BoardExport;
  try {
    boardExport = exportBoard(graph);
  } finally {
    graph.close();
  }

  const miroNodes = await renderBoard(boardExport);
  await writeMiroItemMap({ repoName, repoPath, miroNodes });
  return miroNodes;
}
