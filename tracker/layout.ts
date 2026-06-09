// Derives a Figma/Miro-style spatial frame tree from captured geometry.
//
// Each branch becomes a frame positioned at its located element's real page
// rect. A frame's parent is the smallest OTHER frame whose rect fully contains
// it (true on-screen containment), and siblings are ordered in reading order
// (top-to-bottom, then left-to-right). Branches that have no geometry yet fall
// back to the LLM-assigned parent_branch_id, and any that still can't be placed
// are returned separately for an auto-laid-out tray.

import type { BranchRecord, IterationNode, NodeGeometry } from "./types.js";

export type FrameNode = {
  branch: BranchRecord;
  geometry?: NodeGeometry; // representative (latest) geometry, if known
  nodes: IterationNode[]; // this branch's iteration nodes, in chronological order
  latest: IterationNode | null; // newest node (its screenshot fronts the frame)
  children: FrameNode[];
};

export type Layout = {
  pageW: number;
  pageH: number;
  roots: FrameNode[]; // positioned frames (nested by spatial containment)
  unpositioned: FrameNode[]; // branches with no usable geometry (tray)
};

const CONTAIN_EPS = 2; // px tolerance so sub-pixel rounding doesn't break containment

function area(g: NodeGeometry): number {
  return Math.max(0, g.w) * Math.max(0, g.h);
}

/** True when `outer` is strictly larger than and fully encloses `inner`. */
function contains(outer: NodeGeometry, inner: NodeGeometry): boolean {
  return (
    area(outer) > area(inner) &&
    inner.x >= outer.x - CONTAIN_EPS &&
    inner.y >= outer.y - CONTAIN_EPS &&
    inner.x + inner.w <= outer.x + outer.w + CONTAIN_EPS &&
    inner.y + inner.h <= outer.y + outer.h + CONTAIN_EPS
  );
}

/** Reading order: top-to-bottom, then left-to-right, with a stable id tiebreak. */
function readingOrder(a: FrameNode, b: FrameNode): number {
  const ga = a.geometry;
  const gb = b.geometry;
  if (ga && gb) {
    if (Math.abs(ga.y - gb.y) > 8) return ga.y - gb.y;
    if (Math.abs(ga.x - gb.x) > 8) return ga.x - gb.x;
  }
  return a.branch.id.localeCompare(b.branch.id);
}

/** Groups iteration nodes by branch, preserving chronological (export) order. */
function nodesByBranch(nodes: IterationNode[]): Map<string, IterationNode[]> {
  const map = new Map<string, IterationNode[]>();
  for (const n of nodes) {
    const list = map.get(n.branchId) ?? [];
    list.push(n);
    map.set(n.branchId, list);
  }
  return map;
}

/**
 * Representative geometry per branch = the latest node on that branch that
 * actually has geometry. Branches with no measured node are omitted.
 */
function geometryByBranch(
  branches: BranchRecord[],
  nodes: IterationNode[]
): Map<string, NodeGeometry> {
  const grouped = nodesByBranch(nodes);
  const out = new Map<string, NodeGeometry>();
  for (const branch of branches) {
    let geometry: NodeGeometry | undefined;
    for (const n of grouped.get(branch.id) ?? []) {
      if (n.geometry) geometry = n.geometry;
    }
    if (geometry) out.set(branch.id, geometry);
  }
  return out;
}

/**
 * For every branch that has measured container geometry, returns its smallest
 * OTHER branch whose container rect fully encloses it (true on-screen
 * containment), or null when nothing contains it (it is a spatial root). Shared
 * by the spatial viz and by persistence so the stored branch tree matches the
 * board. Branches without geometry are omitted entirely.
 */
export function deriveContainmentParents(
  branches: BranchRecord[],
  nodes: IterationNode[]
): Map<string, string | null> {
  const geoms = geometryByBranch(branches, nodes);
  const entries = [...geoms.entries()];
  const parents = new Map<string, string | null>();

  for (const [id, g] of entries) {
    let bestId: string | null = null;
    let bestGeom: NodeGeometry | null = null;
    for (const [otherId, og] of entries) {
      if (otherId === id) continue;
      if (!contains(og, g)) continue;
      if (!bestGeom || area(og) < area(bestGeom)) {
        bestId = otherId;
        bestGeom = og;
      }
    }
    parents.set(id, bestId);
  }

  return parents;
}

export function buildLayout(branches: BranchRecord[], nodes: IterationNode[]): Layout {
  const grouped = nodesByBranch(nodes);

  const frames = new Map<string, FrameNode>();
  for (const branch of branches) {
    const branchNodes = grouped.get(branch.id) ?? [];
    // Representative geometry = the latest node that actually has one.
    let geometry: NodeGeometry | undefined;
    for (const n of branchNodes) {
      if (n.geometry) geometry = n.geometry;
    }
    frames.set(branch.id, {
      branch,
      geometry,
      nodes: branchNodes,
      latest: branchNodes.length ? branchNodes[branchNodes.length - 1] : null,
      children: [],
    });
  }

  const positioned = [...frames.values()].filter((f) => f.geometry);
  const pageW = Math.max(1, ...positioned.map((f) => f.geometry!.pageW));
  const pageH = Math.max(1, ...positioned.map((f) => f.geometry!.pageH));

  // Resolve each frame's parent: spatial containment for positioned frames, the
  // LLM parent_branch_id as a fallback for the rest.
  const parentOf = new Map<string, string | null>(
    deriveContainmentParents(branches, nodes)
  );

  const unpositioned: FrameNode[] = [];
  for (const frame of frames.values()) {
    if (frame.geometry) continue;
    const fallback = frame.branch.parentBranchId;
    // Only nest a geometry-less branch if its LLM parent is itself positioned;
    // otherwise it has no real coordinates and goes to the tray.
    if (fallback && frames.get(fallback)?.geometry) {
      parentOf.set(frame.branch.id, fallback);
    } else {
      unpositioned.push(frame);
    }
  }

  const roots: FrameNode[] = [];
  for (const frame of frames.values()) {
    if (unpositioned.includes(frame)) continue;
    const parentId = parentOf.get(frame.branch.id) ?? null;
    const parent = parentId ? frames.get(parentId) : undefined;
    if (parent) parent.children.push(frame);
    else roots.push(frame);
  }

  const sortTree = (frame: FrameNode): void => {
    frame.children.sort(readingOrder);
    frame.children.forEach(sortTree);
  };
  roots.sort(readingOrder);
  roots.forEach(sortTree);
  unpositioned.sort((a, b) => a.branch.id.localeCompare(b.branch.id));

  return { pageW, pageH, roots, unpositioned };
}
