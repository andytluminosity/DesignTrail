import OpenAI from "openai";
import type { AnnotationPlacement } from "./annotationPlacement.js";
import type { BranchRecord, IterationNode } from "../tracker/types.js";

// Text-reasoning model used to propose a tree layout. Mirrors the model family
// used by the other LLM passes (tracker/annotate.ts, miro/annotationPlacement.ts)
// so configuration stays consistent.
const LAYOUT_MODEL = "gpt-4o-mini";

// Display width (board units) every screenshot renders at. Height is derived
// from the PNG's real aspect ratio. Shared with miroClient so footprint math and
// the actual draw agree.
export const IMAGE_W = 600;
export const DEFAULT_IMAGE_ASPECT = 0.66; // height/width fallback when dims unknown
// Approximate on-board footprint of a sticky note.
export const STICKY_W = 200;
export const STICKY_H = 200;
// Gap between the image edge and the band of sticky notes, and between adjacent
// notes sharing an edge.
export const NOTE_MARGIN = 90;
export const NOTE_GAP = 28;

// Spacing used by the deterministic tidy-tree fallback: horizontal gap between
// sibling clusters/subtrees and vertical gap between a branch row and its
// children.
const H_GAP = 140;
const V_GAP = 180;

// Minimum clear separation required between any two cluster boxes for an
// LLM-proposed layout to be accepted.
const MIN_GAP = 24;

// Above this many nodes we skip the LLM (token/cost blowup, and the deterministic
// layout is reliable) and go straight to the tidy-tree fallback.
const MAX_LLM_NODES = 40;

export type MiroPosition = { x: number; y: number };
export type MiroRelativePosition = { x: string; y: string };
type Edge = "left" | "right" | "top" | "bottom";

export type StickyLayoutItem = {
  index: number;
  position: MiroPosition;
  // Relative endpoint on the image (e.g. "42%") the connector points at.
  anchor: { x: string; y: string };
};

// The on-board bounding box of one screenshot cluster (image + header note +
// per-element annotation notes), plus where the image's CENTER sits relative to
// the box's top-left corner so the renderer can place the image from the box.
export type ClusterFootprint = {
  width: number;
  height: number;
  imageCenterOffset: MiroPosition;
  imageH: number;
};

// One screenshot's layout box: the node id plus its cluster size and the image
// center offset within that box.
export type NodeBox = {
  id: string;
  width: number;
  height: number;
  imageCenterOffset: MiroPosition;
};

// nodeId -> cluster box top-left position on the board.
export type LayoutResult = Map<string, MiroPosition>;

/**
 * Given an image's center and on-board size, lays each annotation out in the
 * margin nearest its element. Notes are bucketed by the closest edge, then
 * spaced apart along that edge so they don't overlap, while staying aligned to
 * the element they describe. Each item also carries the relative point on the
 * image (e.g. "42%") a connector should point at. Shared by the renderer (to
 * draw notes) and by computeClusterFootprint (to size the cluster).
 */
export function computeStickyLayout(
  imageCenter: MiroPosition,
  imageW: number,
  imageH: number,
  placements: AnnotationPlacement[]
): StickyLayoutItem[] {
  const left = imageCenter.x - imageW / 2;
  const top = imageCenter.y - imageH / 2;
  const right = left + imageW;
  const bottom = top + imageH;

  type Item = {
    index: number;
    edge: Edge;
    anchorAbs: MiroPosition;
    anchorRel: MiroRelativePosition;
  };

  const items: Item[] = placements.map((placement) => {
    const anchorAbs: MiroPosition = {
      x: left + placement.x * imageW,
      y: top + placement.y * imageH,
    };
    const distances: Record<Edge, number> = {
      left: placement.x,
      right: 1 - placement.x,
      top: placement.y,
      bottom: 1 - placement.y,
    };
    const edge = (Object.keys(distances) as Edge[]).reduce((best, candidate) =>
      distances[candidate] < distances[best] ? candidate : best
    );
    return {
      index: placement.index,
      edge,
      anchorAbs,
      anchorRel: {
        x: `${(placement.x * 100).toFixed(2)}%`,
        y: `${(placement.y * 100).toFixed(2)}%`,
      },
    };
  });

  const result: StickyLayoutItem[] = [];

  for (const edge of ["left", "right", "top", "bottom"] as Edge[]) {
    const group = items.filter((item) => item.edge === edge);
    if (group.length === 0) continue;

    const vertical = edge === "left" || edge === "right";
    group.sort((a, b) =>
      vertical ? a.anchorAbs.y - b.anchorAbs.y : a.anchorAbs.x - b.anchorAbs.x
    );

    const minSpacing = vertical ? STICKY_H + NOTE_GAP : STICKY_W + NOTE_GAP;

    // Fixed cross-axis coordinate of this edge's note band.
    let bandX = imageCenter.x;
    let bandY = imageCenter.y;
    if (edge === "left") bandX = left - NOTE_MARGIN - STICKY_W / 2;
    if (edge === "right") bandX = right + NOTE_MARGIN + STICKY_W / 2;
    if (edge === "top") bandY = top - NOTE_MARGIN - STICKY_H / 2;
    if (edge === "bottom") bandY = bottom + NOTE_MARGIN + STICKY_H / 2;

    let previous = -Infinity;
    for (const item of group) {
      if (vertical) {
        const y = Math.max(item.anchorAbs.y, previous + minSpacing);
        previous = y;
        result.push({ index: item.index, position: { x: bandX, y }, anchor: item.anchorRel });
      } else {
        const x = Math.max(item.anchorAbs.x, previous + minSpacing);
        previous = x;
        result.push({ index: item.index, position: { x, y: bandY }, anchor: item.anchorRel });
      }
    }
  }

  return result;
}

/**
 * Computes the full on-board bounding box of one screenshot cluster: the image,
 * its diagonally-offset header note, and every per-element annotation note.
 * Coordinates are computed with the image centered at the origin, then collapsed
 * to width/height plus the image-center offset from the box's top-left corner.
 */
export function computeClusterFootprint(
  imageH: number,
  placements: AnnotationPlacement[]
): ClusterFootprint {
  const center: MiroPosition = { x: 0, y: 0 };
  const layout = computeStickyLayout(center, IMAGE_W, imageH, placements);

  type Rect = { x: number; y: number; w: number; h: number };
  const rects: Rect[] = [];

  // Image, centered at the origin.
  rects.push({ x: -IMAGE_W / 2, y: -imageH / 2, w: IMAGE_W, h: imageH });

  // Header note: placed diagonally off the image's top-left corner.
  const left = -IMAGE_W / 2;
  const top = -imageH / 2;
  rects.push({
    x: left - NOTE_MARGIN - STICKY_W,
    y: top - NOTE_MARGIN - STICKY_H,
    w: STICKY_W,
    h: STICKY_H,
  });

  // Per-element annotation notes.
  for (const item of layout) {
    rects.push({
      x: item.position.x - STICKY_W / 2,
      y: item.position.y - STICKY_H / 2,
      w: STICKY_W,
      h: STICKY_H,
    });
  }

  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));

  return {
    width: maxX - minX,
    height: maxY - minY,
    imageCenterOffset: { x: -minX, y: -minY },
    imageH,
  };
}

// The branch tree shape the layout works over: each branch with its
// chronological screenshot boxes and its child branches.
type BranchLayout = {
  branchId: string;
  boxes: NodeBox[];
  children: BranchLayout[];
};

function groupNodesByBranch(nodes: IterationNode[]): Map<string, IterationNode[]> {
  const map = new Map<string, IterationNode[]>();
  for (const node of nodes) {
    const list = map.get(node.branchId) ?? [];
    list.push(node);
    map.set(node.branchId, list);
  }
  return map;
}

/**
 * Builds the branch tree (roots first, then nested by parent_branch_id), keeping
 * each branch's screenshots in chronological (export) order. Branches whose
 * parent isn't present are treated as roots. `main` is floated to the front of
 * the root list so the tree reads from the page root down.
 */
function buildBranchTree(
  branches: BranchRecord[],
  nodesByBranch: Map<string, IterationNode[]>,
  boxById: Map<string, NodeBox>
): BranchLayout[] {
  const ids = new Set(branches.map((b) => b.id));
  const childrenOf = new Map<string, BranchRecord[]>();
  const roots: BranchRecord[] = [];

  for (const branch of branches) {
    if (branch.parentBranchId && ids.has(branch.parentBranchId)) {
      const list = childrenOf.get(branch.parentBranchId) ?? [];
      list.push(branch);
      childrenOf.set(branch.parentBranchId, list);
    } else {
      roots.push(branch);
    }
  }

  const build = (branch: BranchRecord): BranchLayout => {
    const boxes = (nodesByBranch.get(branch.id) ?? [])
      .map((node) => boxById.get(node.id))
      .filter((box): box is NodeBox => box !== undefined);
    const kids = (childrenOf.get(branch.id) ?? [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(build);
    return { branchId: branch.id, boxes, children: kids };
  };

  const sortRoots = (a: BranchRecord, b: BranchRecord): number => {
    if (a.id === "main") return -1;
    if (b.id === "main") return 1;
    return a.id.localeCompare(b.id);
  };

  return roots.sort(sortRoots).map(build);
}

function stripWidth(branch: BranchLayout): number {
  if (branch.boxes.length === 0) return 0;
  const total = branch.boxes.reduce((sum, box) => sum + box.width, 0);
  return total + (branch.boxes.length - 1) * H_GAP;
}

function stripHeight(branch: BranchLayout): number {
  return branch.boxes.reduce((max, box) => Math.max(max, box.height), 0);
}

function childrenWidth(branch: BranchLayout): number {
  if (branch.children.length === 0) return 0;
  const total = branch.children.reduce((sum, child) => sum + subtreeWidth(child), 0);
  return total + (branch.children.length - 1) * H_GAP;
}

function subtreeWidth(branch: BranchLayout): number {
  return Math.max(stripWidth(branch), childrenWidth(branch));
}

/**
 * Places a branch subtree: the branch's own screenshots form a horizontal row
 * (chronological, left-to-right) centered within the subtree's width, and each
 * child branch is laid out below, left-to-right. Subtree widths are computed
 * bottom-up so sibling subtrees never collide, which guarantees no two cluster
 * boxes overlap.
 */
function placeSubtree(
  branch: BranchLayout,
  originX: number,
  originY: number,
  out: LayoutResult
): void {
  const totalWidth = subtreeWidth(branch);
  const ownWidth = stripWidth(branch);
  const ownHeight = stripHeight(branch);

  let x = originX + (totalWidth - ownWidth) / 2;
  for (const box of branch.boxes) {
    out.set(box.id, { x, y: originY });
    x += box.width + H_GAP;
  }

  const childY = originY + ownHeight + (ownHeight > 0 ? V_GAP : 0);
  const kidsWidth = childrenWidth(branch);
  let childX = originX + (totalWidth - kidsWidth) / 2;
  for (const child of branch.children) {
    placeSubtree(child, childX, childY, out);
    childX += subtreeWidth(child) + H_GAP;
  }
}

/**
 * Deterministic tidy-tree layout: lays each root subtree left-to-right at the
 * top, recursively nesting child branches below their parent. Always produces a
 * non-overlapping tree, used as the guaranteed fallback when no LLM layout is
 * available or the LLM's layout fails validation.
 */
export function tidyTreeLayout(roots: BranchLayout[]): LayoutResult {
  const out: LayoutResult = new Map();
  let originX = 0;
  for (const root of roots) {
    placeSubtree(root, originX, 0, out);
    originX += subtreeWidth(root) + H_GAP;
  }
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

/** Collects the box ids contained in a branch subtree (own boxes + descendants). */
function subtreeBoxIds(branch: BranchLayout): string[] {
  const ids = branch.boxes.map((box) => box.id);
  for (const child of branch.children) ids.push(...subtreeBoxIds(child));
  return ids;
}

/**
 * Accepts an LLM layout only when it is complete (one position per box), free of
 * overlaps (boxes separated by at least MIN_GAP), keeps each branch's
 * screenshots in left-to-right chronological order, and places every child
 * branch strictly below its parent's row. Otherwise the deterministic layout is
 * used so the tree always reads cleanly with nothing overlapping.
 */
function validateLayout(
  layout: LayoutResult,
  boxById: Map<string, NodeBox>,
  roots: BranchLayout[]
): boolean {
  for (const id of boxById.keys()) {
    if (!layout.has(id)) return false;
  }

  const entries = [...boxById.entries()];
  const rects: Rect[] = entries.map(([id, box]) => {
    const pos = layout.get(id)!;
    return { x: pos.x, y: pos.y, w: box.width, h: box.height };
  });
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i], rects[j], MIN_GAP)) return false;
    }
  }

  const checkBranch = (branch: BranchLayout): boolean => {
    // Chronological order: each screenshot starts to the right of the previous.
    for (let i = 1; i < branch.boxes.length; i += 1) {
      const prev = layout.get(branch.boxes[i - 1].id)!;
      const curr = layout.get(branch.boxes[i].id)!;
      if (curr.x < prev.x) return false;
    }

    // Children sit strictly below this branch's own row.
    if (branch.boxes.length > 0) {
      const ownBottom = Math.max(
        ...branch.boxes.map((box) => layout.get(box.id)!.y + box.height)
      );
      for (const child of branch.children) {
        const childIds = subtreeBoxIds(child);
        for (const id of childIds) {
          if (layout.get(id)!.y < ownBottom) return false;
        }
      }
    }

    return branch.children.every(checkBranch);
  };

  return roots.every(checkBranch);
}

const LAYOUT_SYSTEM_PROMPT = `You are a layout engine that positions screenshot clusters on an infinite 2D canvas to form a clean top-down tree.

You are given a forest of component branches. Each branch has an ordered list of screenshots (chronological, oldest first) and may have child branches. Each screenshot is a rectangle ("box") with a given width and height.

Assign a top-left (x, y) position to every box so that:
- A branch's own screenshots form a single horizontal row, left-to-right in the given order.
- Every child branch is placed BELOW its parent branch's row.
- No two boxes overlap; leave at least the given gap of empty space between any two boxes (account for each box's width and height).
- The overall result reads as a tidy top-down tree: parents above children, siblings spread horizontally.

Return STRICT JSON in exactly this shape, one entry per box id:
{ "positions": [ { "id": "<box id>", "x": <number>, "y": <number> } ] }

Rules:
- Output ONLY the JSON object. No prose, no markdown.
- Include every box id you were given exactly once.
- x grows right, y grows down. Any numeric coordinates are fine.`;

type LayoutSpecBranch = {
  branch: string;
  nodes: string[];
  children: LayoutSpecBranch[];
};

function toSpec(branch: BranchLayout): LayoutSpecBranch {
  return {
    branch: branch.branchId,
    nodes: branch.boxes.map((box) => box.id),
    children: branch.children.map(toSpec),
  };
}

async function tryLlmLayout(
  roots: BranchLayout[],
  boxById: Map<string, NodeBox>
): Promise<LayoutResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (boxById.size === 0 || boxById.size > MAX_LLM_NODES) return null;

  const spec = {
    gap: MIN_GAP,
    boxes: Object.fromEntries(
      [...boxById.entries()].map(([id, box]) => [
        id,
        { w: Math.round(box.width), h: Math.round(box.height) },
      ])
    ),
    tree: roots.map(toSpec),
  };

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: LAYOUT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: LAYOUT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Position these screenshot clusters into a tree:\n${JSON.stringify(spec)}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      positions?: Array<{ id?: unknown; x?: unknown; y?: unknown }>;
    };
    if (!Array.isArray(parsed.positions)) return null;

    const layout: LayoutResult = new Map();
    for (const raw of parsed.positions) {
      const id = typeof raw.id === "string" ? raw.id : null;
      const x = Number(raw.x);
      const y = Number(raw.y);
      if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!boxById.has(id)) continue;
      layout.set(id, { x, y });
    }
    return layout;
  } catch {
    return null;
  }
}

/**
 * Plans where every screenshot cluster sits on the board so they assemble into a
 * non-overlapping component tree. An LLM proposes positions first (honoring the
 * "use an LLM to determine the locations" intent); the proposal is accepted only
 * if it is complete, tree-shaped, and overlap-free, otherwise a deterministic
 * tidy-tree layout is used so the result is always clean.
 */
export async function planTreeLayout(
  branches: BranchRecord[],
  nodes: IterationNode[],
  boxes: NodeBox[]
): Promise<LayoutResult> {
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const nodesByBranch = groupNodesByBranch(nodes);
  const roots = buildBranchTree(branches, nodesByBranch, boxById);

  const llm = await tryLlmLayout(roots, boxById);
  if (llm && validateLayout(llm, boxById, roots)) {
    return llm;
  }

  return tidyTreeLayout(roots);
}
