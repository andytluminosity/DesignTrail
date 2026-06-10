import OpenAI from "openai";
import type {
  BranchRecord,
  CommitAnalysis,
  CommitType,
  ComponentChange,
  PageContext,
  ScreenshotTarget,
} from "./types.js";

const MODEL = "gpt-4o-mini";

const FALLBACK: CommitAnalysis = {
  components: [
    {
      component: "",
      summary: "General layout change",
      type: "UNKNOWN",
      path: "/",
      screenshotTarget: { mode: "full" },
    },
  ],
};

const VALID_TYPES: CommitType[] = ["UI_CHANGE", "FEATURE", "REFACTOR", "UNKNOWN"];
const VALID_MODES: ScreenshotTarget["mode"][] = ["full", "selector", "text", "role"];

const SYSTEM_PROMPT = `You are a design-change analyzer for a git-based UI iteration tracker.
Given a commit message, its diff, a snapshot of the LIVE rendered DOM for each page,
and the EXISTING COMPONENT TREE, identify EVERY distinct UI component/area the commit
changed, and for each one decide what to screenshot and which branch it belongs to.

Respond with ONLY a JSON object in exactly this shape:
{
  "components": [
    {
      "component": string (stable component id; "" for a broad/global/non-visual change),
      "parentBranch": string (ONLY for a NEW component: the existing branch it nests under; "" => main),
      "summary": string,
      "type": "UI_CHANGE" | "FEATURE" | "REFACTOR" | "UNKNOWN",
      "path": string (the route to navigate to, e.g. "/dashboard"),
      "screenshotTarget": {
        "mode": "full" | "selector" | "text" | "role" (use "full" ONLY when component is "";
                a NAMED component MUST locate its change with selector/text/role),
        "value": string (omit ONLY when mode is "full")
      }
    }
  ]
}

HOW TO READ THE EXISTING COMPONENT TREE:
- Each line is an existing component branch. Indentation shows nesting: a more-indented
  line is a child of the nearest less-indented line above it. "main" is the root.
- "[forkedFrom: ...]" is informational provenance only — do NOT echo or use it in your output.
- When this commit changes one of these EXISTING components, set "component" to that EXACT
  name (copy it verbatim — same spelling/casing) so it continues that branch. Do NOT create
  a near-duplicate (e.g. "side-nav" when "sidebar" already exists).
- Only when a component is genuinely NOT in the tree, invent a new short lowercase id AND set
  "parentBranch" to the EXACT name of the existing branch it most logically nests under (any
  branch in the tree, not just leaves). Use "parentBranch": "" to nest under main.
- Never set "parentBranch" to a name that is not in the tree; never set it to the new
  component's own name.

COMPONENT GRANULARITY — BE AGGRESSIVE ABOUT SPLITTING SUB-COMPONENTS:
- Decompose changes to the finest NAMED, REUSABLE sub-component. A container like a sidebar
  has distinct sub-components (its logo/brand mark, its nav, its footer). When a change
  targets one specific named sub-element, give that sub-element its OWN dedicated branch
  nested under the container, instead of attributing the change to the broad container branch.
  Example: a change to the sidebar's logo => component "logo", parentBranch "sidebar" (NOT
  component "sidebar"). A change to a nav inside a sidebar => component "nav", parentBranch
  "sidebar".
- RESERVE the container branch (e.g. "sidebar") for changes that affect the component AS A
  WHOLE: adding/removing/reordering its children, layout, or adding a new control that
  restructures it (e.g. adding a collapse toggle to the sidebar => component "sidebar").
- Concrete worked examples (locate the changed element precisely; the tracker screenshots
  its immediate parent container automatically):
  - Logo text changes from "IT" to "ITQQ" (locate the text node itself):
    { "component": "logo", "parentBranch": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "text", "value": "ITQQ" } }
  - Footer version text changes from "v0.1.0" to "v0.1.1" (locate the text — do NOT attribute
    this to the whole sidebar, and do NOT use mode "full"):
    { "component": "footer", "parentBranch": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "text", "value": "v0.1.1" } }
  - A nav link label changes (locate the link):
    { "component": "nav", "parentBranch": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "text", "value": "Projects" } }
  - A collapse toggle button is added to the sidebar (a container-wide change):
    { "component": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "selector", "value": ".sidebar__collapse" } }

CRITICAL targeting rules:
- The "UI CONTEXT" section lists pages (as "PAGE <route>:") and, under each, the elements
  that ACTUALLY exist on that page. You MUST only target elements that appear there. NEVER
  invent a class, id, text, or role that is not present.
- For each component, "path" MUST be one of the listed PAGE routes — the page where that
  change is visible. The screenshot target MUST exist on THAT page.
- "mode"/"value" describe how to LOCATE the changed element. Prefer "text" (exact visible
  text from the context) or "role" because they are the most robust. Use "selector" only when
  a class/id from the context clearly isolates the element.

CONTAINER MODEL — "mode"/"value" LOCATE the change; the tracker FRAMES the branch:
- "mode"/"value" pinpoint the changed element (the text node, icon, button, etc.). Pick the
  MOST SPECIFIC element that actually changed, and make sure it exists in the UI CONTEXT.
- The tracker automatically climbs EXACTLY ONE DOM level up from the located element and
  screenshots/measures that immediate parent container — that parent is what DEFINES this
  component's branch. So choose "mode"/"value" such that the located element's direct parent
  is the meaningful frame for this component.
- A change that affects a container AS A WHOLE belongs to that container's own branch: locate
  a direct child of that container so the one-level climb lands on the container itself.
- A NAMED component is ALWAYS a concrete on-screen area, so it MUST use mode selector/text/role
  to locate the change (never "full").
- NEVER use mode "full" for a named component. "full" screenshots the ENTIRE page and is
  reserved EXCLUSIVELY for "component": "" (a genuinely global, page-wide, or non-visual
  change). A small text/style tweak to one area (a footer version string, a single label,
  one stat color) is NOT global — locate the changed element instead.
- Emit one entry per distinct changed component. Only when the change is genuinely page-wide,
  non-visual, or the UI CONTEXT is empty, return a SINGLE entry with "component": "",
  "path": "/" and mode "full".`;

function formatSiteContext(site: PageContext[] | null | undefined): string {
  if (!site || site.length === 0) {
    return "(no UI context available — the page could not be read)";
  }
  return site
    .map((page) => {
      const elements = page.elements
        .map((e) => {
          const selector =
            `${e.tag}` +
            `${e.id ? `#${e.id}` : ""}` +
            `${e.classes.length ? "." + e.classes.join(".") : ""}`;
          const meta: string[] = [];
          if (e.role) meta.push(`role="${e.role}"`);
          if (e.testid) meta.push(`data-testid="${e.testid}"`);
          if (e.text) meta.push(`text=${JSON.stringify(e.text)}`);
          if (e.parent) meta.push(`parent=${e.parent}`);
          return `  - ${selector}${meta.length ? " " + meta.join(" ") : ""}`;
        })
        .join("\n");
      return `PAGE ${page.path}:\n${elements || "  (no elements)"}`;
    })
    .join("\n\n");
}

/**
 * Renders the branch tree as a deterministic indented list so the LLM can read
 * which components exist and how they nest. Children are sorted alphabetically;
 * a branch is treated as a root when it has no (present) parent.
 */
export function formatBranchTree(branches: BranchRecord[]): string {
  if (!branches || branches.length === 0) {
    return "EXISTING COMPONENT TREE: (none yet — this is the first commit)";
  }

  const ids = new Set(branches.map((b) => b.id));
  const childrenOf = new Map<string, BranchRecord[]>();
  const roots: BranchRecord[] = [];

  for (const b of branches) {
    const parent = b.parentBranchId;
    if (parent && ids.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(b);
      childrenOf.set(parent, list);
    } else {
      roots.push(b);
    }
  }

  const byId = (a: BranchRecord, c: BranchRecord) => a.id.localeCompare(c.id);
  const lines: string[] = [];

  const walk = (branch: BranchRecord, depth: number) => {
    const indent = "  ".repeat(depth);
    const fork = branch.forkNodeId ? `  [forkedFrom: ${branch.forkNodeId}]` : "";
    lines.push(`${indent}- ${branch.id}${fork}`);
    const kids = (childrenOf.get(branch.id) ?? []).slice().sort(byId);
    for (const kid of kids) walk(kid, depth + 1);
  };

  for (const root of roots.slice().sort(byId)) walk(root, 0);

  return (
    "EXISTING COMPONENT TREE (each line is a branch; indentation = nesting under the line above):\n" +
    lines.join("\n")
  );
}

function validateComponent(
  raw: unknown,
  existingBranchNames: Set<string>
): ComponentChange | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const component = typeof obj.component === "string" ? obj.component.trim() : "";
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "General layout change";
  const type = VALID_TYPES.includes(obj.type as CommitType)
    ? (obj.type as CommitType)
    : "UNKNOWN";
  const path =
    typeof obj.path === "string" && obj.path.trim().startsWith("/")
      ? obj.path.trim()
      : "/";

  // parentBranch is only meaningful for a new component, and only when it names
  // a branch that actually exists; otherwise drop it (resolver falls back to main).
  let parentBranch: string | undefined;
  if (typeof obj.parentBranch === "string" && obj.parentBranch.trim()) {
    const candidate = obj.parentBranch.trim();
    if (existingBranchNames.has(candidate)) parentBranch = candidate;
  }

  const targetRaw = obj.screenshotTarget;
  let screenshotTarget: ScreenshotTarget = { mode: "full" };
  if (typeof targetRaw === "object" && targetRaw !== null) {
    const target = targetRaw as Record<string, unknown>;
    const mode = VALID_MODES.includes(target.mode as ScreenshotTarget["mode"])
      ? (target.mode as ScreenshotTarget["mode"])
      : "full";
    if (mode !== "full") {
      const value = typeof target.value === "string" ? target.value.trim() : "";
      if (value) {
        screenshotTarget = { mode, value };
      }
    }
  }

  return { component, parentBranch, summary, type, path, screenshotTarget };
}

function validate(raw: unknown, existingBranchNames: Set<string>): CommitAnalysis {
  if (typeof raw !== "object" || raw === null) return FALLBACK;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.components)) return FALLBACK;

  const components = obj.components
    .map((c) => validateComponent(c, existingBranchNames))
    .filter((c): c is ComponentChange => c !== null);

  if (components.length === 0) return FALLBACK;
  return { components };
}

export async function analyzeCommit({
  diff,
  commitMessage,
  siteContext,
  existingBranches,
}: {
  diff: string;
  commitMessage: string;
  siteContext?: PageContext[] | null;
  existingBranches?: BranchRecord[] | null;
}): Promise<CommitAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Falling back to full-page screenshot.");
    return FALLBACK;
  }

  const branches = existingBranches ?? [];
  const existingBranchNames = new Set(branches.map((b) => b.id));

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Commit message:\n${commitMessage}\n\n` +
            `Git diff:\n${diff}\n\n` +
            `${formatBranchTree(branches)}\n\n` +
            `UI CONTEXT (pages and the elements that exist on each — target ONLY these):\n` +
            `${formatSiteContext(siteContext)}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return FALLBACK;

    return validate(JSON.parse(content), existingBranchNames);
  } catch (err) {
    console.warn(
      "LLM analysis failed. Falling back to full-page screenshot.",
      err instanceof Error ? err.message : err
    );
    return FALLBACK;
  }
}
