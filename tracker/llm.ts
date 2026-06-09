import OpenAI from "openai";
import type {
  BranchRecord,
  CommitAnalysis,
  CommitType,
  ComponentChange,
  LocatorSpec,
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
const VALID_CAPTURE_MODES: LocatorSpec["mode"][] = ["selector", "text", "role"];

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
        "mode": "full" | "selector" | "text" | "role",
        "value": string (omit when mode is "full"),
        "capture": {
          "mode": "selector" | "text" | "role",
          "value": string
        }
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
- Concrete worked examples:
  - Logo text changes from "IT" to "ITQQ":
    { "component": "logo", "parentBranch": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "selector", "value": ".sidebar__logo" } }
  - A collapse toggle button is added to the sidebar:
    { "component": "sidebar", "type": "UI_CHANGE",
      "screenshotTarget": { "mode": "selector", "value": ".sidebar__collapse",
        "capture": { "mode": "selector", "value": ".sidebar" } } }

CRITICAL targeting rules:
- The "UI CONTEXT" section lists pages (as "PAGE <route>:") and, under each, the elements
  that ACTUALLY exist on that page. You MUST only target elements that appear there. NEVER
  invent a class, id, text, or role that is not present.
- For each component, "path" MUST be one of the listed PAGE routes — the page where that
  change is visible. Both the locate target and the capture target MUST exist on THAT page.
- "mode"/"value" describe how to LOCATE the changed element. Prefer "text" (exact visible
  text from the context) or "role" because they are the most robust. Use "selector" only when
  a class/id from the context clearly isolates the element.

CRITICAL capture-framing rules:
- "capture" describes the element to actually SCREENSHOT. NEVER screenshot a bare atomic
  control or a tiny text node in isolation (a lone button, a 1-6 character logo, a single
  icon) — the result is an unreadable crop with no context.
- Always frame the change in the smallest MEANINGFUL, self-contained containing component.
  When the located element is a tiny control, set "capture" to its containing component (use
  the element's "parent=" hint or an enclosing container present in the UI CONTEXT).
- For a change that RESTRUCTURES a container (e.g. a toggle added to the sidebar), set
  "capture" to the WHOLE container (e.g. { "mode": "selector", "value": ".sidebar" }).
- The "capture" selector/text/role MUST be an element present in the UI CONTEXT on that page.
- Omit "capture" only when the located element is itself already a meaningful, well-framed
  component.
- Emit one entry per distinct changed component. If the change is broad, non-visual, or
  unclear, or the UI CONTEXT is empty, return a SINGLE entry with "component": "", "path": "/"
  and mode "full" (no "capture").`;

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

function validateCapture(raw: unknown): LocatorSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!VALID_CAPTURE_MODES.includes(obj.mode as LocatorSpec["mode"])) return undefined;
  const value = typeof obj.value === "string" ? obj.value.trim() : "";
  if (!value) return undefined;
  return { mode: obj.mode as LocatorSpec["mode"], value };
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
        const capture = validateCapture(target.capture);
        screenshotTarget = capture ? { mode, value, capture } : { mode, value };
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
