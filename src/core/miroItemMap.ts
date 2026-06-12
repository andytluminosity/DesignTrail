import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import type { RenderedBoardNode } from "../../miro/miroClient.js";

// Resolve DesignTrail root so the map lives next to the per-repo SQLite graphs.
const DESIGNTRAIL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const MAP_FILE = path.join(DESIGNTRAIL_ROOT, "data", "miro-item-map.json");

// What a single Miro image item maps back to: the commit it was captured from
// and the route navigated to before capture.
export type MiroItemEntry = {
  commitHash: string;
  navPath: string;
};

// Everything needed to act on a board's items: which repo they belong to plus
// the per-item lookup. Keyed by Miro image item id.
export type MiroBoardItemMap = {
  repoName: string;
  repoPath: string;
  updatedAt: number;
  items: Record<string, MiroItemEntry>;
};

// The on-disk file is keyed by Miro board id, so one DesignTrail install can
// serve multiple boards/repos.
export type MiroItemMapFile = Record<string, MiroBoardItemMap>;

// A resolved item with its owning repo flattened in for convenience.
export type ResolvedMiroItem = MiroItemEntry & {
  repoName: string;
  repoPath: string;
};

export async function readMiroItemMapFile(): Promise<MiroItemMapFile> {
  try {
    return (await fse.readJson(MAP_FILE)) as MiroItemMapFile;
  } catch {
    return {};
  }
}

/**
 * Overwrites the entry for one board with the items just rendered. The board is
 * wipe-and-rerendered on every sync, so replacing the whole board entry drops
 * stale item ids automatically. No-ops when there is no board id or nothing was
 * rendered (so a failed/empty render never clobbers a good map).
 */
export async function writeMiroItemMap(params: {
  repoName: string;
  repoPath: string;
  miroNodes: RenderedBoardNode[];
}): Promise<void> {
  const boardId = process.env.MIRO_BOARD_ID;
  if (!boardId || params.miroNodes.length === 0) return;

  const file = await readMiroItemMapFile();
  const items: Record<string, MiroItemEntry> = {};
  for (const node of params.miroNodes) {
    items[node.miroImageId] = {
      commitHash: node.commitHash,
      navPath: node.navPath,
    };
  }

  file[boardId] = {
    repoName: params.repoName,
    repoPath: params.repoPath,
    updatedAt: Date.now(),
    items,
  };

  await fse.ensureDir(path.dirname(MAP_FILE));
  await fse.writeJson(MAP_FILE, file, { spaces: 2 });
}

/**
 * Looks up a single Miro image item by board + item id, returning the commit,
 * nav path, and owning repo, or null when the pair is unknown.
 */
export async function resolveMiroItem(
  boardId: string,
  itemId: string
): Promise<ResolvedMiroItem | null> {
  const file = await readMiroItemMapFile();
  const board = file[boardId];
  if (!board) return null;
  const item = board.items[itemId];
  if (!item) return null;
  return {
    ...item,
    repoName: board.repoName,
    repoPath: board.repoPath,
  };
}
