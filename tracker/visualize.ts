import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { DesignGraph } from "./graph.js";
import type { BranchRecord, IterationNode } from "./types.js";

// DesignTrail root (parent of this tracker/ dir), where /data and /captures live.
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(TRACKER_ROOT, "data");

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortHash(hash: string): string {
  return hash.length > 7 ? hash.slice(0, 7) : hash;
}

/** Renders one iteration node (a component change) as a card with its screenshot. */
function renderNode(node: IterationNode, htmlDir: string): string {
  const absShot = path.join(TRACKER_ROOT, node.screenshotPath);
  const exists = fse.pathExistsSync(absShot);
  const rel = path.relative(htmlDir, absShot);
  const img = exists
    ? `<a href="${escapeHtml(rel)}" target="_blank" rel="noopener">
         <img class="shot" src="${escapeHtml(rel)}" alt="${escapeHtml(node.summary)}" loading="lazy" />
       </a>`
    : `<div class="shot missing">no screenshot</div>`;

  return `
    <div class="node">
      ${img}
      <div class="node-meta">
        <span class="badge type-${escapeHtml(node.type)}">${escapeHtml(node.type)}</span>
        <code class="hash">${escapeHtml(shortHash(node.commitHash))}</code>
      </div>
      <div class="summary">${escapeHtml(node.summary)}</div>
    </div>`;
}

/** Recursively renders a branch and its child branches as nested cards. */
function renderBranch(
  branch: BranchRecord,
  childrenOf: Map<string, BranchRecord[]>,
  nodesByBranch: Map<string, IterationNode[]>,
  htmlDir: string
): string {
  const nodes = nodesByBranch.get(branch.id) ?? [];
  const nodesHtml = nodes.length
    ? `<div class="nodes">${nodes.map((n) => renderNode(n, htmlDir)).join("")}</div>`
    : `<div class="nodes empty">(no iterations yet)</div>`;

  const meta: string[] = [];
  if (branch.parentBranchId) meta.push(`parent: ${escapeHtml(branch.parentBranchId)}`);
  if (branch.forkNodeId) meta.push(`forked from: ${escapeHtml(branch.forkNodeId)}`);

  const kids = (childrenOf.get(branch.id) ?? [])
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const childrenHtml = kids.length
    ? `<div class="children">${kids
        .map((k) => renderBranch(k, childrenOf, nodesByBranch, htmlDir))
        .join("")}</div>`
    : "";

  return `
    <div class="branch">
      <div class="branch-head">
        <span class="branch-name">${escapeHtml(branch.id)}</span>
        <span class="count">${nodes.length} iteration${nodes.length === 1 ? "" : "s"}</span>
        ${meta.length ? `<span class="branch-meta">${meta.join(" &middot; ")}</span>` : ""}
      </div>
      ${nodesHtml}
      ${childrenHtml}
    </div>`;
}

const STYLE = `
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .branch {
    border: 1px solid #30363d; border-radius: 10px;
    padding: 14px; margin: 12px 0; background: #161b22;
  }
  .branch-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .branch-name { font-weight: 650; font-size: 15px; color: #58a6ff; }
  .count { font-size: 12px; color: #8b949e; }
  .branch-meta { font-size: 12px; color: #6e7681; }
  .children { margin-left: 22px; border-left: 2px solid #30363d; padding-left: 16px; margin-top: 8px; }
  .nodes { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; }
  .nodes.empty, .nodes .empty { color: #6e7681; font-size: 12px; }
  .node { flex: 0 0 auto; width: 200px; }
  .shot {
    width: 200px; height: 130px; object-fit: cover; object-position: top left;
    border: 1px solid #30363d; border-radius: 8px; background: #0d1117; display: block;
  }
  .shot.missing {
    display: flex; align-items: center; justify-content: center;
    color: #6e7681; font-size: 12px;
  }
  .node-meta { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; }
  .hash { font-size: 11px; color: #8b949e; }
  .summary { font-size: 12px; color: #c9d1d9; line-height: 1.35; }
  .badge {
    font-size: 10px; font-weight: 700; letter-spacing: .03em;
    padding: 2px 6px; border-radius: 999px; border: 1px solid #30363d; color: #c9d1d9;
  }
  .type-UI_CHANGE { background: #1f6feb33; border-color: #1f6feb; }
  .type-FEATURE { background: #2ea04333; border-color: #2ea043; }
  .type-REFACTOR { background: #d2992233; border-color: #d29922; }
  .type-UNKNOWN { background: #6e768133; }
  .empty-state { color: #8b949e; }
`;

function buildHtml(
  repo: string,
  branches: BranchRecord[],
  nodes: IterationNode[],
  htmlDir: string
): string {
  const ids = new Set(branches.map((b) => b.id));
  const childrenOf = new Map<string, BranchRecord[]>();
  const roots: BranchRecord[] = [];
  for (const b of branches) {
    if (b.parentBranchId && ids.has(b.parentBranchId)) {
      const list = childrenOf.get(b.parentBranchId) ?? [];
      list.push(b);
      childrenOf.set(b.parentBranchId, list);
    } else {
      roots.push(b);
    }
  }

  const nodesByBranch = new Map<string, IterationNode[]>();
  for (const n of nodes) {
    const list = nodesByBranch.get(n.branchId) ?? [];
    list.push(n);
    nodesByBranch.set(n.branchId, list);
  }

  const body = branches.length
    ? roots
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => renderBranch(r, childrenOf, nodesByBranch, htmlDir))
        .join("")
    : `<p class="empty-state">No graph data yet. Make a commit in a tracked repo first.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DesignTrail — ${escapeHtml(repo)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>DesignTrail design-evolution graph</h1>
  <div class="subtitle">repo: <strong>${escapeHtml(repo)}</strong> &middot; ${branches.length} component branch${branches.length === 1 ? "" : "es"} &middot; ${nodes.length} iteration node${nodes.length === 1 ? "" : "s"} &middot; generated ${escapeHtml(new Date().toLocaleString())}</div>
  ${body}
</body>
</html>`;
}

async function visualizeRepo(repo: string): Promise<string> {
  const graph = await DesignGraph.load(repo);
  try {
    const { branches, nodes } = graph.exportGraph();
    const outPath = path.join(DATA_DIR, repo, "graph.html");
    const html = buildHtml(repo, branches, nodes, path.dirname(outPath));
    await fse.writeFile(outPath, html, "utf8");
    return outPath;
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
    console.log(
      "No tracked repos found in /data. Pass a repo name (npm run visualize -- <repo>) " +
        "or make a commit in a tracked repo first."
    );
    return;
  }

  for (const repo of repos) {
    try {
      const outPath = await visualizeRepo(repo);
      console.log(`Visualized ${repo}: ${outPath}`);
    } catch (err) {
      console.error(
        `Failed to visualize ${repo}:`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error("Visualize failed:", err);
  process.exit(1);
});
