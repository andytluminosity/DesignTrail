// Render-time, NON-DESTRUCTIVE planner that prunes screenshots whose design
// barely changed from their parent, so a second "significant changes only" tree
// can be drawn beside the full-history tree. Unlike prune.ts (which mutates the
// SQLite store at save time), nothing here touches the database: it returns a
// plan the renderer applies to in-memory copies of the graph.
//
// The unit of decision is a HIERARCHY LEVEL BAND: every node whose branch sits
// at tree depth `d` shares one horizontal band in the layout. Each band gets one
// vision LLM call that flags the nodes which are only a minor/cosmetic change
// (text edit, color tweak) from their same-row parent. Those are pruned and
// their children re-anchor to the nearest surviving ancestor. Leaf nodes and
// branch-anchor nodes are NEVER pruned, so the total leaf count is preserved and
// all design exploration survives.

import path from "path";
import fse from "fs-extra";
import OpenAI from "openai";
import type { BranchRecord, IterationNode } from "./types.js";

// Same vision-capable model the annotation pass uses (image inputs supported).
const VISION_MODEL = "gpt-4o-mini";

// Upper bound on screenshots passed in a single per-band call, so a very wide
// band can't blow up the prompt (and cost). Bands above this are left unpruned.
const MAX_ROW_IMAGES = 30;

// Same shape as prune.ts's DuplicateCollapsePlan so the renderer can treat the
// two prune passes uniformly: the nodes to drop, plus the reference re-points
// that keep survivors connected through the kept screenshots.
export type SignificancePrunePlan = {
  // Node ids dropped from the pruned tree (minor-change intermediates).
  deletedNodeIds: string[];
  // Surviving nodes whose parentId pointed at a dropped node, re-pointed to the
  // nearest surviving ancestor on the same branch.
  nodeParentUpdates: { id: string; parentId: string | null }[];
  // Branches whose forkNodeId pointed at a dropped node, re-pointed to the
  // nearest surviving ancestor.
  branchForkUpdates: { id: string; forkNodeId: string | null }[];
};

const EMPTY_PLAN: SignificancePrunePlan = {
  deletedNodeIds: [],
  nodeParentUpdates: [],
  branchForkUpdates: [],
};

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

/**
 * Depth of every branch in the branch forest: roots (no parent, or a parent not
 * present) are 0 and each child is one deeper. Memoized with a visiting guard so
 * a malformed parent cycle can't loop forever (cyclic branches fall back to 0).
 */
function computeBranchDepths(branches: BranchRecord[]): Map<string, number> {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const depth = new Map<string, number>();

  const resolve = (id: string, visiting: Set<string>): number => {
    const cached = depth.get(id);
    if (cached != null) return cached;
    const branch = byId.get(id);
    const parentId = branch?.parentBranchId ?? null;
    if (!parentId || !byId.has(parentId) || visiting.has(id)) {
      depth.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const d = resolve(parentId, visiting) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const branch of branches) resolve(branch.id, new Set());
  return depth;
}

// One screenshot positioned within its level band, with the context the LLM
// needs to judge whether it is only a minor change from its parent.
type BandItem = {
  node: IterationNode;
  // Index (within the band's ordered list) of this node's same-row parent, or
  // null when the parent is on another row (branch anchor) or absent.
  parentIndex: number | null;
  // Prune candidate: has a same-row parent AND is not a leaf. Anchors and leaves
  // are never candidates, so they always survive.
  isCandidate: boolean;
  dataUrl: string | null;
};

const PRUNE_SYSTEM_PROMPT = `You compare consecutive UI screenshots in a design-iteration history and decide which intermediate screenshots can be hidden because they are NOT a meaningful design change from the previous screenshot.

You are given an ordered set of screenshots from ONE level of a design tree. Each image is labeled with its index, its branch, and the index of its PARENT screenshot (the previous design state it derives from). Some images are marked as CANDIDATES that may be hidden.

For every CANDIDATE, compare it to its PARENT image and decide:
- HIDE it when the change from the parent is small/cosmetic and does not significantly alter the design: e.g. changed button or text color, edited copy/label text, tiny spacing or icon swaps, trivial state toggles.
- KEEP it when the change significantly alters the design: e.g. new or removed sections/components, layout/structure changes, added flows, major restyling that changes the visual hierarchy.

Only CANDIDATES may be hidden. Never choose a non-candidate.

Respond with ONLY a JSON object in exactly this shape, listing the indices to hide:
{ "hide": [<index>, ...] }
If nothing should be hidden, respond with { "hide": [] }.`;

/** Extracts the `hide` index array from the model's JSON-ish response. */
function parseHideIndices(content: string): number[] {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { hide?: unknown };
    if (!Array.isArray(parsed.hide)) return [];
    return parsed.hide
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
  } catch {
    return [];
  }
}

/**
 * One vision call for a single level band: returns the node ids the model judged
 * to be only a minor change from their parent (so they can be hidden in the
 * pruned tree). Constrained to candidates regardless of what the model returns.
 */
async function callPruneRow(
  client: OpenAI,
  items: BandItem[]
): Promise<Set<string>> {
  const drawable = items.filter((item) => item.dataUrl);
  if (drawable.length > MAX_ROW_IMAGES) {
    console.warn(
      `Significance prune: band has ${drawable.length} screenshots (> ${MAX_ROW_IMAGES}); leaving it unpruned.`
    );
    return new Set();
  }
  if (!items.some((item) => item.isCandidate)) return new Set();

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  items.forEach((item, index) => {
    if (!item.dataUrl) return;
    const parent =
      item.parentIndex != null ? `parent=index ${item.parentIndex}` : "parent=none (anchor)";
    content.push({
      type: "text",
      text: `index ${index} · branch ${item.node.branchId} · ${parent} · ${
        item.isCandidate ? "CANDIDATE (may be hidden)" : "not a candidate"
      }`,
    });
    content.push({ type: "image_url", image_url: { url: item.dataUrl } });
  });

  const completion = await client.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      { role: "system", content: PRUNE_SYSTEM_PROMPT },
      { role: "user", content },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim() ?? "";
  const hideIndices = new Set(parseHideIndices(text));
  const result = new Set<string>();
  items.forEach((item, index) => {
    if (item.isCandidate && hideIndices.has(index)) result.add(item.node.id);
  });
  return result;
}

/**
 * Plans the significance prune across the whole graph: groups nodes into level
 * bands by their branch depth, runs ONE vision call per band to flag minor-change
 * intermediates, then re-points every survivor `parentId` and branch `forkNodeId`
 * that referenced a dropped node onto the nearest surviving ancestor. Leaf and
 * branch-anchor nodes are excluded as candidates, so leaf count is preserved.
 *
 * Non-destructive: returns a plan only. When `OPENAI_API_KEY` is missing or a
 * call fails, the affected band is left unpruned (empty plan == identical tree).
 */
export async function planSignificancePrune(
  branches: BranchRecord[],
  nodes: IterationNode[],
  rootDir: string
): Promise<SignificancePrunePlan> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY not set. Skipping significance prune; trees will match.");
    return EMPTY_PLAN;
  }
  if (nodes.length === 0) return EMPTY_PLAN;

  // Child counts across BOTH edge kinds: next-in-chain (parentId) and forked
  // branches (forkNodeId). A node with zero children is a leaf and is preserved.
  const childCount = new Map<string, number>();
  const bump = (id: string | null): void => {
    if (id == null) return;
    childCount.set(id, (childCount.get(id) ?? 0) + 1);
  };
  for (const node of nodes) bump(node.parentId);
  for (const branch of branches) bump(branch.forkNodeId);

  const depthByBranch = computeBranchDepths(branches);
  const indexInBand = new Map<string, number>();

  // Bucket nodes into bands by their branch depth, preserving export order so
  // each branch's chain stays chronological and same-row parents resolve.
  const bands = new Map<number, IterationNode[]>();
  for (const node of nodes) {
    const depth = depthByBranch.get(node.branchId) ?? 0;
    const list = bands.get(depth) ?? [];
    list.push(node);
    bands.set(depth, list);
  }

  const client = new OpenAI({ apiKey });
  const deletedNodeIds: string[] = [];

  for (const bandNodes of bands.values()) {
    bandNodes.forEach((node, index) => indexInBand.set(node.id, index));

    const items: BandItem[] = await Promise.all(
      bandNodes.map(async (node) => {
        const parentIndex =
          node.parentId != null && indexInBand.has(node.parentId)
            ? (indexInBand.get(node.parentId) as number)
            : null;
        const isLeaf = (childCount.get(node.id) ?? 0) === 0;
        const isCandidate = parentIndex != null && !isLeaf;
        const dataUrl = await toDataUrl(path.join(rootDir, node.screenshotPath));
        return { node, parentIndex, isCandidate, dataUrl };
      })
    );

    try {
      const hidden = await callPruneRow(client, items);
      for (const item of items) {
        // Re-assert constraints: only non-leaf, same-row-parented candidates are
        // ever droppable, no matter what the model returned.
        if (item.isCandidate && hidden.has(item.node.id)) {
          deletedNodeIds.push(item.node.id);
        }
      }
    } catch (error) {
      console.warn(
        "Significance prune call failed; leaving this band unpruned.",
        error instanceof Error ? error.message : error
      );
    }

    indexInBand.clear();
  }

  if (deletedNodeIds.length === 0) return EMPTY_PLAN;

  // Resolve any (possibly deleted) node to the nearest surviving ancestor by
  // walking parentId. Anchors (parentId == null) are never deleted, so the walk
  // always terminates on a survivor.
  const deleted = new Set(deletedNodeIds);
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const resolve = (id: string | null): string | null => {
    let current = id;
    const seen = new Set<string>();
    while (current != null && deleted.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
    return current;
  };

  const nodeParentUpdates: SignificancePrunePlan["nodeParentUpdates"] = [];
  for (const node of nodes) {
    if (deleted.has(node.id)) continue;
    if (node.parentId != null && deleted.has(node.parentId)) {
      nodeParentUpdates.push({ id: node.id, parentId: resolve(node.parentId) });
    }
  }

  const branchForkUpdates: SignificancePrunePlan["branchForkUpdates"] = [];
  for (const branch of branches) {
    if (branch.forkNodeId != null && deleted.has(branch.forkNodeId)) {
      branchForkUpdates.push({ id: branch.id, forkNodeId: resolve(branch.forkNodeId) });
    }
  }

  return { deletedNodeIds, nodeParentUpdates, branchForkUpdates };
}

/**
 * Applies a prune plan to IN-MEMORY copies of the graph (the SQLite store is
 * never touched): drops the deleted nodes and re-points survivor `parentId` /
 * branch `forkNodeId` onto their surviving ancestors, so the result can be fed
 * straight into the layout to draw the pruned tree.
 */
export function applySignificancePrune(
  branches: BranchRecord[],
  nodes: IterationNode[],
  plan: SignificancePrunePlan
): { branches: BranchRecord[]; nodes: IterationNode[] } {
  if (plan.deletedNodeIds.length === 0) {
    return { branches, nodes };
  }

  const deleted = new Set(plan.deletedNodeIds);
  const parentUpdate = new Map(plan.nodeParentUpdates.map((u) => [u.id, u.parentId]));
  const forkUpdate = new Map(plan.branchForkUpdates.map((u) => [u.id, u.forkNodeId]));

  const prunedNodes = nodes
    .filter((node) => !deleted.has(node.id))
    .map((node) =>
      parentUpdate.has(node.id)
        ? { ...node, parentId: parentUpdate.get(node.id) ?? null }
        : node
    );

  const prunedBranches = branches.map((branch) =>
    forkUpdate.has(branch.id)
      ? { ...branch, forkNodeId: forkUpdate.get(branch.id) ?? null }
      : branch
  );

  return { branches: prunedBranches, nodes: prunedNodes };
}
