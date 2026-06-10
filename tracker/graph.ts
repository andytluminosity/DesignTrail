import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import Database from "better-sqlite3";
import type {
  BranchRecord,
  CommitData,
  IterationNode,
  NodeGeometry,
  ScreenshotTarget,
} from "./types.js";
import { MAIN_BRANCH } from "./branch.js";

// Resolve DesignTrail root so the DB lives in /data regardless of which repo's
// hook triggered the run (cwd is the committing repo, not DesignTrail).
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits (
  hash      TEXT PRIMARY KEY,
  message   TEXT,
  diff      TEXT,
  timestamp INTEGER NOT NULL,
  source    TEXT,
  annotation TEXT
);

CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,
  parent_branch_id TEXT,
  fork_node_id     TEXT,
  created_at       INTEGER NOT NULL,
  nav_path         TEXT,
  target_json      TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  commit_hash     TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  parent_id       TEXT,
  summary         TEXT,
  type            TEXT,
  screenshot_path TEXT,
  timestamp       INTEGER NOT NULL,
  geom_x          REAL,
  geom_y          REAL,
  geom_w          REAL,
  geom_h          REAL,
  page_w          REAL,
  page_h          REAL
);
`;

type BranchRow = {
  id: string;
  parent_branch_id: string | null;
  fork_node_id: string | null;
  created_at: number;
  nav_path: string | null;
  target_json: string | null;
};

type NodeRow = {
  id: string;
  commit_hash: string;
  branch_id: string;
  parent_id: string | null;
  summary: string;
  type: string;
  screenshot_path: string;
  timestamp: number;
  geom_x: number | null;
  geom_y: number | null;
  geom_w: number | null;
  geom_h: number | null;
  page_w: number | null;
  page_h: number | null;
};

function parseTarget(raw: string | null): ScreenshotTarget | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as ScreenshotTarget)
      : undefined;
  } catch {
    return undefined;
  }
}

function toBranchRecord(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    parentBranchId: row.parent_branch_id,
    forkNodeId: row.fork_node_id,
    createdAt: row.created_at,
    navPath: row.nav_path ?? undefined,
    target: parseTarget(row.target_json),
  };
}

function toGeometry(row: NodeRow): NodeGeometry | undefined {
  if (
    row.geom_x == null ||
    row.geom_y == null ||
    row.geom_w == null ||
    row.geom_h == null ||
    row.page_w == null ||
    row.page_h == null
  ) {
    return undefined;
  }
  return {
    x: row.geom_x,
    y: row.geom_y,
    w: row.geom_w,
    h: row.geom_h,
    pageW: row.page_w,
    pageH: row.page_h,
  };
}

function toIterationNode(row: NodeRow): IterationNode {
  return {
    id: row.id,
    commitHash: row.commit_hash,
    branchId: row.branch_id,
    parentId: row.parent_id,
    summary: row.summary,
    type: row.type as IterationNode["type"],
    screenshotPath: row.screenshot_path,
    timestamp: row.timestamp,
    geometry: toGeometry(row),
  };
}

/**
 * Per-repo design-evolution graph stored in SQLite. Synchronous (better-sqlite3),
 * so all reads/writes complete inline; state is rebuilt from disk on every load
 * because each commit runs in a fresh process.
 */
export class DesignGraph {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async load(repoName: string): Promise<DesignGraph> {
    const dir = path.join(TRACKER_ROOT, "data", repoName);
    await fse.ensureDir(dir);
    const db = new Database(path.join(dir, "graph.db"));
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    DesignGraph.migrate(db);
    return new DesignGraph(db);
  }

  /**
   * Adds columns introduced after the original schema to pre-existing databases.
   * SQLite has no "ADD COLUMN IF NOT EXISTS", so we check PRAGMA table_info first.
   */
  private static migrate(db: Database.Database): void {
    const commitCols = (db.prepare(`PRAGMA table_info(commits)`).all() as {
      name: string;
    }[]).map((c) => c.name);
    if (!commitCols.includes("source")) {
      db.exec(`ALTER TABLE commits ADD COLUMN source TEXT`);
    }
    if (!commitCols.includes("annotation")) {
      db.exec(`ALTER TABLE commits ADD COLUMN annotation TEXT`);
    }

    const branchCols = (db.prepare(`PRAGMA table_info(branches)`).all() as {
      name: string;
    }[]).map((c) => c.name);
    if (!branchCols.includes("nav_path")) {
      db.exec(`ALTER TABLE branches ADD COLUMN nav_path TEXT`);
    }
    if (!branchCols.includes("target_json")) {
      db.exec(`ALTER TABLE branches ADD COLUMN target_json TEXT`);
    }

    const nodeCols = (db.prepare(`PRAGMA table_info(nodes)`).all() as {
      name: string;
    }[]).map((c) => c.name);
    for (const col of ["geom_x", "geom_y", "geom_w", "geom_h", "page_w", "page_h"]) {
      if (!nodeCols.includes(col)) {
        db.exec(`ALTER TABLE nodes ADD COLUMN ${col} REAL`);
      }
    }
  }

  upsertCommit(commit: CommitData): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO commits (hash, message, diff, timestamp, source, annotation)
         VALUES (@hash, @message, @diff, @timestamp, @source, @annotation)`
      )
      .run({
        hash: commit.hash,
        message: commit.message,
        diff: commit.diff,
        timestamp: commit.timestamp,
        source: commit.source ?? null,
        annotation: commit.annotation ?? null,
      });
  }

  getBranches(): BranchRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM branches ORDER BY created_at ASC, id ASC`)
      .all() as BranchRow[];
    return rows.map(toBranchRecord);
  }

  getBranchNames(): Set<string> {
    const rows = this.db.prepare(`SELECT id FROM branches`).all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  branchExists(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM branches WHERE id = ?`).get(id);
    return row !== undefined;
  }

  getBranch(id: string): BranchRecord | null {
    const row = this.db.prepare(`SELECT * FROM branches WHERE id = ?`).get(id) as
      | BranchRow
      | undefined;
    return row ? toBranchRecord(row) : null;
  }

  /** Latest node id on a branch (its tip), or null if the branch has no nodes. */
  getBranchTip(branchId: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM nodes WHERE branch_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(branchId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  ensureBranch(
    id: string,
    parentBranchId: string | null,
    forkNodeId: string | null,
    navPath?: string,
    target?: ScreenshotTarget
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO branches
           (id, parent_branch_id, fork_node_id, created_at, nav_path, target_json)
         VALUES (@id, @parentBranchId, @forkNodeId, @createdAt, @navPath, @targetJson)`
      )
      .run({
        id,
        parentBranchId: id === MAIN_BRANCH ? null : parentBranchId,
        forkNodeId,
        createdAt: Date.now(),
        navPath: navPath ?? null,
        targetJson: target ? JSON.stringify(target) : null,
      });
  }

  /**
   * Records (or refreshes) how to re-screenshot a branch's component: the route
   * to navigate to and the component locator. Used by cascading ancestor updates
   * so any branch can be re-captured on demand.
   */
  setBranchCapture(id: string, navPath: string, target: ScreenshotTarget): void {
    this.db
      .prepare(
        `UPDATE branches SET nav_path = @navPath, target_json = @targetJson WHERE id = @id`
      )
      .run({ id, navPath, targetJson: JSON.stringify(target) });
  }

  /**
   * Reparents a branch to a new container branch (derived from spatial
   * containment after geometry is known). `main` is the root and is never
   * reparented.
   */
  setBranchParent(id: string, parentBranchId: string | null): void {
    if (id === MAIN_BRANCH) return;
    this.db
      .prepare(`UPDATE branches SET parent_branch_id = @parentBranchId WHERE id = @id`)
      .run({ id, parentBranchId });
  }

  addNode(node: IterationNode): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nodes
           (id, commit_hash, branch_id, parent_id, summary, type, screenshot_path, timestamp)
         VALUES
           (@id, @commitHash, @branchId, @parentId, @summary, @type, @screenshotPath, @timestamp)`
      )
      .run({
        id: node.id,
        commitHash: node.commitHash,
        branchId: node.branchId,
        parentId: node.parentId,
        summary: node.summary,
        type: node.type,
        screenshotPath: node.screenshotPath,
        timestamp: node.timestamp,
      });
  }

  /** Records the on-screen geometry of a node's located element. */
  setNodeGeometry(nodeId: string, geom: NodeGeometry): void {
    this.db
      .prepare(
        `UPDATE nodes
            SET geom_x = @x, geom_y = @y, geom_w = @w, geom_h = @h,
                page_w = @pageW, page_h = @pageH
          WHERE id = @id`
      )
      .run({
        id: nodeId,
        x: geom.x,
        y: geom.y,
        w: geom.w,
        h: geom.h,
        pageW: geom.pageW,
        pageH: geom.pageH,
      });
  }

  /**
   * Repoints a node at its screenshot's current location. Used when the folder
   * mirror moves PNGs into their nested branch folders, keeping the DB (the
   * source of truth) consistent with where the files actually live.
   */
  setNodeScreenshotPath(nodeId: string, relPath: string): void {
    this.db
      .prepare(`UPDATE nodes SET screenshot_path = @path WHERE id = @id`)
      .run({ id: nodeId, path: relPath });
  }

  /** Runs the given mutations atomically in a single transaction. */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  exportGraph(): { branches: BranchRecord[]; nodes: IterationNode[] } {
    const branches = this.getBranches();
    const nodeRows = this.db
      .prepare(`SELECT * FROM nodes ORDER BY rowid ASC`)
      .all() as NodeRow[];
    return { branches, nodes: nodeRows.map(toIterationNode) };
  }

  close(): void {
    this.db.close();
  }
}
