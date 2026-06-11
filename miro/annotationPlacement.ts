import path from "path";
import fse from "fs-extra";
import OpenAI from "openai";

// Vision-capable model used to read the captured screenshot and decide where
// each annotation sticky note should sit. Mirrors the model used in
// tracker/annotate.ts so the two passes stay consistent.
const VISION_MODEL = "gpt-4o-mini";

// One parsed annotation block: a numbered "[n] <label>" header plus the
// single-sentence rationale that follows it. `text` is the full block content
// (label line + sentence) used verbatim as the sticky note body.
export type AnnotationBlock = {
  index: number;
  label: string;
  text: string;
};

export type AnnotationVisual = "text" | "sticky";

// Normalized location of an annotation's target element on the screenshot,
// where x/y are in [0, 1] relative to the image's top-left corner.
export type AnnotationPlacement = {
  index: number;
  x: number;
  y: number;
};

export type AnnotationMarkPlan = AnnotationPlacement & {
  visual: AnnotationVisual;
  labelText?: string;
};

export type ImageDimensions = {
  width: number;
  height: number;
};

/**
 * Splits an annotation string into its numbered "[n] <label>" blocks. Each
 * block becomes one sticky note. When the annotation has no "[n]" markers (e.g.
 * it fell back to a plain summary), the whole string is returned as a single
 * block so it still lands on the board.
 */
export function parseAnnotationBlocks(annotation: string): AnnotationBlock[] {
  const trimmed = annotation.trim();
  if (!trimmed) return [];

  // Split on each "[n]" marker that starts a line, keeping the marker with its
  // block. The first segment before any marker is discarded (it is normally
  // empty preamble).
  const markerRe = /(^|\n)\[(\d+)\]\s*/g;
  const matches: { index: number; start: number; contentStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(trimmed)) !== null) {
    matches.push({
      index: Number(match[2]),
      start: match.index,
      contentStart: markerRe.lastIndex,
    });
  }

  if (matches.length === 0) {
    const [first, ...rest] = trimmed.split("\n");
    return [{ index: 1, label: first.trim() || trimmed, text: trimmed }];
  }

  const blocks: AnnotationBlock[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const blockBody = trimmed
      .slice(current.contentStart, next ? next.start : undefined)
      .trim();
    if (!blockBody) continue;

    const [labelLine, ...bodyLines] = blockBody.split("\n");
    const label = labelLine.trim();
    const sentence = bodyLines.join("\n").trim();
    const text = sentence ? `${label}\n${sentence}` : label;
    blocks.push({ index: current.index, label, text });
  }

  return blocks;
}

/**
 * Reads the pixel width/height of a PNG from its IHDR chunk without decoding the
 * image (and without adding an image dependency). PNG layout: 8-byte signature,
 * then the IHDR chunk whose width/height are big-endian 4-byte integers at byte
 * offsets 16 and 20. Returns null if the file isn't a readable PNG.
 */
export async function readPngDimensions(
  absPath: string
): Promise<ImageDimensions | null> {
  try {
    const fd = await fse.open(absPath, "r");
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await fse.read(fd, header, 0, 24, 0);
      if (bytesRead < 24) return null;
      // PNG signature check.
      const signature = header.subarray(0, 8).toString("hex");
      if (signature !== "89504e470d0a1a0a") return null;
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (!width || !height) return null;
      return { width, height };
    } finally {
      await fse.close(fd);
    }
  } catch {
    return null;
  }
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

const ANNOTATION_MARK_SYSTEM_PROMPT = `You are planning design annotations for a Miro design review board.

You are given a UI screenshot and a numbered list of annotations, each describing one element/section of that screenshot.

For EACH annotation:
1. Locate the element it describes on the screenshot. Return normalized x/y floats in [0, 1] relative to the screenshot's top-left corner (x grows right, y grows down). Use the CENTER of the element the annotation is about.
2. Decide whether it should render as:
   - "text": a direct label or factual callout attached to a UI element. Use this for short, descriptive observations such as what changed, what an element is, or where something moved.
   - "sticky": a review/comment note. Use this for opinions, rationale, concerns, questions, recommendations, tradeoffs, TODOs, or anything that reads like feedback from a reviewer.

Return STRICT JSON in exactly this shape, with one entry per annotation index given to you:
{ "annotations": [ { "index": <number>, "x": <number 0..1>, "y": <number 0..1>, "visual": "text" | "sticky", "labelText": "<short label when visual is text>" } ] }

Rules:
- Output ONLY the JSON object. No prose, no markdown.
- Include every index you were given exactly once.
- Use only "text" or "sticky" for visual.
- If you cannot locate an element, estimate the most plausible position; never omit an index.
- Prefer "text" for concise element labels and factual change descriptions.
- Prefer "sticky" for longer explanations, subjective judgments, risks, open questions, or action items.
- When visual is "text", write labelText as a label, not a sentence or paragraph: 2-5 words, under 40 characters, no trailing period.
- labelText should name the changed element/state directly, e.g. "CTA moved up", "New filter pill", or "Denser card spacing".
- When visual is "sticky", omit labelText or leave it empty.
- If unsure, choose "sticky" because ambiguous review content should remain comment-like.`;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function isAnnotationVisual(value: unknown): value is AnnotationVisual {
  return value === "text" || value === "sticky";
}

function normalizeLabelText(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback.trim();
  const firstLine = raw.split("\n")[0]?.trim() ?? "";
  const withoutTrailingPunctuation = firstLine.replace(/[.!?]+$/g, "");
  const words = withoutTrailingPunctuation.split(/\s+/).filter(Boolean).slice(0, 5);
  const shortened = words.join(" ");
  return shortened.length > 40 ? `${shortened.slice(0, 37).trimEnd()}...` : shortened;
}

/**
 * Asks one vision model call to both locate each annotation block on the
 * screenshot and choose whether it should render as label text or a sticky note.
 * Returns null on failures so callers can fall back to a single combined note.
 */
export async function placeAnnotations(
  absPngPath: string,
  blocks: AnnotationBlock[]
): Promise<AnnotationMarkPlan[] | null> {
  if (blocks.length === 0) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const dataUrl = await toDataUrl(absPngPath);
  if (!dataUrl) return null;

  const blockList = blocks
    .map((block) => `[${block.index}] ${block.text}`)
    .join("\n\n");

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: VISION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANNOTATION_MARK_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Plan these ${blocks.length} annotation mark(s) on the screenshot:\n${blockList}`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      annotations?: Array<{
        index?: unknown;
        x?: unknown;
        y?: unknown;
        visual?: unknown;
        labelText?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.annotations)) return null;

    const byIndex = new Map<number, AnnotationMarkPlan>();
    for (const raw of parsed.annotations) {
      const index = Number(raw.index);
      const x = Number(raw.x);
      const y = Number(raw.y);
      if (!Number.isFinite(index)) continue;
      const visual = isAnnotationVisual(raw.visual) ? raw.visual : "sticky";
      byIndex.set(index, {
        index,
        x: clamp01(x),
        y: clamp01(y),
        visual,
        labelText:
          visual === "text" ? normalizeLabelText(raw.labelText, "") : undefined,
      });
    }

    // Guarantee one mark plan per block; fill any gaps with a safe center
    // estimate and sticky-note default.
    return blocks.map((block) => {
      const plan = byIndex.get(block.index);
      const visual = plan?.visual ?? "sticky";
      return {
        index: block.index,
        x: plan?.x ?? 0.5,
        y: plan?.y ?? 0.5,
        visual,
        labelText:
          visual === "text"
            ? normalizeLabelText(plan?.labelText, block.label)
            : undefined,
      };
    });
  } catch {
    return null;
  }
}
