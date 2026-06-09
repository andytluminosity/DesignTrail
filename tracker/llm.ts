import OpenAI from "openai";
import type { CommitAnalysis, CommitType, ScreenshotTarget } from "./types.js";

const MODEL = "gpt-4o-mini";

const FALLBACK: CommitAnalysis = {
  summary: "General layout change",
  type: "UNKNOWN",
  screenshotTarget: { mode: "full" },
};

const VALID_TYPES: CommitType[] = ["UI_CHANGE", "FEATURE", "REFACTOR", "UNKNOWN"];
const VALID_MODES: ScreenshotTarget["mode"][] = ["full", "selector", "text", "role"];

const SYSTEM_PROMPT = `You are a design-change analyzer for a git-based UI iteration tracker.
Given a commit message and its diff, decide:
1. A short human summary of what changed.
2. The change type: one of UI_CHANGE, FEATURE, REFACTOR, UNKNOWN.
3. What part of the rendered UI is most worth screenshotting.

Respond with ONLY a JSON object in exactly this shape:
{
  "summary": string,
  "type": "UI_CHANGE" | "FEATURE" | "REFACTOR" | "UNKNOWN",
  "screenshotTarget": {
    "mode": "full" | "selector" | "text" | "role",
    "value": string (omit when mode is "full")
  }
}

Guidance:
- Use "selector" with a CSS selector (e.g. ".sidebar", "#header") when the diff clearly targets a specific element/class.
- Use "text" with visible text when a labeled element is the focus.
- Use "role" with an ARIA role (e.g. "navigation", "button") when a semantic region is the focus.
- Use "full" when the change is broad, non-visual, or unclear.`;

function validate(raw: unknown): CommitAnalysis {
  if (typeof raw !== "object" || raw === null) return FALLBACK;
  const obj = raw as Record<string, unknown>;

  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary : FALLBACK.summary;
  const type = VALID_TYPES.includes(obj.type as CommitType) ? (obj.type as CommitType) : "UNKNOWN";

  const targetRaw = obj.screenshotTarget;
  if (typeof targetRaw !== "object" || targetRaw === null) {
    return { summary, type, screenshotTarget: { mode: "full" } };
  }
  const target = targetRaw as Record<string, unknown>;
  const mode = VALID_MODES.includes(target.mode as ScreenshotTarget["mode"])
    ? (target.mode as ScreenshotTarget["mode"])
    : "full";

  if (mode === "full") {
    return { summary, type, screenshotTarget: { mode: "full" } };
  }

  const value = typeof target.value === "string" ? target.value.trim() : "";
  if (!value) {
    // Non-full mode requires a value; fall back to full page.
    return { summary, type, screenshotTarget: { mode: "full" } };
  }

  return { summary, type, screenshotTarget: { mode, value } };
}

export async function analyzeCommit({
  diff,
  commitMessage,
}: {
  diff: string;
  commitMessage: string;
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
          content: `Commit message:\n${commitMessage}\n\nGit diff:\n${diff}`,
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
