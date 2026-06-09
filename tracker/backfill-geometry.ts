import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { DesignGraph } from "./graph.js";
import { takeScreenshots } from "./screenshot.js";
import type { ScreenshotJob } from "./screenshot.js";
import { MAIN_BRANCH } from "./branch.js";
import type { IterationNode, ScreenshotTarget } from "./types.js";

// One-off backfill for nodes captured before geometry tracking existed. For each
// branch's latest node lacking geometry, re-locates its component via the stored
// nav_path + target, reads the located element's on-screen rect, and records it.
// The throwaway screenshots go to a temp dir, so existing captures are untouched.

const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(TRACKER_ROOT, "data");

try {
  process.loadEnvFile(path.join(TRACKER_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

/** Mirrors capture.ts: how to re-screenshot a branch with no stored capture spec. */
function fallbackTarget(branchId: string): ScreenshotTarget {
  if (branchId === MAIN_BRANCH) return { mode: "full" };
  return { mode: "selector", value: `[class~="${branchId}"]` };
}

async function backfillRepo(repo: string): Promise<void> {
  const graph = await DesignGraph.load(repo);
  try {
    const { branches, nodes } = graph.exportGraph();

    // Nodes export in chronological order, so the last seen per branch is its tip.
    const latest = new Map<string, IterationNode>();
    for (const n of nodes) latest.set(n.branchId, n);

    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "designtrail-geom-"));
    const jobs: ScreenshotJob[] = [];
    const nodeByOutput = new Map<string, string>();

    for (const b of branches) {
      const node = latest.get(b.id);
      if (!node || node.geometry) continue; // skip empty or already-measured branches
      const target = b.target ?? fallbackTarget(b.id);
      const navPath = b.navPath ?? "/";
      const outputPath = path.join(tmpDir, `${b.id}.png`);
      nodeByOutput.set(outputPath, node.id);
      jobs.push({ outputPath, target, navPath });
    }

    if (jobs.length === 0) {
      console.log(`${repo}: geometry already present, nothing to backfill.`);
      return;
    }

    const results = await takeScreenshots(jobs, CAPTURE_URL);

    let updated = 0;
    graph.transaction(() => {
      for (const { outputPath, geometry } of results) {
        if (!geometry) continue;
        const nodeId = nodeByOutput.get(outputPath);
        if (nodeId) {
          graph.setNodeGeometry(nodeId, geometry);
          updated++;
        }
      }
    });

    await fse.remove(tmpDir);
    console.log(`${repo}: backfilled geometry for ${updated}/${jobs.length} branch tip(s).`);
  } finally {
    graph.close();
  }
}

async function discoverRepos(): Promise<string[]> {
  if (!(await fse.pathExists(DATA_DIR))) return [];
  const entries = await fse.readdir(DATA_DIR, { withFileTypes: true });
  const repos: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await fse.pathExists(path.join(DATA_DIR, entry.name, "graph.db")))) {
      repos.push(entry.name);
    }
  }
  return repos;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repos = args.length > 0 ? args : await discoverRepos();

  if (repos.length === 0) {
    console.log("No tracked repos found in /data. Pass a repo name (npm run backfill-geometry -- <repo>).");
    return;
  }

  for (const repo of repos) {
    try {
      await backfillRepo(repo);
    } catch (err) {
      console.error(
        `Failed to backfill ${repo}:`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
