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
branches (id PK, parent_branch_id, fork_node_id, created_at) -- the component tree
nodes    (id PK = "<hash>:<branch>", commit_hash, branch_id, -- one per component change
          parent_id, summary, type, screenshot_path, timestamp)
```

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
  install.ts      Installs the post-commit hook into target repos
  uninstall.ts    Removes the post-commit hook from target repos
  types.ts        CommitData, ScreenshotTarget, ComponentChange, CommitAnalysis, IterationNode, BranchRecord
captures/         Saved screenshots, namespaced as captures/<repo>/<hash>/<component>.png (git-ignored)
data/             Per-repo SQLite graphs at data/<repo>/graph.db (git-ignored)
```

## Scripts

```bash
npm run capture           # Manually run the pipeline against the current repo/commit
npm run track -- <repo>   # Install the tracking hook into one or more repos
npm run untrack -- <repo> # Remove the tracking hook from one or more repos
```

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
