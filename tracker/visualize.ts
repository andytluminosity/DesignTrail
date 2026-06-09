import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import { DesignGraph } from "./graph.js";
import { buildLayout } from "./layout.js";
import type { FrameNode, Layout } from "./layout.js";
import type { IterationNode } from "./types.js";

// DesignTrail root (parent of this tracker/ dir), where /data and /captures live.
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(TRACKER_ROOT, "data");

// Padding (page px) around the page rect so edge frames and their labels have room.
const PAGE_PAD = 80;

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

function shotRel(node: IterationNode, htmlDir: string): { rel: string; exists: boolean } {
  const absShot = path.join(TRACKER_ROOT, node.screenshotPath);
  return { rel: path.relative(htmlDir, absShot), exists: fse.pathExistsSync(absShot) };
}

/** One iteration node (a component change) as a card with its screenshot. */
function renderNode(node: IterationNode, htmlDir: string): string {
  const { rel, exists } = shotRel(node, htmlDir);
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

/** A positioned frame placed at its located element's real page rect. */
function renderFrame(frame: FrameNode, depth: number, htmlDir: string): string {
  const g = frame.geometry;
  if (!g) return "";
  const type = frame.latest?.type ?? "UNKNOWN";
  const shot = frame.latest ? shotRel(frame.latest, htmlDir) : null;
  const bg =
    shot && shot.exists
      ? `<img class="frame-shot" src="${escapeHtml(shot.rel)}" alt="" loading="lazy" />`
      : `<div class="frame-shot frame-shot-missing"></div>`;
  const count = frame.nodes.length;

  return `
    <div class="frame type-border-${escapeHtml(type)}" data-branch="${escapeHtml(frame.branch.id)}"
         style="left:${g.x}px;top:${g.y}px;width:${Math.max(2, g.w)}px;height:${Math.max(2, g.h)}px;z-index:${10 + depth};">
      ${bg}
      <div class="frame-label">
        <span class="frame-name">${escapeHtml(frame.branch.id)}</span>
        <span class="frame-count">${count}</span>
      </div>
    </div>`;
}

function renderFramesRecursive(frame: FrameNode, depth: number, htmlDir: string): string {
  const self = renderFrame(frame, depth, htmlDir);
  const kids = frame.children.map((c) => renderFramesRecursive(c, depth + 1, htmlDir)).join("");
  return self + kids;
}

function walkFrames(frames: FrameNode[], visit: (f: FrameNode) => void): void {
  for (const f of frames) {
    visit(f);
    walkFrames(f.children, visit);
  }
}

/** Hidden per-branch block the drawer clones when a frame/chip is clicked. */
function renderDrawerData(frame: FrameNode, htmlDir: string): string {
  const meta: string[] = [`${frame.nodes.length} iteration${frame.nodes.length === 1 ? "" : "s"}`];
  if (frame.branch.parentBranchId) meta.push(`semantic parent: ${frame.branch.parentBranchId}`);
  if (!frame.geometry) meta.push("no geometry yet");
  const nodesHtml = frame.nodes.length
    ? frame.nodes.map((n) => renderNode(n, htmlDir)).join("")
    : `<div class="empty">(no iterations yet)</div>`;
  return `<div data-branch="${escapeHtml(frame.branch.id)}"
       data-name="${escapeHtml(frame.branch.id)}" data-meta="${escapeHtml(meta.join(" \u00b7 "))}">
      <div class="nodes">${nodesHtml}</div>
    </div>`;
}

/** A chip for a branch with no geometry (rendered in the bottom tray). */
function renderChip(frame: FrameNode): string {
  const type = frame.latest?.type ?? "UNKNOWN";
  return `<button class="chip type-border-${escapeHtml(type)}" data-branch="${escapeHtml(frame.branch.id)}">
      ${escapeHtml(frame.branch.id)} <span class="chip-count">${frame.nodes.length}</span>
    </button>`;
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  header {
    position: fixed; top: 0; left: 0; right: 0; height: 64px; z-index: 1000;
    display: flex; align-items: center; gap: 16px; padding: 0 20px;
    background: rgba(13,17,23,.85); backdrop-filter: blur(6px);
    border-bottom: 1px solid #30363d;
  }
  header h1 { font-size: 16px; margin: 0; }
  .subtitle { color: #8b949e; font-size: 12px; }
  .spacer { flex: 1; }
  .btn {
    font: inherit; font-size: 12px; color: #c9d1d9; cursor: pointer;
    background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px;
  }
  .btn:hover { border-color: #58a6ff; }

  #viewport {
    position: fixed; top: 64px; left: 0; right: 0; bottom: 0;
    overflow: hidden; cursor: grab; touch-action: none;
    background:
      radial-gradient(circle at 1px 1px, #1c2230 1px, transparent 0) 0 0 / 24px 24px;
  }
  #viewport:active { cursor: grabbing; }
  #canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  #page {
    position: absolute; left: ${PAGE_PAD}px; top: ${PAGE_PAD}px;
    border: 1px dashed #30363d; border-radius: 6px; background: #0a0d12;
  }
  .page-label {
    position: absolute; top: -22px; left: 0; font-size: 12px; color: #6e7681;
  }

  .frame {
    position: absolute; overflow: visible; cursor: pointer;
    border: 1px solid #30363d; border-radius: 5px; background: #0d1117;
  }
  .frame:hover { box-shadow: 0 0 0 2px #58a6ff, 0 8px 24px rgba(0,0,0,.5); }
  .frame-shot {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; object-position: top left; display: block;
    border-radius: 4px; pointer-events: none;
  }
  .frame-shot-missing { background: repeating-linear-gradient(45deg, #161b22, #161b22 8px, #11161c 8px, #11161c 16px); }
  .frame-label {
    position: absolute; top: -20px; left: -1px; display: flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; color: #e6edf3; white-space: nowrap;
    background: #161b22; border: 1px solid #30363d; border-radius: 5px;
    padding: 1px 7px; pointer-events: none; max-width: 280px;
  }
  .frame-name { overflow: hidden; text-overflow: ellipsis; }
  .frame-count {
    font-size: 10px; font-weight: 700; color: #0d1117; background: #58a6ff;
    border-radius: 999px; padding: 0 6px; min-width: 16px; text-align: center;
  }

  .type-border-UI_CHANGE { border-color: #1f6feb; }
  .type-border-FEATURE { border-color: #2ea043; }
  .type-border-REFACTOR { border-color: #d29922; }
  .type-border-UNKNOWN { border-color: #6e7681; }

  #tray {
    position: fixed; left: 0; bottom: 0; z-index: 900;
    display: flex; align-items: center; gap: 8px; max-width: calc(100% - 380px);
    overflow-x: auto; padding: 8px 12px; background: rgba(13,17,23,.85);
    backdrop-filter: blur(6px); border-top: 1px solid #30363d; border-right: 1px solid #30363d;
    border-top-right-radius: 8px;
  }
  #tray .tray-label { font-size: 11px; color: #6e7681; white-space: nowrap; }
  .chip {
    font: inherit; font-size: 12px; color: #c9d1d9; cursor: pointer; white-space: nowrap;
    background: #161b22; border: 1px solid #30363d; border-left-width: 3px; border-radius: 6px; padding: 5px 9px;
  }
  .chip:hover { border-color: #58a6ff; }
  .chip-count { color: #8b949e; font-size: 10px; }

  #drawer {
    position: fixed; top: 64px; right: 0; bottom: 0; width: 380px; z-index: 1100;
    background: #0f141a; border-left: 1px solid #30363d; padding: 16px 18px;
    overflow-y: auto; transform: translateX(100%); transition: transform .2s ease;
  }
  #drawer.open { transform: none; }
  .drawer-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  #drawer-title { font-size: 15px; font-weight: 650; color: #58a6ff; }
  #drawer-close {
    margin-left: auto; cursor: pointer; background: transparent; border: none;
    color: #8b949e; font-size: 18px; line-height: 1;
  }
  #drawer-meta { color: #6e7681; font-size: 12px; margin-bottom: 14px; }
  #drawer-body .nodes { display: flex; flex-direction: column; gap: 14px; }
  #drawer-data { display: none; }

  .node { width: 100%; }
  .shot {
    width: 100%; height: 150px; object-fit: cover; object-position: top left;
    border: 1px solid #30363d; border-radius: 8px; background: #0d1117; display: block;
  }
  .shot.missing { display: flex; align-items: center; justify-content: center; color: #6e7681; font-size: 12px; height: 80px; }
  .node-meta { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; }
  .hash { font-size: 11px; color: #8b949e; }
  .summary { font-size: 12px; color: #c9d1d9; line-height: 1.35; }
  .empty { color: #6e7681; font-size: 12px; }
  .badge {
    font-size: 10px; font-weight: 700; letter-spacing: .03em;
    padding: 2px 6px; border-radius: 999px; border: 1px solid #30363d; color: #c9d1d9;
  }
  .type-UI_CHANGE { background: #1f6feb33; border-color: #1f6feb; }
  .type-FEATURE { background: #2ea04333; border-color: #2ea043; }
  .type-REFACTOR { background: #d2992233; border-color: #d29922; }
  .type-UNKNOWN { background: #6e768133; }
  .empty-state { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #8b949e; }
`;

const SCRIPT = `
(function(){
  var viewport = document.getElementById('viewport');
  var canvas = document.getElementById('canvas');
  if(!viewport || !canvas) return;
  var scale = 1, tx = 0, ty = 0;
  var minScale = 0.03, maxScale = 8;
  function apply(){ canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function fit(){
    var cw = canvas.offsetWidth, ch = canvas.offsetHeight;
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    if(!cw || !ch) return;
    scale = clamp(Math.min(vw/cw, vh/ch) * 0.92, minScale, maxScale);
    tx = (vw - cw*scale)/2;
    ty = (vh - ch*scale)/2;
    apply();
  }
  viewport.addEventListener('wheel', function(e){
    e.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var factor = Math.exp(-e.deltaY * 0.0015);
    var ns = clamp(scale*factor, minScale, maxScale);
    tx = mx - (mx - tx) * (ns/scale);
    ty = my - (my - ty) * (ns/scale);
    scale = ns; apply();
  }, { passive: false });
  var panning=false, moved=false, sx=0, sy=0, stx=0, sty=0;
  viewport.addEventListener('pointerdown', function(e){
    panning=true; moved=false; sx=e.clientX; sy=e.clientY; stx=tx; sty=ty;
  });
  window.addEventListener('pointermove', function(e){
    if(!panning) return;
    var dx=e.clientX-sx, dy=e.clientY-sy;
    if(Math.abs(dx)+Math.abs(dy) > 4) moved=true;
    tx=stx+dx; ty=sty+dy; apply();
  });
  window.addEventListener('pointerup', function(){ panning=false; });

  var drawer=document.getElementById('drawer');
  var dTitle=document.getElementById('drawer-title');
  var dMeta=document.getElementById('drawer-meta');
  var dBody=document.getElementById('drawer-body');
  function openDrawer(id){
    var src=document.querySelector('#drawer-data > [data-branch="' + id + '"]');
    if(!src) return;
    dTitle.textContent = src.getAttribute('data-name') || id;
    dMeta.textContent = src.getAttribute('data-meta') || '';
    var nodes = src.querySelector('.nodes');
    dBody.innerHTML = nodes ? nodes.innerHTML : '';
    drawer.classList.add('open');
  }
  document.getElementById('drawer-close').addEventListener('click', function(){ drawer.classList.remove('open'); });

  function bind(el){
    el.addEventListener('click', function(e){
      if(moved) return;
      e.stopPropagation();
      openDrawer(el.getAttribute('data-branch'));
    });
  }
  var frames = document.querySelectorAll('.frame[data-branch], .chip[data-branch]');
  for(var i=0;i<frames.length;i++){ bind(frames[i]); }

  var fitBtn = document.getElementById('fit-btn');
  if(fitBtn) fitBtn.addEventListener('click', fit);
  fit();
})();
`;

function buildHtml(repo: string, layout: Layout, htmlDir: string, branchCount: number, nodeCount: number): string {
  const hasFrames = layout.roots.length > 0 || layout.unpositioned.length > 0;

  const framesHtml = layout.roots
    .map((r) => renderFramesRecursive(r, 0, htmlDir))
    .join("");

  const drawerBlocks: string[] = [];
  walkFrames(layout.roots, (f) => drawerBlocks.push(renderDrawerData(f, htmlDir)));
  layout.unpositioned.forEach((f) => drawerBlocks.push(renderDrawerData(f, htmlDir)));

  const tray = layout.unpositioned.length
    ? `<div id="tray">
         <span class="tray-label">no geometry yet:</span>
         ${layout.unpositioned.map(renderChip).join("")}
       </div>`
    : "";

  const canvasW = layout.pageW + PAGE_PAD * 2;
  const canvasH = layout.pageH + PAGE_PAD * 2;

  const board = hasFrames
    ? `<div id="viewport">
         <div id="canvas" style="width:${canvasW}px;height:${canvasH}px;">
           <div id="page" style="width:${layout.pageW}px;height:${layout.pageH}px;">
             <div class="page-label">page</div>
             ${framesHtml}
           </div>
         </div>
       </div>
       ${tray}`
    : `<div class="empty-state">No graph data yet. Make a commit in a tracked repo first.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DesignTrail — ${escapeHtml(repo)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>DesignTrail</h1>
    <span class="subtitle">repo: <strong>${escapeHtml(repo)}</strong> &middot; ${branchCount} component${branchCount === 1 ? "" : "s"} &middot; ${nodeCount} iteration${nodeCount === 1 ? "" : "s"}</span>
    <span class="spacer"></span>
    <button id="fit-btn" class="btn">Fit to screen</button>
  </header>

  ${board}

  <aside id="drawer">
    <div class="drawer-head">
      <span id="drawer-title"></span>
      <button id="drawer-close" title="Close">&times;</button>
    </div>
    <div id="drawer-meta"></div>
    <div id="drawer-body"></div>
  </aside>

  <div id="drawer-data">${drawerBlocks.join("")}</div>

  <script>${SCRIPT}</script>
</body>
</html>`;
}

async function visualizeRepo(repo: string): Promise<string> {
  const graph = await DesignGraph.load(repo);
  try {
    const { branches, nodes } = graph.exportGraph();
    const layout = buildLayout(branches, nodes);
    const outPath = path.join(DATA_DIR, repo, "graph.html");
    const html = buildHtml(repo, layout, path.dirname(outPath), branches.length, nodes.length);
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
