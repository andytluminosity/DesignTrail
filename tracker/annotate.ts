import path from "path";
import fse from "fs-extra";
import OpenAI from "openai";
import type { CommitType } from "./types.js";

// Vision-capable model used to read the captured screenshot and describe the
// change. gpt-4o-mini accepts image inputs and is the same family used for the
// text analysis pass in llm.ts.
const VISION_MODEL = "gpt-4o-mini";

// Bound the diff we feed per annotation call so a huge commit can't blow up the
// prompt (and cost). The image plus the per-component summary carry most of the
// signal; the diff is supporting context. Kept generous so the annotation can be
// as detailed as possible.
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
const SYSTEM_PROMPT = `You are a senior product designer writing a thorough, exhaustive annotation for ONE UI screenshot in a design-change tracker.

You are given: the screenshot image of a single component/area after a change, the component's name, a short summary of the change, the commit message, and the git diff. Annotate THIS component/screenshot.

GOAL: Produce ONE large, detailed annotation that will later be SPLIT into separate sticky notes, where each sticky note labels a distinct section/element of the screenshot. So decompose the screenshot into every meaningful section/element and annotate each one separately. Do not summarize the whole thing in a couple of sentences — be comprehensive.

For EACH distinct section/element visible in the screenshot (e.g. header, title, individual buttons, icons, inputs, labels, nav items, list rows, spacing/layout regions, states), write a numbered block in EXACTLY this format:

[n] <Section/element label>
What: <detailed description of this element and what changed or how it presents — grounded in the diff/summary and what you can see in the image. Be specific about text, color, size, position, spacing, iconography, and state.>
Why: <a hedged, plausible guess at the design rationale ("Likely to…", "Probably to…"). Reference relevant design principles — visual hierarchy, usability, accessibility, consistency, affordance, or user flow. Explain the intent, trade-offs, and who benefits.>

Rules:
- Cover as many distinct sections/elements as are meaningfully present; prefer more granular blocks over fewer broad ones, since each becomes its own sticky note.
- There are NO length limits. Be as detailed and complete as the screenshot warrants.
- Anchor each block to a concrete, locatable section/element so it can be placed precisely on the image later.
- Use the exact "[n] <label>" / "What:" / "Why:" structure for every block so the output can be parsed and split. No other headings, preamble, or markdown.`;

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
    `Component: ${input.branchId || "main"}\n` +
    `Change type: ${input.type}\n` +
    `Change summary: ${input.summary}\n\n` +
    `Commit message:\n${input.commitMessage}\n\n` +
    `Git diff:\n${truncate(input.diff, MAX_DIFF_CHARS)}`;

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
