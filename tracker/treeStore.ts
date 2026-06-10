// Mirrors the component/branch tree onto the filesystem. SQLite is the source of
// truth; this derives the desired on-disk layout so captures/<repo>/ becomes the
// nested component tree: each branch is a folder holding its own iteration-node
// PNGs plus its child-branch subfolders.
//
// The branch tree is guaranteed acyclic (deriveContainmentParents enforces a
// tree), so every branch has a well-defined folder path obtained by walking
// parent_branch_id to the root.

import path from "path";
import type { BranchRecord, IterationNode } from "./types.js";

export type FolderMove = {
  nodeId: string;
  currentPath: string; // relative path stored on the node (may be empty/legacy)
  desiredPath: string; // relative path under captures/<repo>/<tree>/
};

/** First 8 chars of a commit hash, used to name a node's screenshot file. */
function shortHash(commitHash: string): string {
  return commitHash.slice(0, 8);
}

/**
 * Relative folder (under captures/<repo>/) for a branch: its ancestor chain
 * from the root down to the branch itself, joined as directories. A missing
 * parent (e.g. a dangling pointer) simply terminates the walk, so the branch
 * lands at whatever prefix is resolvable. A guard caps the walk length in case
 * of an unexpected cycle.
 */
function branchFolderSegments(
  branchId: string,
  branchById: Map<string, BranchRecord>
): string[] {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: string | null = branchId;
  while (current && branchById.has(current) && !seen.has(current)) {
    seen.add(current);
    segments.unshift(current);
    current = branchById.get(current)!.parentBranchId;
  }
  return segments;
}

/**
 * Computes the desired nested screenshot path for every node, derived purely
 * from the current branch tree and node chains. Nodes are grouped by branch and
 * numbered (1-based) in their stored order, so each file name is
 * `<NNN>-<shortHash>.png` and unique within its branch folder. Returns one
 * FolderMove per node; callers move only those whose currentPath != desiredPath.
 */
export function planFolderLayout(
  branches: BranchRecord[],
  nodes: IterationNode[],
  repoName: string
): FolderMove[] {
  const branchById = new Map(branches.map((b) => [b.id, b]));
  const folderByBranch = new Map<string, string[]>();
  const getFolder = (branchId: string): string[] => {
    let segs = folderByBranch.get(branchId);
    if (!segs) {
      segs = branchFolderSegments(branchId, branchById);
      folderByBranch.set(branchId, segs);
    }
    return segs;
  };

  // Per-branch running counter; `nodes` is already in chronological (rowid) order.
  const indexByBranch = new Map<string, number>();
  const moves: FolderMove[] = [];

  for (const node of nodes) {
    const n = (indexByBranch.get(node.branchId) ?? 0) + 1;
    indexByBranch.set(node.branchId, n);

    const segments = getFolder(node.branchId);
    const fileName = `${String(n).padStart(3, "0")}-${shortHash(node.commitHash)}.png`;
    const desiredPath = path.join("captures", repoName, ...segments, fileName);

    moves.push({
      nodeId: node.id,
      currentPath: node.screenshotPath,
      desiredPath,
    });
  }

  return moves;
}
