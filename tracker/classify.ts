import path from "path";
import fse from "fs-extra";
import OpenAI from "openai";

// Vision-capable model (image inputs supported), matching the rest of the
// DesignTrail LLM passes.
const VISION_MODEL = "gpt-4o-mini";

// Group name used when classification can't run (no API key) or fails, so a
// component still lands in the library view instead of being dropped.
const FALLBACK_GROUP = "Uncategorized";

export type ClassifyComponentInput = {
  // Absolute path to the component's latest screenshot.
  screenshotPath: string;
  // Human-readable component label (from its DOM identity), used as a hint.
  label?: string;
  // Existing group names already in the library, so the model reuses one when it
  // fits instead of inventing near-duplicates.
  existingGroups: string[];
};

const SYSTEM_PROMPT = `You classify UI components into reusable component-library groups (like "Buttons", "Menus", "Cards", "Sidebars", "Topbars", "Inputs", "Modals", "Tables", "Navigation").

You are given a screenshot of ONE UI component, an optional label, and the list of groups that already exist. Decide which group this component belongs to.

Rules:
- If the component clearly fits an EXISTING group, reuse that exact group name (match it character-for-character).
- Otherwise, propose a concise, generic, Title Case group name for the component TYPE (e.g. "Buttons", "Cards"). Prefer plural nouns. Never invent a name tied to specific content/text.
- Group by visual/structural component type, not by page or feature.

Respond with ONLY a JSON object in exactly this shape:
{ "group": string }`;

/** Reads a PNG and encodes it as a data URL the vision API can ingest. */
async function toDataUrl(absPath: string): Promise<string | null> {
  try {
    const buf = await fse.readFile(absPath);
    const ext = path.extname(absPath).slice(1).toLowerCase() || "png";
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Picks the nearest existing group name case-insensitively, else the raw name. */
function reconcileGroup(raw: string, existingGroups: string[]): string {
  const trimmed = raw.trim();
  if (!trimmed) return FALLBACK_GROUP;
  const match = existingGroups.find(
    (group) => group.toLowerCase() === trimmed.toLowerCase()
  );
  return match ?? trimmed;
}

/**
 * Classifies a single component into a library group via a vision call, reusing
 * an existing group name when the component fits one. Falls back to
 * "Uncategorized" when no API key is configured or the call fails, so a commit
 * is never blocked.
 */
export async function classifyComponent(
  input: ClassifyComponentInput
): Promise<{ groupName: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Skipping component classification.");
    return { groupName: FALLBACK_GROUP };
  }

  const dataUrl = await toDataUrl(input.screenshotPath);
  if (!dataUrl) return { groupName: FALLBACK_GROUP };

  const existingList =
    input.existingGroups.length > 0
      ? input.existingGroups.map((g) => `- ${g}`).join("\n")
      : "(none yet)";
  const userText =
    `Component label: ${input.label || "(unknown)"}\n\n` +
    `Existing groups (reuse one if it fits):\n${existingList}`;

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: VISION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return { groupName: FALLBACK_GROUP };
    const parsed = JSON.parse(content) as { group?: unknown };
    const group = typeof parsed.group === "string" ? parsed.group : "";
    return { groupName: reconcileGroup(group, input.existingGroups) };
  } catch (err) {
    console.warn(
      "Component classification failed; using fallback group.",
      err instanceof Error ? err.message : err
    );
    return { groupName: FALLBACK_GROUP };
  }
}
