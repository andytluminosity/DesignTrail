import path from "path";
import fse from "fs-extra";
import OpenAI from "openai";
import type { CommitType } from "./types.js";

// Vision-capable model used to read the captured screenshot and describe the
// change. gpt-4o-mini accepts image inputs and is the same family used for the
// text analysis pass in llm.ts.
const VISION_MODEL = "gpt-4o-mini";

// Bound the diff we feed per annotation call so a huge commit can't blow up the
// prompt (and cost). The diff is the source of truth for annotation scope; the
// image is supporting context for locating the changed UI.
const MAX_DIFF_CHARS = 16000;

/**
 * The annotation prompt is distilled from three design-annotation guides:
 *  - Figma, "The art and science of annotations in Dev Mode"
 *    (https://www.figma.com/blog/annotations-in-dev-mode/): annotations should
 *    capture the INTENT behind a design choice, not just the visual detail, and
 *    bridge the gap between design and code.
 *  - Balsamiq, "How to use wireframe annotations"
 *    (https://balsamiq.com/blog/wireframe-annotations/): be clear, concise,
 *    skimmable and actionable; only annotate where it adds value; document the
 *    WHY behind decisions.
 *  - uinkits, "Design annotations in UI design"
 *    (https://www.uinkits.com/foundations/design-annotations-ui-design):
 *    annotations communicate design rationale; prioritize key information and
 *    keep notes tied to the specific element.
 */
const SYSTEM_PROMPT = `You are a senior product designer writing concise annotations for ONE COMMIT CHANGE in a design-change tracker.

You are given: the screenshot image of a single component/area after a change, the component's name, a short summary of the change, the commit message, and the git diff.

CRITICAL SCOPE RULE: Annotate ONLY the UI element(s), copy, layout, state, or interaction that the COMMIT CHANGE actually added, removed, or modified. Treat the git diff and change summary as the source of truth. Treat the screenshot ONLY as visual context for finding the changed element and explaining its design effect. Do NOT annotate unchanged areas just because they are visible in the screenshot.

GOAL: Produce a set of short annotations that will later be SPLIT into separate sticky notes, where each sticky note labels a distinct changed section/element. Decompose the COMMIT CHANGE into its meaningful changed elements and write ONE short note per changed element.

For EACH distinct section/element changed by the commit (e.g. changed header text, newly added button, modified icon, updated input label, adjusted nav item, altered list row, spacing/layout region affected by the diff, or changed state), write a numbered block in EXACTLY this format:

[n] <Section/element label>
<Statement that fuses what the element is with the design rationale, e.g. "Green button helps the user feel comfortable." Lead with the element/change, then state the design effect or intent it serves (visual hierarchy, usability, accessibility, consistency, affordance, or user flow). Elaborate as much as needed on the design rationale.>

Rules:
- Base every note on the commit diff, commit message, or change summary. If an element is visible in the screenshot but not implicated by the commit change, omit it.
- When the screenshot shows a larger container around a smaller change, annotate the smaller changed element, not the whole container.
- If the commit change is a new nested component captured inside an ancestor screenshot, annotate the new or modified nested component only.
- If only one visual element changed, return exactly one numbered block.
- If the diff describes no locatable visual change in this screenshot, return exactly one block for the changed component/area described by the summary instead of inventorying the screenshot.
- Write each note as a single confident sentence. State it as fact — NEVER use hedging or uncertain words like "likely", "probably", "may", "might", "could", "perhaps", or "seems".
- Do NOT use separate "What:" / "Why:" labels. Combine the observation and the reason into one sentence.
- Be brief. Cut filler, restating the obvious, and exhaustive visual description (exact pixels, hex codes, font sizes). Keep only what matters: the element and the design value it delivers.
- Cover as many distinct changed sections/elements as are meaningfully present; prefer more granular blocks over fewer broad ones, since each becomes its own sticky note.
- Anchor each block to a concrete, locatable section/element so it can be placed precisely on the image later.
- Use the exact "[n] <label>" then one sentence on the next line for every block. No other headings, preamble, or markdown.`;

export type AnnotationInput = {
  outputPath: string;
  branchId: string;
  summary: string;
  type: CommitType | string;
  commitMessage: string;
  diff: string;
};

export type AnnotationResult = {
  outputPath: string;
  annotation: string;
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…(diff truncated)` : value;
}

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

async function annotateOne(
  client: OpenAI,
  input: AnnotationInput
): Promise<string> {
  const dataUrl = await toDataUrl(input.outputPath);
  if (!dataUrl) return input.summary;

  const userText =
    `Changed component/area: ${input.branchId || "main"}\n` +
    `Change type: ${input.type}\n` +
    `Change summary (annotation scope): ${input.summary}\n\n` +
    `Commit message:\n${input.commitMessage}\n\n` +
    `Git diff (source of truth for what changed):\n${truncate(input.diff, MAX_DIFF_CHARS)}\n\n` +
    `Screenshot instruction: use the attached screenshot only to locate and contextualize the changed element(s); do not annotate unchanged visible UI.`;

  const completion = await client.chat.completions.create({
    model: VISION_MODEL,
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

  const content = completion.choices[0]?.message?.content?.trim();
  return content || input.summary;
}

/**
 * Generates a unique design annotation for each captured screenshot using a
 * vision model. Calls run in parallel; any individual failure falls back to the
 * component's existing summary so a commit is never blocked. When no API key is
 * configured, every annotation falls back to its summary.
 */
export async function annotateScreenshots(
  inputs: AnnotationInput[]
): Promise<AnnotationResult[]> {
  if (inputs.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Skipping annotation; using summaries.");
    return inputs.map((i) => ({ outputPath: i.outputPath, annotation: i.summary }));
  }

  const client = new OpenAI({ apiKey });

  return Promise.all(
    inputs.map(async (input) => {
      try {
        const annotation = await annotateOne(client, input);
        return { outputPath: input.outputPath, annotation };
      } catch (err) {
        console.warn(
          `Annotation failed for ${input.outputPath}; using summary.`,
          err instanceof Error ? err.message : err
        );
        return { outputPath: input.outputPath, annotation: input.summary };
      }
    })
  );
}
