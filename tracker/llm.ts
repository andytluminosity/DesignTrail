import OpenAI from "openai";
import type {
  CommitAnalysis,
  CommitType,
  LocatorSpec,
  PageContext,
  ScreenshotTarget,
} from "./types.js";

const MODEL = "gpt-4o-mini";

const FALLBACK: CommitAnalysis = {
  summary: "General layout change",
  type: "UNKNOWN",
  path: "/",
  screenshotTarget: { mode: "full" },
};

const VALID_TYPES: CommitType[] = ["UI_CHANGE", "FEATURE", "REFACTOR", "UNKNOWN"];
const VALID_MODES: ScreenshotTarget["mode"][] = ["full", "selector", "text", "role"];
const VALID_CAPTURE_MODES: LocatorSpec["mode"][] = ["selector", "text", "role"];

const SYSTEM_PROMPT = `You are a design-change analyzer for a git-based UI iteration tracker.
Given a commit message, its diff, and a snapshot of the LIVE rendered DOM for each
page of the app, decide:
1. A short human summary of what changed.
2. The change type: one of UI_CHANGE, FEATURE, REFACTOR, UNKNOWN.
3. Which page to navigate to and what part of the rendered UI to screenshot.

Respond with ONLY a JSON object in exactly this shape:
{
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

CRITICAL targeting rules:
- The "UI CONTEXT" section lists pages (as "PAGE <route>:") and, under each, the
  elements that ACTUALLY exist on that page. You MUST only target elements that
  appear there. NEVER invent a class, id, text, or role that is not present.
- "path" MUST be one of the listed PAGE routes — the page where the change is
  visible. Both the locate target and the capture target MUST exist on THAT page.
- "mode"/"value" describe how to LOCATE the changed element. Prefer "text" (exact
  visible text from the context) or "role" because they are the most robust. Use
  "selector" only when a class/id from the context clearly isolates the element.
- "capture" is OPTIONAL and describes the element to actually SCREENSHOT — normally
  the nearest containing component that fully frames the change (e.g. the whole
  card/panel/section), chosen from the SAME page's UI context. Omit "capture" to
  screenshot the located element itself.
- If no listed element clearly corresponds to the change, or the change is broad,
  non-visual, or unclear, or the UI CONTEXT is empty, set "path" to "/" and use
  mode "full" with no "capture".`;

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
          return `  - ${selector}${meta.length ? " " + meta.join(" ") : ""}`;
        })
        .join("\n");
      return `PAGE ${page.path}:\n${elements || "  (no elements)"}`;
    })
    .join("\n\n");
}

function validateCapture(raw: unknown): LocatorSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!VALID_CAPTURE_MODES.includes(obj.mode as LocatorSpec["mode"])) return undefined;
  const value = typeof obj.value === "string" ? obj.value.trim() : "";
  if (!value) return undefined;
  return { mode: obj.mode as LocatorSpec["mode"], value };
}

function validate(raw: unknown): CommitAnalysis {
  if (typeof raw !== "object" || raw === null) return FALLBACK;
  const obj = raw as Record<string, unknown>;

  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary : FALLBACK.summary;
  const type = VALID_TYPES.includes(obj.type as CommitType) ? (obj.type as CommitType) : "UNKNOWN";

  const path =
    typeof obj.path === "string" && obj.path.trim().startsWith("/")
      ? obj.path.trim()
      : "/";

  const targetRaw = obj.screenshotTarget;
  if (typeof targetRaw !== "object" || targetRaw === null) {
    return { summary, type, path, screenshotTarget: { mode: "full" } };
  }
  const target = targetRaw as Record<string, unknown>;
  const mode = VALID_MODES.includes(target.mode as ScreenshotTarget["mode"])
    ? (target.mode as ScreenshotTarget["mode"])
    : "full";

  if (mode === "full") {
    return { summary, type, path, screenshotTarget: { mode: "full" } };
  }

  const value = typeof target.value === "string" ? target.value.trim() : "";
  if (!value) {
    // Non-full mode requires a value; fall back to full page.
    return { summary, type, path, screenshotTarget: { mode: "full" } };
  }

  const capture = validateCapture(target.capture);

  return {
    summary,
    type,
    path,
    screenshotTarget: capture ? { mode, value, capture } : { mode, value },
  };
}

export async function analyzeCommit({
  diff,
  commitMessage,
  siteContext,
}: {
  diff: string;
  commitMessage: string;
  siteContext?: PageContext[] | null;
}): Promise<CommitAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Falling back to full-page screenshot.");
    return FALLBACK;
  }

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
            `UI CONTEXT (pages and the elements that exist on each — target ONLY these):\n` +
            `${formatSiteContext(siteContext)}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return FALLBACK;

    return validate(JSON.parse(content));
  } catch (err) {
    console.warn(
      "LLM analysis failed. Falling back to full-page screenshot.",
      err instanceof Error ? err.message : err
    );
    return FALLBACK;
  }
}
