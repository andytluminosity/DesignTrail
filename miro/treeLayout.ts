import type { AnnotationPlacement } from "./annotationPlacement.js";
import type { BranchRecord, IterationNode } from "../tracker/types.js";

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

// Spacing used by the layered tidy-tree layout: horizontal gap between sibling
// clusters/subtrees and vertical gap between adjacent level bands.
const H_GAP = 140;
const V_GAP = 180;

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
 * image (e.g. "42%") a connector should point at. Used by the renderer to draw
 * the annotation notes inside each node box's reserved annotation border.
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
 * Sizes one screenshot's node box as a UNIFORM annotation-padded container:
 * the image plus a full border wide/tall enough for a band of sticky notes on
 * every side (worst case: the entire border populated with annotations). This is
 * independent of where annotations actually land, so every node box is regular
 * and the tree lays out cleanly. The reserved border also accommodates the
 * diagonally-offset header note in the top-left corner. The image is centered in
 * the box, so the box center coincides with the image center and aligning boxes
 * on a level aligns the screenshots. `imageH` still comes from the PNG aspect
 * ratio, so box heights vary per node while widths are constant.
 */
export function computeClusterFootprint(imageH: number): ClusterFootprint {
  const padX = NOTE_MARGIN + STICKY_W;
  const padY = NOTE_MARGIN + STICKY_H;
  return {
    width: IMAGE_W + 2 * padX,
    height: imageH + 2 * padY,
    imageCenterOffset: { x: padX + IMAGE_W / 2, y: padY + imageH / 2 },
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

  // Child branches are ordered by creation time (then id) so the tree is
  // deterministic and reads left-to-right in the order components forked.
  const byCreatedThenId = (a: BranchRecord, b: BranchRecord): number =>
    a.createdAt - b.createdAt || a.id.localeCompare(b.id);

  const build = (branch: BranchRecord): BranchLayout => {
    // A branch's drawable screenshots form one chronological row on a single
    // level (export order = chronological). Collapsed/unrenderable nodes have no
    // box and are dropped; child branches still attach below regardless.
    const boxes = (nodesByBranch.get(branch.id) ?? [])
      .map((node) => boxById.get(node.id))
      .filter((box): box is NodeBox => box !== undefined);
    const kids = (childrenOf.get(branch.id) ?? [])
      .slice()
      .sort(byCreatedThenId)
      .map(build);
    return { branchId: branch.id, boxes, children: kids };
  };

  const sortRoots = (a: BranchRecord, b: BranchRecord): number => {
    if (a.id === "main") return -1;
    if (b.id === "main") return 1;
    return byCreatedThenId(a, b);
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

// Floor for a level band whose branches are all empty, so a level never
// collapses to zero height and parents always sit clearly above children.
const MIN_LEVEL_HEIGHT = IMAGE_W * DEFAULT_IMAGE_ASPECT;

/**
 * Visits every branch in the forest with its depth (roots at 0, children at
 * depth+1), so callers can bucket branches into global levels.
 */
function forEachBranchWithDepth(
  roots: BranchLayout[],
  visit: (branch: BranchLayout, depth: number) => void
): void {
  const walk = (branch: BranchLayout, depth: number): void => {
    visit(branch, depth);
    for (const child of branch.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}

/**
 * Computes a global Y band per tree depth: `levelHeight[d]` is the tallest
 * branch row at depth `d` (floored so empty levels don't collapse), and
 * `levelTop[d]` is that band's top, stacked so band `d` sits entirely above band
 * `d+1`. This makes every branch at the same depth share one horizontal band.
 */
function computeLevelBands(roots: BranchLayout[]): {
  levelTop: number[];
  levelHeight: number[];
} {
  const levelHeight: number[] = [];
  forEachBranchWithDepth(roots, (branch, depth) => {
    const h = stripHeight(branch);
    levelHeight[depth] = Math.max(levelHeight[depth] ?? 0, h);
  });
  for (let d = 0; d < levelHeight.length; d += 1) {
    levelHeight[d] = Math.max(levelHeight[d] ?? 0, MIN_LEVEL_HEIGHT);
  }

  const levelTop: number[] = [];
  let y = 0;
  for (let d = 0; d < levelHeight.length; d += 1) {
    levelTop[d] = y;
    y += levelHeight[d] + V_GAP;
  }
  return { levelTop, levelHeight };
}

/**
 * Places a branch subtree: the branch's own screenshots form a horizontal row
 * (chronological, left-to-right) centered within the subtree's width, with each
 * box vertically centered inside its depth's global level band. Child branches
 * are laid out below, left-to-right. Subtree widths are computed bottom-up so
 * sibling subtrees never collide, and the Y comes from the shared level bands so
 * every branch at the same depth lines up on one horizontal band.
 */
function placeSubtree(
  branch: BranchLayout,
  originX: number,
  depth: number,
  levelTop: number[],
  levelHeight: number[],
  out: LayoutResult
): void {
  const totalWidth = subtreeWidth(branch);
  const ownWidth = stripWidth(branch);
  const bandCenter = levelTop[depth] + levelHeight[depth] / 2;

  let x = originX + (totalWidth - ownWidth) / 2;
  for (const box of branch.boxes) {
    out.set(box.id, { x, y: bandCenter - box.height / 2 });
    x += box.width + H_GAP;
  }

  const kidsWidth = childrenWidth(branch);
  let childX = originX + (totalWidth - kidsWidth) / 2;
  for (const child of branch.children) {
    placeSubtree(child, childX, depth + 1, levelTop, levelHeight, out);
    childX += subtreeWidth(child) + H_GAP;
  }
}

/**
 * Deterministic layered tidy-tree layout: every branch at depth `d` is placed in
 * a single global horizontal band, so all branches of one level sit above all
 * branches of the next level. Root subtrees are packed left-to-right and subtree
 * widths are computed bottom-up, so no two cluster boxes overlap. This is the
 * sole layout, guaranteeing a clean top-down tree with fork edges that always
 * cross exactly one level downward.
 */
export function tidyTreeLayout(roots: BranchLayout[]): LayoutResult {
  const { levelTop, levelHeight } = computeLevelBands(roots);
  const out: LayoutResult = new Map();
  let originX = 0;
  for (const root of roots) {
    placeSubtree(root, originX, 0, levelTop, levelHeight, out);
    originX += subtreeWidth(root) + H_GAP;
  }
  return out;
}

/**
 * Plans where every screenshot cluster sits on the board so they assemble into a
 * non-overlapping, strictly layered component tree: branches are bucketed into
 * global level bands by depth (parents above children) and packed left-to-right
 * so nothing overlaps. The layout is fully deterministic so the board always
 * reads as a clean top-down tree with fork edges crossing exactly one level.
 */
export async function planTreeLayout(
  branches: BranchRecord[],
  nodes: IterationNode[],
  boxes: NodeBox[]
): Promise<LayoutResult> {
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const nodesByBranch = groupNodesByBranch(nodes);
  const roots = buildBranchTree(branches, nodesByBranch, boxById);
  return tidyTreeLayout(roots);
}
