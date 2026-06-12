import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { DesignGraph } from "./graph.js";
import { renderBoardFromGraph } from "../miro/miroClient.js";

const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(TRACKER_ROOT, "data");

function repoNameFromArg(arg: string): string {
  return path.basename(path.resolve(arg));
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

async function renderRepo(repo: string): Promise<void> {
  const dbPath = path.join(DATA_DIR, repo, "graph.db");
  if (!(await fse.pathExists(dbPath))) {
    throw new Error(`No DesignTrail graph found for "${repo}" at ${dbPath}`);
  }

  const graph = await DesignGraph.load(repo);
  try {
    const rendered = await renderBoardFromGraph(
      graph.exportTree1Graph(),
      graph.exportTree2Graph(),
      graph.exportTree3Graph(),
      graph.getCommits(),
      graph.getAnnotations()
    );
    console.log(`${repo}: rendered ${rendered.length} screenshot(s) to Miro.`);
  } finally {
    graph.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).map(repoNameFromArg);
  const repos = args.length > 0 ? args : await discoverRepos();

  if (repos.length === 0) {
    console.log("No tracked repos found in /data. Pass a repo name (npm run render-miro -- <repo>).");
    return;
  }

  if (repos.length > 1) {
    console.error(
      "Pass exactly one repo. Rendering wipes the configured Miro board before drawing that repo."
    );
    process.exitCode = 1;
    return;
  }

  try {
    await renderRepo(repos[0]);
  } catch (err) {
    console.error("Miro render failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Miro render failed:", err);
  process.exit(1);
});
