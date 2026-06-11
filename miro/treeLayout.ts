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
// clusters/subtrees and vertical gap between adjacent level bands. Generous so
// the tree reads clearly with the uniform annotation-padded node boxes.
const H_GAP = 320;
const V_GAP = 360;

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
 * Sizes one screenshot's node box from the actual things drawn around it: image,
 * header sticky note, optional manual annotation note, and any generated
 * per-element annotation notes. `imageCenterOffset` tells the renderer where the
 * image center lands inside the returned bounding box.
 */
export function computeClusterFootprint(
  imageH: number,
  placements: AnnotationPlacement[] = []
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
// chronological screenshot boxes, the parent-branch node it forks from, and its
// child branches.
type BranchLayout = {
  branchId: string;
  // Id of the node in the PARENT branch this branch forks from (its visual
  // anchor). null when unknown/legacy; such branches anchor to the parent's
  // first node.
  forkNodeId: string | null;
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
    return { branchId: branch.id, forkNodeId: branch.forkNodeId, boxes, children: kids };
  };

  const sortRoots = (a: BranchRecord, b: BranchRecord): number => {
    if (a.id === "main") return -1;
    if (b.id === "main") return 1;
    return byCreatedThenId(a, b);
  };

  return roots.sort(sortRoots).map(build);
}

/**
 * Removes branches that have no drawable boxes (their screenshots were collapsed
 * as byte-identical duplicates, or are otherwise undrawable) by PROMOTING their
 * children up to take the empty branch's place: each promoted child re-anchors to
 * the node the empty branch itself forked from, so the chain stays attached at the
 * right level instead of leaving a gap. Applied bottom-up so chains of empty
 * branches collapse cleanly.
 */
function promoteCollapsedBranches(branches: BranchLayout[]): BranchLayout[] {
  return branches.flatMap((branch) => {
    const children = promoteCollapsedBranches(branch.children);
    if (branch.boxes.length === 0) {
      return children.map((child) => ({ ...child, forkNodeId: branch.forkNodeId }));
    }
    return [{ ...branch, children }];
  });
}

function stripHeight(branch: BranchLayout): number {
  return branch.boxes.reduce((max, box) => Math.max(max, box.height), 0);
}

/**
 * Buckets a branch's child branches by the index of the parent-branch node they
 * fork from (their visual anchor). A child whose fork node is unknown or not
 * among the drawable row anchors to the branch's first node (index 0). Children
 * keep their incoming (createdAt, id) order within each bucket.
 */
function groupChildrenByAnchorIndex(branch: BranchLayout): Map<number, BranchLayout[]> {
  const indexById = new Map(branch.boxes.map((box, i) => [box.id, i] as const));
  const groups = new Map<number, BranchLayout[]>();
  for (const child of branch.children) {
    const idx =
      child.forkNodeId != null && indexById.has(child.forkNodeId)
        ? (indexById.get(child.forkNodeId) as number)
        : 0;
    const list = groups.get(idx) ?? [];
    list.push(child);
    groups.set(idx, list);
  }
  return groups;
}

/** Combined width of a set of sibling child subtrees laid out side by side. */
function groupWidth(children: BranchLayout[]): number {
  if (children.length === 0) return 0;
  const total = children.reduce((sum, child) => sum + subtreeWidth(child), 0);
  return total + (children.length - 1) * H_GAP;
}

/**
 * Width of a branch's whole subtree (the "overall container" enclosing every
 * descendant). Each row node gets a slot wide enough for both the node box and
 * the child group that forks from it (its children sit centered under it), and
 * the slots pack left-to-right with H_GAP between them. A branch with no drawable
 * boxes still reserves room for its child subtrees so descendants are not lost.
 */
function subtreeWidth(branch: BranchLayout): number {
  if (branch.boxes.length === 0) {
    return groupWidth(branch.children);
  }
  const groups = groupChildrenByAnchorIndex(branch);
  let total = 0;
  branch.boxes.forEach((box, i) => {
    total += Math.max(box.width, groupWidth(groups.get(i) ?? []));
  });
  return total + (branch.boxes.length - 1) * H_GAP;
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
 * Places a branch subtree. The branch's screenshots form a horizontal row on its
 * depth's level band; each node gets a slot sized for both the node box and the
 * child group forking from it, and that child group is centered directly under
 * the node it forks from, so fork edges run straight down like a classic tree.
 * Child branches land on the next band down. Slots pack left-to-right so sibling
 * subtrees never overlap, and the Y comes from the shared level bands so every
 * branch at the same depth lines up on one horizontal band.
 */
function placeSubtree(
  branch: BranchLayout,
  originX: number,
  depth: number,
  levelTop: number[],
  levelHeight: number[],
  out: LayoutResult
): void {
  const bandCenter = levelTop[depth] + levelHeight[depth] / 2;

  // A branch with no drawable boxes contributes no row; its children still flow
  // onto the next band, packed left-to-right from the subtree origin.
  if (branch.boxes.length === 0) {
    let childX = originX;
    for (const child of branch.children) {
      placeSubtree(child, childX, depth + 1, levelTop, levelHeight, out);
      childX += subtreeWidth(child) + H_GAP;
    }
    return;
  }

  const groups = groupChildrenByAnchorIndex(branch);
  let cursor = originX;
  branch.boxes.forEach((box, i) => {
    const group = groups.get(i) ?? [];
    const gWidth = groupWidth(group);
    const slot = Math.max(box.width, gWidth);
    const slotCenter = cursor + slot / 2;

    // Node box centered in its slot, vertically centered on the level band.
    out.set(box.id, { x: slotCenter - box.width / 2, y: bandCenter - box.height / 2 });

    // Children that fork from this node are centered directly under it.
    let childX = slotCenter - gWidth / 2;
    for (const child of group) {
      placeSubtree(child, childX, depth + 1, levelTop, levelHeight, out);
      childX += subtreeWidth(child) + H_GAP;
    }

    cursor += slot + H_GAP;
  });
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

// One fork edge of the drawn tree: a connector from the parent node a branch
// hangs under (`from`) to that branch's first drawn node (`to`).
export type ForkEdge = { from: string; to: string };

// Full layout plan: where each node's box sits, plus the fork edges of the
// promoted tree (so connectors match the drawn structure even when collapsed
// branches re-anchor their children).
export type TreePlan = {
  positions: LayoutResult;
  forkEdges: ForkEdge[];
};

/**
 * Derives the fork edges of the promoted tree: for every branch, an edge from
 * the node it forks from (its re-anchored `forkNodeId`, or the parent branch's
 * first node when unknown) to that branch's first drawn node. Built from the
 * promoted tree so a collapsed branch's children connect to where they actually
 * hang, not to the collapsed image's hash-duplicate survivor.
 */
function collectForkEdges(roots: BranchLayout[]): ForkEdge[] {
  const edges: ForkEdge[] = [];
  const walk = (branch: BranchLayout): void => {
    const parentFirst = branch.boxes[0]?.id;
    for (const child of branch.children) {
      const childFirst = child.boxes[0]?.id;
      if (childFirst) {
        const from = child.forkNodeId ?? parentFirst;
        if (from) edges.push({ from, to: childFirst });
      }
      walk(child);
    }
  };
  for (const root of roots) walk(root);
  return edges;
}

/**
 * Plans where every screenshot cluster sits on the board so they assemble into a
 * non-overlapping, strictly layered component tree: branches are bucketed into
 * global level bands by depth (parents above children) and packed left-to-right
 * so nothing overlaps. The layout is fully deterministic so the board always
 * reads as a clean top-down tree with fork edges crossing exactly one level.
 * Also returns the promoted tree's fork edges so connectors match the layout.
 */
export async function planTreeLayout(
  branches: BranchRecord[],
  nodes: IterationNode[],
  boxes: NodeBox[]
): Promise<TreePlan> {
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const nodesByBranch = groupNodesByBranch(nodes);
  const roots = promoteCollapsedBranches(buildBranchTree(branches, nodesByBranch, boxById));
  return { positions: tidyTreeLayout(roots), forkEdges: collectForkEdges(roots) };
}
