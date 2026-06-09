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
  shot --> save["save PNG to captures/repo/hash/component.png"]
  store --> db["/data/repo/graph.db"]
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
          parent_id, summary, type, screenshot_path, timestamp,
          geom_x, geom_y, geom_w, geom_h, page_w, page_h)    -- located element's on-screen rect
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
  SCREENSHOT:    captures/TempRepo/<hash>/sidebar.png
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
   its own dependencies and `.env` from the DesignTrail install.
2. The per-repo graph is opened (`data/<repo>/graph.db`) and the commit row is recorded.
3. `analyzeCommit` sends the commit message + diff + live DOM map + existing component tree
   to OpenAI and gets back a list of changed components.
4. For each component, a branch is resolved (reused or newly nested), an `IterationNode` is
   written, and a targeted screenshot is captured (all captures share one browser).
5. PNGs are saved to `captures/<repo-name>/<commit-hash>/<component>.png` inside DesignTrail
   (captures from all watched repos are centralized here and namespaced per repo).

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

Read from `.env` in the DesignTrail root, regardless of which repo triggered the hook.

## Project layout

```text
tracker/
  capture.ts      Orchestrates the pipeline; resolves paths, loads .env, writes graph, logs
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
captures/         Saved screenshots, namespaced as captures/<repo>/<hash>/<component>.png (git-ignored)
data/             Per-repo SQLite graphs at data/<repo>/graph.db (git-ignored)
```

## Scripts

```bash
npm run capture            # Manually run the pipeline against the current repo/commit
npm run track -- <repo>    # Install the tracking hook into one or more repos
npm run untrack -- <repo>  # Remove the tracking hook from one or more repos
npm run visualize -- <repo> # Render the graph to data/<repo>/graph.html (all repos if omitted)
npm run backfill-geometry -- <repo> # Backfill on-screen geometry for pre-geometry nodes (all repos if omitted)
```

## Visualizing the graph

`npm run visualize` ([tracker/visualize.ts](tracker/visualize.ts)) reads a repo's SQLite graph
and writes a self-contained `data/<repo>/graph.html` — no graph libraries, just positioned
`<div>`s and a little vanilla JS. It renders a **Figma/Miro-style spatial board**: every branch
is a **frame** placed at its located element's real on-screen rect, so the hierarchy reflects
what actually contains what on the page.

- **Geometry-driven nesting.** [tracker/layout.ts](tracker/layout.ts) (`buildLayout`) assigns
  each frame's parent as the smallest *other* frame whose rect fully encloses it (true spatial
  containment), and orders siblings in reading order (top-to-bottom, then left-to-right). This
  is why a `logo` frame nests inside the `sidebar` frame: its bounding box sits inside the
  sidebar's. `main` (a full-page capture) is the outer page rect that contains everything.
- **Fallback.** A branch with no geometry yet (e.g. a capture failed) falls back to its
  LLM-assigned `parent_branch_id`; anything still unplaceable appears in a clickable tray at
  the bottom of the board.
- **Pan & zoom.** Scroll to zoom toward the cursor, drag to pan, or hit **Fit to screen**.
- **Iteration timeline.** Click any frame (or tray chip) to open a drawer with that branch's
  ordered iteration nodes — screenshot, type badge, commit hash, and summary.

```bash
npm run backfill-geometry -- TempRepo   # first time only: measure existing branches
npm run visualize -- TempRepo           # one repo
npm run visualize                       # every repo found under data/
open data/TempRepo/graph.html
```

Geometry is captured automatically on every new commit, so the backfill is only needed once for
history recorded before geometry tracking existed. Both the backfill and the live capture need
the dev server running on `CAPTURE_URL`.

## Manual testing

```bash
# Start the dev server for the app you track (must serve CAPTURE_URL)
# then, from the watched repo:
git commit -m "tweak layout"
# ...the tracker runs automatically, writes captures/<repo>/<hash>/<component>.png
# and updates data/<repo>/graph.db
```

## Notes and constraints

- Local and deterministic: a per-repo SQLite graph, no server, no third-party design tool
  integration. State is rebuilt from disk on every commit.
- Screenshots require the dev server to be running; otherwise the capture step is skipped
  with a warning and the commit still succeeds (graph nodes are still written).
- This is a hackathon project; the design intent is to grow toward component-level capture,
  semantic UI diffs, and intelligent design-exploration graphs.
```
