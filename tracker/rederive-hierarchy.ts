import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { DesignGraph } from "./graph.js";
import { takeScreenshots } from "./screenshot.js";
import type { ScreenshotJob } from "./screenshot.js";
import { MAIN_BRANCH } from "./branch.js";
import type { IterationNode } from "./types.js";

// One-off repair for branch hierarchies derived before the DOM-containment
// succession was authoritative. Older runs set each branch's parent purely from
// screenshot bounding-box geometry, which cannot express overflow or equal-rect
// nesting, so real DOM ancestors ended up on the SAME tree level as their
// descendants (e.g. an app shell beside the page root it wraps). This re-runs
// the live DOM climb from each real component leaf, reads the true containment
// chain, and rewrites parent_branch_id / fork_node_id to match it.
//
// Only branches captured from a real located element (the LLM's component
// targets) are climbed: climbing a climb-created ancestor's fallback selector
// would re-capture one DOM level too high and report a skewed chain. The real
// leaves' climbs already pass through every ancestor, so their chains cover the
// whole tree. Screenshots go to a throwaway temp dir; existing captures are
// untouched.

const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(TRACKER_ROOT, "data");

// Must match the summary snapshotService writes for climb-created ancestor
// nodes, so we can tell a real component branch from a pure climb artifact.
const NESTED_ANCESTOR_SUMMARY = "Updated to reflect a nested change";

try {
  process.loadEnvFile(path.join(TRACKER_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

function nodesByBranch(nodes: IterationNode[]): Map<string, IterationNode[]> {
  const map = new Map<string, IterationNode[]>();
  for (const n of nodes) {
    const list = map.get(n.branchId) ?? [];
    list.push(n);
    map.set(n.branchId, list);
  }
  return map;
}

/**
 * A branch is a "real component" (worth climbing from) when at least one of its
 * nodes carries a genuine change summary rather than the placeholder used for
 * climb-created ancestors. Such branches were captured from a located element,
 * so their climb reports an accurate containment chain.
 */
function isRealComponent(branchNodes: IterationNode[]): boolean {
  return branchNodes.some(
    (n) => n.summary && n.summary !== NESTED_ANCESTOR_SUMMARY
  );
}

async function rederiveRepo(repo: string): Promise<void> {
  const graph = await DesignGraph.load(repo);
  try {
    const { branches, nodes } = graph.exportGraph();
    const grouped = nodesByBranch(nodes);

    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "designtrail-tree-"));
    const jobs: ScreenshotJob[] = [];
    for (const b of branches) {
      if (b.id === MAIN_BRANCH || !b.target) continue;
      const branchNodes = grouped.get(b.id) ?? [];
      if (!isRealComponent(branchNodes)) continue;
      jobs.push({
        jobId: b.id,
        outputPath: path.join(tmpDir, `${b.id}.png`),
        target: b.target,
        navPath: b.navPath ?? "/",
      });
    }

    if (jobs.length === 0) {
      console.log(`${repo}: no real component leaves to climb from; nothing to do.`);
      return;
    }

    const { ancestry } = await takeScreenshots(jobs, CAPTURE_URL);
    await fse.remove(tmpDir);

    if (ancestry.size === 0) {
      console.log(
        `${repo}: climb produced no containment edges (is the dev server at ${CAPTURE_URL} running?).`
      );
      return;
    }

    // Pick the parent-branch node a child forks from: the parent's state when
    // the child first appeared (latest parent node at/just before the child's
    // first node), falling back to the parent's first node. Mirrors
    // snapshotService.reconcileFork so stored fork edges still cross one level.
    const reconcileFork = (
      branchId: string,
      parentBranchId: string | null
    ): string | null => {
      if (!parentBranchId) return null;
      const parentNodes = grouped.get(parentBranchId) ?? [];
      if (parentNodes.length === 0) return null;
      const childFirst = grouped.get(branchId)?.[0];
      if (!childFirst) return parentNodes[0].id;
      let fork = parentNodes[0];
      for (const candidate of parentNodes) {
        if (candidate.timestamp <= childFirst.timestamp) fork = candidate;
        else break;
      }
      return fork.id;
    };

    let updated = 0;
    graph.transaction(() => {
      for (const [child, parent] of ancestry) {
        if (child === MAIN_BRANCH) continue;
        graph.setBranchParent(child, parent);
        graph.setBranchForkNode(child, reconcileFork(child, parent));
        updated += 1;
      }
    });

    console.log(
      `${repo}: rewrote hierarchy for ${updated} branch(es) from the live DOM containment chain.`
    );
    for (const [child, parent] of ancestry) {
      if (child === MAIN_BRANCH) continue;
      console.log(`  ${child} -> ${parent}`);
    }
  } finally {
    graph.close();
  }
}

async function discoverRepos(): Promise<string[]> {
  if (!(await fse.pathExists(DATA_DIR))) return [];
  const entries = await fse.readdir(DATA_DIR, { withFileTypes: true });
  const repos: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await fse.pathExists(path.join(DATA_DIR, entry.name, "graph.db")))
    ) {
      repos.push(entry.name);
    }
  }
  return repos;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repos = args.length > 0 ? args : await discoverRepos();

  if (repos.length === 0) {
    console.log(
      "No tracked repos found in /data. Pass a repo name (npm run rederive-hierarchy -- <repo>)."
    );
    return;
  }

  for (const repo of repos) {
    try {
      await rederiveRepo(repo);
    } catch (err) {
      console.error(
        `Failed to rederive ${repo}:`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Rederive hierarchy failed:", err);
  process.exit(1);
});
