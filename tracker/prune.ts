// Pure planners that normalize the design graph into the exact tree the Miro
// renderer draws, so the SQLite store IS the pruned tree. Mirrors the style of
// treeStore.ts / layout.ts: no database access, just compute the operations a
// caller applies in a transaction.
//
// Two passes, each previously done by the renderer at draw time:
//   - planDuplicateCollapse: collapse byte-identical screenshots so each unique
//     image survives once (was miroClient's canonical-survivor map).
//   - planBranchPromotion: drop branches left with no nodes and hoist their
//     children (was treeLayout's promoteCollapsedBranches).

import type { BranchRecord, IterationNode } from "./types.js";
import { MAIN_BRANCH } from "./branch.js";

// Result of collapsing byte-identical screenshots: the duplicate nodes to
// delete, plus the reference re-points needed so survivors stay connected.
export type DuplicateCollapsePlan = {
  // Duplicate node ids to delete (every later node sharing an earlier node's
  // screenshot hash).
  deletedNodeIds: string[];
  // Surviving nodes whose parentId pointed at a deleted node, re-pointed to the
  // surviving node holding that screenshot.
  nodeParentUpdates: { id: string; parentId: string | null }[];
  // Branches whose forkNodeId pointed at a deleted node, re-pointed to the
  // surviving node.
  branchForkUpdates: { id: string; forkNodeId: string | null }[];
};

/**
 * Collapses byte-identical screenshots across the WHOLE graph: walking nodes in
 * export (chronological/rowid) order, the first node holding a given hash is the
 * survivor and every later node with that same hash is a duplicate that maps to
 * it. Nodes with a null hash are always treated as unique. Any surviving
 * `parentId` or branch `forkNodeId` that referenced a deleted duplicate is
 * re-pointed to the survivor so the tree stays connected through the kept image.
 */
export function planDuplicateCollapse(
  branches: BranchRecord[],
  nodes: IterationNode[],
  hashByNodeId: Map<string, string | null>
): DuplicateCollapsePlan {
  const survivorByHash = new Map<string, string>();
  // Every node id maps to the node that survives in its place: duplicates map to
  // their survivor, survivors map to themselves. Survivors are never deleted, so
  // resolving a reference is a single lookup.
  const canonicalByNodeId = new Map<string, string>();
  const deletedNodeIds: string[] = [];

  for (const node of nodes) {
    const hash = hashByNodeId.get(node.id) ?? null;
    if (hash) {
      const survivor = survivorByHash.get(hash);
      if (survivor) {
        canonicalByNodeId.set(node.id, survivor);
        deletedNodeIds.push(node.id);
        continue;
      }
      survivorByHash.set(hash, node.id);
    }
    canonicalByNodeId.set(node.id, node.id);
  }

  const deleted = new Set(deletedNodeIds);
  const resolve = (id: string | null): string | null =>
    id == null ? null : canonicalByNodeId.get(id) ?? id;

  const nodeParentUpdates: { id: string; parentId: string | null }[] = [];
  for (const node of nodes) {
    if (deleted.has(node.id)) continue;
    if (node.parentId != null && deleted.has(node.parentId)) {
      nodeParentUpdates.push({ id: node.id, parentId: resolve(node.parentId) });
    }
  }

  const branchForkUpdates: { id: string; forkNodeId: string | null }[] = [];
  for (const branch of branches) {
    if (branch.forkNodeId != null && deleted.has(branch.forkNodeId)) {
      branchForkUpdates.push({ id: branch.id, forkNodeId: resolve(branch.forkNodeId) });
    }
  }

  return { deletedNodeIds, nodeParentUpdates, branchForkUpdates };
}

// Result of promoting away node-less branches: the branches to delete, plus the
// reparent/refork updates that hoist their children into their place.
export type BranchPromotionPlan = {
  deletedBranchIds: string[];
  branchUpdates: { id: string; parentBranchId: string | null; forkNodeId: string | null }[];
};

/**
 * Removes branches that have no remaining nodes (their screenshots were all
 * collapsed as duplicates) by PROMOTING their children up to take their place:
 * each promoted child re-anchors to the empty branch's own parent and forks from
 * the node the empty branch forked from, so a chain of empties collapses cleanly
 * and the outermost empty branch's fork point wins. `main` is the root and is
 * never removed. This is the destructive db equivalent of the renderer's
 * promoteCollapsedBranches, so the stored tree equals the drawn tree.
 */
export function planBranchPromotion(
  branches: BranchRecord[],
  nodes: IterationNode[]
): BranchPromotionPlan {
  const hasNodes = new Set<string>();
  for (const node of nodes) hasNodes.add(node.branchId);

  const branchById = new Map(branches.map((b) => [b.id, b]));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const branch of branches) {
    if (branch.parentBranchId && branchById.has(branch.parentBranchId)) {
      const list = childrenOf.get(branch.parentBranchId) ?? [];
      list.push(branch.id);
      childrenOf.set(branch.parentBranchId, list);
    } else {
      roots.push(branch.id);
    }
  }

  const survives = (id: string): boolean => id === MAIN_BRANCH || hasNodes.has(id);

  const deletedBranchIds: string[] = [];
  const finalParent = new Map<string, string | null>();
  const finalFork = new Map<string, string | null>();

  // Top-down walk. `parentId` is the surviving branch a node should attach to,
  // and `forkOverride` (set the moment we enter the OUTERMOST empty branch and
  // held until a survivor is reached) carries that empty branch's fork point
  // onto the first surviving descendant.
  const walk = (
    branchId: string,
    parentId: string | null,
    forkOverride: { value: string | null } | undefined
  ): void => {
    const branch = branchById.get(branchId);
    const kids = childrenOf.get(branchId) ?? [];
    if (survives(branchId)) {
      finalParent.set(branchId, parentId);
      finalFork.set(branchId, forkOverride ? forkOverride.value : branch?.forkNodeId ?? null);
      // Below a surviving branch the override resets; its children attach to it.
      for (const kid of kids) walk(kid, branchId, undefined);
    } else {
      deletedBranchIds.push(branchId);
      const nextOverride = forkOverride ?? { value: branch?.forkNodeId ?? null };
      for (const kid of kids) walk(kid, parentId, nextOverride);
    }
  };

  for (const rootId of roots) {
    walk(rootId, branchById.get(rootId)?.parentBranchId ?? null, undefined);
  }

  // Only emit updates for surviving branches whose parent or fork actually moved.
  const branchUpdates: BranchPromotionPlan["branchUpdates"] = [];
  for (const branch of branches) {
    if (!finalParent.has(branch.id)) continue; // deleted branch
    const parentBranchId = finalParent.get(branch.id) ?? null;
    const forkNodeId = finalFork.get(branch.id) ?? null;
    if (parentBranchId !== branch.parentBranchId || forkNodeId !== branch.forkNodeId) {
      branchUpdates.push({ id: branch.id, parentBranchId, forkNodeId });
    }
  }

  return { deletedBranchIds, branchUpdates };
}
