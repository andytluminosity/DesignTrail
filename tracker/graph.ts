import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import Database from "better-sqlite3";
import type { BranchRecord, CommitData, IterationNode } from "./types.js";
import { MAIN_BRANCH } from "./branch.js";

// Resolve DesignTrail root so the DB lives in /data regardless of which repo's
// hook triggered the run (cwd is the committing repo, not DesignTrail).
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits (
  hash      TEXT PRIMARY KEY,
  message   TEXT,
  diff      TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,
  parent_branch_id TEXT,
  fork_node_id     TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  commit_hash     TEXT NOT NULL,
  branch_id       TEXT NOT NULL,
  parent_id       TEXT,
  summary         TEXT,
  type            TEXT,
  screenshot_path TEXT,
  timestamp       INTEGER NOT NULL
);
`;

type BranchRow = {
  id: string;
  parent_branch_id: string | null;
  fork_node_id: string | null;
  created_at: number;
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
};

function toBranchRecord(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    parentBranchId: row.parent_branch_id,
    forkNodeId: row.fork_node_id,
    createdAt: row.created_at,
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
    return new DesignGraph(db);
  }

  upsertCommit(commit: CommitData): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO commits (hash, message, diff, timestamp)
         VALUES (@hash, @message, @diff, @timestamp)`
      )
      .run({
        hash: commit.hash,
        message: commit.message,
        diff: commit.diff,
        timestamp: commit.timestamp,
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
    forkNodeId: string | null
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO branches (id, parent_branch_id, fork_node_id, created_at)
         VALUES (@id, @parentBranchId, @forkNodeId, @createdAt)`
      )
      .run({
        id,
        parentBranchId: id === MAIN_BRANCH ? null : parentBranchId,
        forkNodeId,
        createdAt: Date.now(),
      });
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
