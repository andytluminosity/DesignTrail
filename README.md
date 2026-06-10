# DesignTrail

AI Design Iteration Tracker. Every time you commit code in a watched repo, DesignTrail
analyzes the change with an LLM, decides which UI components changed, captures a targeted
Playwright screenshot per component, and records each change as a node in a per-repo
**design-evolution graph** stored in SQLite. The goal is to build a visual + semantic
history of how a design evolves, organized as a tree of components.

## How it works

```mermaid
flowchart TD
  commit[git commit in a watched repo] --> hook[post-commit hook]
  hook --> capture[tracker/capture.ts]
  capture --> git["git.ts: hash, message, diff, repo name"]
  capture --> graph["graph.ts: load /data/repo/graph.db"]
  capture --> dom["screenshot.ts: getSiteContext (live DOM map)"]
  graph --> llm["llm.ts: analyzeCommit (OpenAI) -> components[]"]
  dom --> llm
  llm --> loop["for each changed component"]
  loop --> branch["branch.ts: resolveBranch / resolveParentBranch"]
  branch --> node["build IterationNode (parent = branch tip)"]
  node --> store["graph.ts: addNode + ensureBranch (SQLite)"]
  loop --> shot["screenshot.ts: takeScreenshots (one browser, N captures)"]
  shot --> annotate["annotate.ts: annotateScreenshots (vision) -> per-node annotation"]
  annotate --> save["treeStore.ts: mirror branch tree to captures/repo/(nested branch folders)"]
  store --> db["/data/repo/graph.db"]
  save --> miro["miroClient.ts: clearBoard + renderBoardFromGraph (wipe + redraw whole tree)"]
  db --> miro
```

The LLM runs **before** the screenshots. To keep its targeting grounded, DesignTrail first
reads a compact map of the **live rendered DOM** (`getSiteContext`) and passes it to the
LLM alongside the diff and the existing component tree. The LLM identifies **every** UI
component the commit changed and, for each, may only target elements that actually exist on
the page (which prevents hallucinated selectors). The screenshot logic honors each decision
and falls back to a full-page capture on any failure (missing element, unreachable page,
etc.).

## The design-evolution graph

A **node is a component change, not a commit**: one commit can change several components and
therefore produce several nodes and several screenshots. Nodes are organized into a
**component tree** where each branch is a component.

- **Branches are components.** All changes to the same component chain together on one
  branch via each node's `parentId` (the previous node on that branch).
- **Nesting is LLM-driven.** When a commit introduces a brand-new component, the LLM picks
  which existing branch it nests under (any branch in the tree), recorded as
  `parent_branch_id`. `fork_node_id` pins the node it split from.
- **Aggressive sub-component splitting.** Distinct named sub-components (e.g. a sidebar's
  logo) get their OWN branch nested under their container instead of being lumped into the
  container branch. The container branch is reserved for whole-component changes (layout, a
  new control like a collapse toggle). Small atomic controls are screenshotted framed in
  their containing component, never as a bare crop.
- **Cascading ancestor updates.** Whenever a commit adds a new component (branch), every
  ancestor up to `main` gets a fresh appended node that re-captures the ancestor's own
  component, reflecting the new descendant (e.g. adding a `logo` appends an update node to
  `sidebar` showing the whole sidebar, and to `main` as a full-page shot). This is
  append-only: ancestors gain a new node and screenshot; existing history is never
  overwritten. To make re-capture possible, each branch persists how to screenshot itself
  (`nav_path` + `target_json`).
- **Stable identity.** The existing branch tree is rendered into the prompt with explicit
  parsing instructions, so the LLM reuses an exact existing branch name when a change
  targets that same component (instead of inventing a near-duplicate like `side-nav` vs
  `sidebar`). A validation backstop drops any `parentBranch` that isn't a real branch.
- **Broad / non-visual changes** land on `main` with a full-page capture.

Everything is persisted per repo in SQLite at `data/<repo>/graph.db` (no server, fully
deterministic, rebuilt from disk on every commit). `DesignGraph.exportGraph()` returns
`{ branches, nodes }` for downstream consumers (a visual graph, timeline UI, replay, etc.).

### Database schema

```sql
commits  (hash PK, message, diff, timestamp)                 -- per-commit data, stored once
branches (id PK, parent_branch_id, fork_node_id, created_at, -- the component tree
          nav_path, target_json)                             -- how to re-screenshot the branch
nodes    (id PK = "<hash>:<branch>", commit_hash, branch_id, -- one per component change
          parent_id, summary, annotation, type, screenshot_path, timestamp,
          geom_x, geom_y, geom_w, geom_h, page_w, page_h)    -- annotation + located element's on-screen rect
```

Each node also records the **on-screen geometry** of its located element (the
component's bounding box in document pixels, plus the full page dimensions). This
is what lets the visualizer reconstruct a real spatial frame tree (see
[Visualizing the graph](#visualizing-the-graph)) instead of relying on the LLM's
semantic nesting. Geometry is captured automatically for new commits; older nodes
have it backfilled by `npm run backfill-geometry`.

Console output is a per-component block under each commit:

```text
========================
COMMIT: <hash>   REPO: <repo>

COMPONENT: sidebar
  PARENT BRANCH: main
  PARENT NODE:   none
  TYPE:          UI_CHANGE
  SUMMARY:       Added collapse toggle to sidebar
  ANNOTATION:    What: A collapse toggle now sits in the sidebar header.
                 Why: Likely to reclaim horizontal space and improve focus on the main content.
  SCREENSHOT:    captures/TempRepo/main/sidebar/001-<hash>.png
========================
```

## Requirements

- Node.js 20.12+ (uses the built-in `process.loadEnvFile`)
- A local dev server for the app you're tracking, running on the capture URL
  (default `http://localhost:3000`)
- An OpenAI API key

## Setup

```bash
npm install
npx playwright install   # downloads the Chromium browser Playwright drives
```

Create a `.env` file in this directory:

```bash
OPENAI_API_KEY=sk-...
# Optional: override the page the screenshot is taken against (default below)
CAPTURE_URL=http://localhost:3000
# Optional: public base URL Miro can fetch screenshots from, e.g. an ngrok URL.
# Defaults to CAPTURE_URL when omitted.
CAPTURE_PUBLIC_URL=https://your-ngrok-host.ngrok-free.app
```

`.env` is git-ignored.

## Watching a repo

Use the installer to add the tracking hook to any git repo. No manual hook editing
required.

```bash
# Watch one repo
npm run track -- /path/to/some-repo

# Watch several at once
npm run track -- /path/to/repoA /path/to/repoB

# Watch the current directory (no argument)
npm run track
```

The installer ([tracker/install.ts](tracker/install.ts)):

- Verifies the target is a git repo and finds its hooks directory via
  `git rev-parse --git-path hooks` (respects `core.hooksPath` and worktrees).
- Writes a `post-commit` hook that calls this DesignTrail install. The DesignTrail path is
  derived from the script's own location, so it's correct wherever DesignTrail lives.
- Marks the hook executable.

It is safe to re-run:

- **Fresh repo** -> creates the hook.
- **Re-run** -> updates the DesignTrail block in place (no duplicates).
- **Repo with an existing hook** -> preserves it and appends the DesignTrail block, fenced
  by markers:

```sh
# >>> DesignTrail tracker >>>
DESIGNTRAIL="/abs/path/to/DesignTrail"
"$DESIGNTRAIL/node_modules/.bin/tsx" "$DESIGNTRAIL/tracker/capture.ts"
# <<< DesignTrail tracker <<<
```

## Unwatching a repo

Use the uninstaller to remove the tracking hook from a repo. Same argument style as
`track` (one repo, several repos, or the current directory with no argument).

```bash
# Stop watching one repo
npm run untrack -- /path/to/some-repo

# Stop watching several at once
npm run untrack -- /path/to/repoA /path/to/repoB

# Stop watching the current directory (no argument)
npm run untrack
```

The uninstaller ([tracker/uninstall.ts](tracker/uninstall.ts)):

- Resolves the hooks directory the same way as the installer (`git rev-parse --git-path
  hooks`).
- Removes the DesignTrail block whether it was installed with the marker fences or as a
  stand-alone hook.
- If the hook contained other commands, preserves them and removes only the DesignTrail
  part; if the hook existed only for DesignTrail, deletes the `post-commit` file entirely.
- Is safe to re-run and on repos that were never tracked (it leaves their hooks untouched).

## What happens on each commit

1. The watched repo's `post-commit` hook runs the tracker. git sets the working directory
   to that repo, so the tracker reads **that repo's** latest commit and diff, while loading
   its own dependencies and `.env` from the DesignTrail install. For manual runs, pass a
   repo path with `npm run capture -- /path/to/repo`.
2. The per-repo graph is opened (`data/<repo>/graph.db`) and the commit row is recorded.
3. `analyzeCommit` sends the commit message + diff + live DOM map + existing component tree
   to OpenAI and gets back a list of changed components.
4. For each component, a branch is resolved (reused or newly nested), an `IterationNode` is
   written, and a targeted screenshot is captured (all captures share one browser). Each
   surviving screenshot then gets a unique, design-oriented annotation (What changed + a
   hedged guess at Why) from a vision pass (`annotate.ts`) that reads the captured image plus
   the diff; it is stored on the node and surfaced in the visualizer and Miro sticky notes.
5. Once the branch tree is finalized, the screenshots are mirrored into nested branch folders
   under `captures/<repo-name>/` so the directory layout matches the component tree (each
   branch folder holds its iteration PNGs plus its child-branch subfolders). SQLite remains
   the source of truth; the folder tree is reconciled from it after every capture. Captures
   from all watched repos are centralized here and namespaced per repo.
6. Finally, the Miro board is wiped and **re-rendered in full** from the graph (see
   [Rendering the board on Miro](#rendering-the-board-on-miro)). Because the whole tree is
   redrawn every commit, positions are recomputed each time so the board always reflects the
   complete, current design-evolution tree (including the new commit).

The reusable core entry point is `createDesignSnapshot(options)` in
`src/core/snapshotService.ts`. Integrations should pass `repoPath` explicitly
instead of changing process state:

```ts
await createDesignSnapshot({
  repoPath: "/path/to/repo",
  source: "claude",
  annotation: "Optional note from the integration",
  syncMiro: true,
});
```

Set `syncMiro: false` to capture and persist locally without creating/updating
Miro items.

## LLM output contract

`analyzeCommit({ diff, commitMessage, siteContext, existingBranches })`
([tracker/llm.ts](tracker/llm.ts)) returns a list of changed components:

```json
{
  "components": [
    {
      "component": "sidebar",
      "parentBranch": "main",
      "summary": "Added collapse toggle to sidebar",
      "type": "UI_CHANGE",
      "path": "/dashboard",
      "screenshotTarget": { "mode": "selector", "value": ".sidebar" }
    }
  ]
}
```

- `component` is a stable branch id; `""` means a broad/global/non-visual change (-> `main`).
- `parentBranch` is only used for a **new** component: which existing branch it nests under
  (`""` -> `main`). It is dropped unless it names a real branch.
- `type` is one of `UI_CHANGE`, `FEATURE`, `REFACTOR`, `UNKNOWN`.
- `screenshotTarget.mode` is one of `full`, `selector`, `text`, `role`.
  - `full` -> full-page screenshot (no `value`).
  - `selector` -> `page.locator(value)` with a CSS selector.
  - `text` -> `page.getByText(value)`.
  - `role` -> `page.getByRole(value)` with an ARIA role.

To keep targeting accurate, `analyzeCommit` receives `siteContext`: a per-page compact map
of the live page's real elements (tag, id, classes, role, `data-testid`, and visible text)
produced by `getSiteContext` in [tracker/screenshot.ts](tracker/screenshot.ts). The prompt
instructs the model to target **only** elements present in that context. It also receives
`existingBranches`, rendered as an indented component tree with explicit parsing
instructions, so it reuses exact existing branch names.

The call uses OpenAI's JSON mode (`response_format: { type: "json_object" }`) to force
valid JSON, then validates each component independently. On **any** failure (missing API
key, network error, parse error, invalid shape) or when no entry survives validation, it
returns a safe fallback:

```json
{ "components": [{ "component": "", "summary": "General layout change", "type": "UNKNOWN", "path": "/", "screenshotTarget": { "mode": "full" } }] }
```

If a chosen element can't be found on the page, that screenshot falls back to full-page. The
system never crashes a commit.

## Configuration

| Variable         | Default                  | Purpose                                          |
| ---------------- | ------------------------ | ------------------------------------------------ |
| `OPENAI_API_KEY` | (required for analysis)  | Auth for the OpenAI call. Missing -> full-page fallback. |
| `CAPTURE_URL`    | `http://localhost:3000`  | The page the screenshot is taken against.        |
| `CAPTURE_PUBLIC_URL` / `PUBLIC_CAPTURE_URL` | `CAPTURE_URL` | Public base URL Miro uses to fetch saved screenshots. |

Read from `.env` in the DesignTrail root, regardless of which repo triggered the hook.

## Project layout

```text
tracker/
  capture.ts      Thin CLI adapter around the core snapshot service
  git.ts          getLatestCommit, getDiff, getRepoName via simple-git
  llm.ts          analyzeCommit (OpenAI JSON mode, DOM-grounded, tree-aware) + safe fallback
  branch.ts       slug/resolveBranch/resolveParentBranch (component -> branch id)
  graph.ts        DesignGraph over SQLite (commits/branches/nodes); tips, ensureBranch, addNode, exportGraph
  screenshot.ts   getSiteContext(url) for live DOM map + takeScreenshots(jobs, url) (one browser, full-page fallback)
  layout.ts       buildLayout: derives a spatial frame tree from node geometry (containment + reading order)
  visualize.ts    Renders the per-repo graph.html as a pan/zoom Figma/Miro-style spatial board
  backfill-geometry.ts  One-off: populates geometry for branches captured before geometry tracking
  install.ts      Installs the post-commit hook into target repos
  uninstall.ts    Removes the post-commit hook from target repos
  types.ts        CommitData, ScreenshotTarget, ComponentChange, CommitAnalysis, IterationNode, BranchRecord, NodeGeometry
miro/
  miroClient.ts   clearBoard + renderBoardFromGraph: wipe the board and redraw the whole component tree
  treeLayout.ts   computeClusterFootprint + planTreeLayout (LLM positions, validated, deterministic fallback)
  annotationPlacement.ts  Splits annotations into blocks + vision-places each on its screenshot
src/core/
  snapshotService.ts  Reusable createDesignSnapshot(...) workflow entry point
captures/         Saved screenshots mirrored as the nested branch tree, captures/<repo>/<branch-path>/<NNN>-<shortHash>.png (git-ignored)
data/             Per-repo SQLite graphs at data/<repo>/graph.db (git-ignored)
```

## Scripts

```bash
npm run capture            # Manually run the pipeline against the current repo/commit
npm run capture -- <repo>  # Manually run the pipeline against a specific repo/commit
npm run track -- <repo>    # Install the tracking hook into one or more repos
npm run untrack -- <repo>  # Remove the tracking hook from one or more repos
npm run visualize -- <repo> # Render the graph to data/<repo>/graph.html (all repos if omitted)
npm run backfill-geometry -- <repo> # Backfill on-screen geometry for pre-geometry nodes (all repos if omitted)
```

## Visualizing the graph

`npm run visualize` ([tracker/visualize.ts](tracker/visualize.ts)) reads a repo's SQLite graph
and writes a self-contained `data/<repo>/graph.html` — no graph libraries, just nested cards.
It renders the **component tree** (each branch nested under its `parent_branch_id`, annotated
with its fork point) and, within each branch, the ordered **iteration nodes** as screenshot
thumbnails with their type and summary. Open the file in a browser:

```bash
npm run visualize -- TempRepo   # one repo
npm run visualize               # every repo found under data/
open data/TempRepo/graph.html
```

## Rendering the board on Miro

When `syncMiro` is on (the default), `createDesignSnapshot` re-renders the entire
design-evolution graph onto a Miro board after every commit via
`renderBoardFromGraph` ([miro/miroClient.ts](miro/miroClient.ts)). It is a
**wipe-and-rerender**, not an append:

1. **Wipe.** `clearBoard` pages through the board and deletes every connector and
   item (in parallel), so each render starts from a clean slate. (This removes ALL
   content on the configured `MIRO_BOARD_ID`, so use a board dedicated to
   DesignTrail.) The wipe fully completes before any inserts begin.
2. **Footprint.** For each iteration node with a screenshot, the image is sized at
   a fixed width (height from the PNG's real aspect ratio) and its per-element
   annotations are vision-placed ([miro/annotationPlacement.ts](miro/annotationPlacement.ts)).
   `computeClusterFootprint` then measures the full bounding box of the cluster
   (image + header note + every annotation note).
3. **Layout.** `planTreeLayout` ([miro/treeLayout.ts](miro/treeLayout.ts)) assigns
   each cluster a non-overlapping position so the screenshots assemble into the
   component tree (branches nested under their parent, each branch's iterations in a
   chronological row). An **LLM proposes the positions**; the proposal is accepted
   only if it is complete, tree-shaped, and overlap-free (no screenshot or sticky
   note overlapping anything), otherwise a deterministic tidy-tree layout is used so
   the result is always clean.
4. **Draw.** Each screenshot is placed with its header note and per-element
   annotation notes (each connected to the element it describes), then tree
   connectors are drawn: a chronological chain within each branch and a fork edge
   from each branch's fork point to that branch's first screenshot. Inserts run in
   parallel (images first, then connectors that reference them), globally capped by
   a concurrency limiter and spaced by a minimum request interval. Every Miro call
   goes through one wrapper that retries `429` / `5xx` responses with backoff that
   honors Miro's `Retry-After` header, so a rate-limited call waits and succeeds
   instead of being dropped. Tune `MIRO_CONCURRENCY` and `MIRO_MIN_INTERVAL_MS` if
   you still see throttling.

Because the board is rebuilt from SQLite every time, positions are recomputed on
every commit and the board always shows the complete, current tree. Configure the
board with `MIRO_BOARD_ID` and complete the OAuth flow in `miro-service/` first.
Set `syncMiro: false` to capture and persist locally without touching Miro.

## Manual testing

```bash
# Start the dev server for the app you track (must serve CAPTURE_URL)
# then either commit from the watched repo:
git commit -m "tweak layout"
# ...the tracker runs automatically, mirrors screenshots into captures/<repo>/<branch-path>/
# and updates data/<repo>/graph.db

# or manually capture a specific repo:
npm run capture -- /path/to/watched-repo
```

## Notes and constraints

- Local and deterministic: a per-repo SQLite graph, no server, no third-party design tool
  integration. State is rebuilt from disk on every commit.
- Screenshots require the dev server to be running; otherwise the capture step is skipped
  with a warning and the commit still succeeds (graph nodes are still written).
- This is a hackathon project; the design intent is to grow toward component-level capture,
  semantic UI diffs, and intelligent design-exploration graphs.
```
