import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import Database from "better-sqlite3";
import type {
  AnnotationRecord,
  BranchRecord,
  CommitData,
  CommitType,
  IterationNode,
  NodeGeometry,
  Tree1Kind,
  Tree1NodeRecord,
  Tree2Classification,
  Tree3CommitScreenshot,
} from "./types.js";
import { keyToBranchId } from "./domKey.js";

// Resolve DesignTrail root so the DB lives in /data regardless of which repo's
// hook triggered the run (cwd is the committing repo, not DesignTrail).
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The three-tree schema. `commits` and `annotations` remain the shared support
// tables (commit history + the dual user/AI annotation layers); the three tree
// tables hold the design model:
//   - tree1_nodes:             Page -> Component -> ComponentVersion adjacency.
//   - tree2_classifications:   one persisted LLM group per component.
//   - tree3_commit_screenshots: one full-page screenshot per commit x route.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits (
  hash      TEXT PRIMARY KEY,
  message   TEXT,
  diff      TEXT,
  timestamp INTEGER NOT NULL,
  source    TEXT,
  annotation TEXT
);

CREATE TABLE IF NOT EXISTS tree1_nodes (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  parent_id       TEXT,
  nav_path        TEXT,
  component_key   TEXT,
  label           TEXT,
  commit_hash     TEXT,
  screenshot_path TEXT,
  screenshot_hash TEXT,
  summary         TEXT,
  annotation      TEXT,
  type            TEXT,
  created_at      INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,
  geom_x          REAL,
  geom_y          REAL,
  geom_w          REAL,
  geom_h          REAL,
  page_w          REAL,
  page_h          REAL
);

CREATE TABLE IF NOT EXISTS tree2_classifications (
  component_key   TEXT PRIMARY KEY,
  group_name      TEXT NOT NULL,
  label           TEXT,
  screenshot_path TEXT,
  screenshot_hash TEXT,
  classified_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree3_commit_screenshots (
  id                       TEXT PRIMARY KEY,
  commit_hash              TEXT NOT NULL,
  nav_path                 TEXT,
  screenshot_path          TEXT,
  screenshot_hash          TEXT,
  summary                  TEXT,
  timestamp                INTEGER NOT NULL,
  page_w                   REAL,
  page_h                   REAL,
  highlight_screenshot_path TEXT,
  highlight_screenshot_hash TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  source      TEXT NOT NULL,
  content     TEXT NOT NULL,
  color       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tree1_parent ON tree1_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_tree1_kind ON tree1_nodes (kind);
CREATE INDEX IF NOT EXISTS idx_tree1_component_key ON tree1_nodes (component_key);
CREATE INDEX IF NOT EXISTS idx_tree3_commit ON tree3_commit_screenshots (commit_hash);
CREATE INDEX IF NOT EXISTS idx_annotations_node_id ON annotations (node_id);
CREATE INDEX IF NOT EXISTS idx_annotations_commit_hash ON annotations (commit_hash);
`;

type Tree1Row = {
  id: string;
  kind: string;
  parent_id: string | null;
  nav_path: string | null;
  component_key: string | null;
  label: string | null;
  commit_hash: string | null;
  screenshot_path: string | null;
  screenshot_hash: string | null;
  summary: string | null;
  annotation: string | null;
  type: string | null;
  created_at: number;
  timestamp: number;
  geom_x: number | null;
  geom_y: number | null;
  geom_w: number | null;
  geom_h: number | null;
  page_w: number | null;
  page_h: number | null;
};

type Tree2Row = {
  component_key: string;
  group_name: string;
  label: string | null;
  screenshot_path: string | null;
  screenshot_hash: string | null;
  classified_at: number;
};

type Tree3Row = {
  id: string;
  commit_hash: string;
  nav_path: string | null;
  screenshot_path: string | null;
  screenshot_hash: string | null;
  summary: string | null;
  timestamp: number;
  page_w: number | null;
  page_h: number | null;
  highlight_screenshot_path: string | null;
  highlight_screenshot_hash: string | null;
};

type AnnotationRow = {
  id: string;
  node_id: string;
  commit_hash: string;
  source: AnnotationRecord["source"];
  content: string;
  color: AnnotationRecord["color"] | null;
  created_at: number;
};

function geometryFromCols(cols: {
  geom_x: number | null;
  geom_y: number | null;
  geom_w: number | null;
  geom_h: number | null;
  page_w: number | null;
  page_h: number | null;
}): NodeGeometry | undefined {
  if (
    cols.geom_x == null ||
    cols.geom_y == null ||
    cols.geom_w == null ||
    cols.geom_h == null ||
    cols.page_w == null ||
    cols.page_h == null
  ) {
    return undefined;
  }
  return {
    x: cols.geom_x,
    y: cols.geom_y,
    w: cols.geom_w,
    h: cols.geom_h,
    pageW: cols.page_w,
    pageH: cols.page_h,
  };
}

function toTree1Record(row: Tree1Row): Tree1NodeRecord {
  return {
    id: row.id,
    kind: row.kind as Tree1Kind,
    parentId: row.parent_id,
    navPath: row.nav_path,
    componentKey: row.component_key,
    label: row.label,
    commitHash: row.commit_hash,
    screenshotPath: row.screenshot_path ?? "",
    screenshotHash: row.screenshot_hash,
    summary: row.summary ?? "",
    annotation: row.annotation ?? undefined,
    type: (row.type as CommitType) ?? "UNKNOWN",
    createdAt: row.created_at,
    timestamp: row.timestamp,
    geometry: geometryFromCols(row),
  };
}

function toClassification(row: Tree2Row): Tree2Classification {
  return {
    componentKey: row.component_key,
    groupName: row.group_name,
    label: row.label,
    screenshotPath: row.screenshot_path ?? "",
    screenshotHash: row.screenshot_hash,
    classifiedAt: row.classified_at,
  };
}

function toCommitScreenshot(row: Tree3Row): Tree3CommitScreenshot {
  return {
    id: row.id,
    commitHash: row.commit_hash,
    navPath: row.nav_path,
    screenshotPath: row.screenshot_path ?? "",
    screenshotHash: row.screenshot_hash,
    summary: row.summary ?? "",
    timestamp: row.timestamp,
    pageW: row.page_w ?? undefined,
    pageH: row.page_h ?? undefined,
    highlightScreenshotPath: row.highlight_screenshot_path ?? undefined,
    highlightScreenshotHash: row.highlight_screenshot_hash ?? undefined,
  };
}

function toAnnotationRecord(row: AnnotationRow): AnnotationRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    commitHash: row.commit_hash,
    source: row.source,
    content: row.content,
    color: row.color ?? undefined,
    createdAt: row.created_at,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

// Input shapes for the Tree 1 upserts. Geometry is optional and applied across
// the six geometry columns when present.
export type Tree1NodeInput = {
  id: string;
  kind: Tree1Kind;
  parentId: string | null;
  navPath: string | null;
  componentKey: string | null;
  label: string | null;
  commitHash: string | null;
  screenshotPath: string;
  screenshotHash: string | null;
  summary: string;
  type: CommitType;
  timestamp: number;
  geometry?: NodeGeometry;
};

/**
 * Per-repo three-tree design model stored in SQLite. Synchronous
 * (better-sqlite3), so all reads/writes complete inline; state is rebuilt from
 * disk on every load because each commit runs in a fresh process.
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

    // Breaking schema change: a database from the old branch/iteration model is
    // dropped and recreated from scratch (no migration path). Stale screenshots
    // are cleared too so the captures mirror starts clean.
    const legacy =
      (tableExists(db, "nodes") || tableExists(db, "branches")) &&
      !tableExists(db, "tree1_nodes");
    if (legacy) {
      db.exec(
        `DROP TABLE IF EXISTS nodes;
         DROP TABLE IF EXISTS branches;
         DROP TABLE IF EXISTS annotations;
         DROP TABLE IF EXISTS commits;`
      );
      await fse.remove(path.join(TRACKER_ROOT, "captures", repoName));
    }

    db.exec(SCHEMA);

    // Additive migration: older databases predate the highlighted commit-overview
    // variant, so add the columns in place rather than dropping data.
    if (
      tableExists(db, "tree3_commit_screenshots") &&
      !columnExists(db, "tree3_commit_screenshots", "highlight_screenshot_path")
    ) {
      db.exec(
        `ALTER TABLE tree3_commit_screenshots ADD COLUMN highlight_screenshot_path TEXT;
         ALTER TABLE tree3_commit_screenshots ADD COLUMN highlight_screenshot_hash TEXT;`
      );
    }

    return new DesignGraph(db);
  }

  // ----- commits -----------------------------------------------------------

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

  getCommits(): Map<string, CommitData> {
    const rows = this.db.prepare(`SELECT * FROM commits`).all() as {
      hash: string;
      message: string;
      diff: string;
      timestamp: number;
      source: string | null;
      annotation: string | null;
    }[];
    const map = new Map<string, CommitData>();
    for (const row of rows) {
      map.set(row.hash, {
        hash: row.hash,
        message: row.message,
        diff: row.diff,
        timestamp: row.timestamp,
        source: row.source ?? undefined,
        annotation: row.annotation ?? undefined,
      });
    }
    return map;
  }

  // ----- annotations -------------------------------------------------------

  upsertAnnotation(annotation: AnnotationRecord): void {
    this.db
      .prepare(
        `INSERT INTO annotations (id, node_id, commit_hash, source, content, color, created_at)
         VALUES (@id, @nodeId, @commitHash, @source, @content, @color, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           node_id = excluded.node_id,
           commit_hash = excluded.commit_hash,
           source = excluded.source,
           content = excluded.content,
           color = excluded.color,
           created_at = excluded.created_at`
      )
      .run({
        ...annotation,
        color: annotation.color ?? null,
      });
  }

  getAnnotations(): AnnotationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM annotations ORDER BY created_at ASC, rowid ASC`)
      .all() as AnnotationRow[];
    return rows.map(toAnnotationRecord);
  }

  deleteAnnotation(nodeId: string, source: AnnotationRecord["source"]): void {
    this.db
      .prepare(`DELETE FROM annotations WHERE node_id = ? AND source = ?`)
      .run(nodeId, source);
  }

  // ----- Tree 1 (Page / Component / ComponentVersion) ----------------------

  /**
   * Inserts a Tree 1 node if new, or refreshes its mutable fields (screenshot,
   * summary, type, commit, timestamp, geometry) on conflict. Page and component
   * rows call this every commit so they always mirror the latest capture;
   * version rows are written once (their id embeds the commit).
   */
  upsertTree1Node(node: Tree1NodeInput): void {
    const geom = node.geometry;
    this.db
      .prepare(
        `INSERT INTO tree1_nodes
           (id, kind, parent_id, nav_path, component_key, label, commit_hash,
            screenshot_path, screenshot_hash, summary, type, created_at, timestamp,
            geom_x, geom_y, geom_w, geom_h, page_w, page_h)
         VALUES
           (@id, @kind, @parentId, @navPath, @componentKey, @label, @commitHash,
            @screenshotPath, @screenshotHash, @summary, @type, @createdAt, @timestamp,
            @geomX, @geomY, @geomW, @geomH, @pageW, @pageH)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           nav_path = excluded.nav_path,
           component_key = excluded.component_key,
           label = excluded.label,
           commit_hash = excluded.commit_hash,
           screenshot_path = excluded.screenshot_path,
           screenshot_hash = excluded.screenshot_hash,
           summary = excluded.summary,
           type = excluded.type,
           timestamp = excluded.timestamp,
           geom_x = excluded.geom_x,
           geom_y = excluded.geom_y,
           geom_w = excluded.geom_w,
           geom_h = excluded.geom_h,
           page_w = excluded.page_w,
           page_h = excluded.page_h`
      )
      .run({
        id: node.id,
        kind: node.kind,
        parentId: node.parentId,
        navPath: node.navPath,
        componentKey: node.componentKey,
        label: node.label,
        commitHash: node.commitHash,
        screenshotPath: node.screenshotPath,
        screenshotHash: node.screenshotHash,
        summary: node.summary,
        type: node.type,
        createdAt: node.timestamp,
        timestamp: node.timestamp,
        geomX: geom?.x ?? null,
        geomY: geom?.y ?? null,
        geomW: geom?.w ?? null,
        geomH: geom?.h ?? null,
        pageW: geom?.pageW ?? null,
        pageH: geom?.pageH ?? null,
      });
  }

  getTree1Node(id: string): Tree1NodeRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tree1_nodes WHERE id = ?`)
      .get(id) as Tree1Row | undefined;
    return row ? toTree1Record(row) : null;
  }

  getTree1Nodes(): Tree1NodeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tree1_nodes ORDER BY rowid ASC`)
      .all() as Tree1Row[];
    return rows.map(toTree1Record);
  }

  /** Version rows under a component, in chronological (insertion/rowid) order. */
  getComponentVersions(componentId: string): Tree1NodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tree1_nodes WHERE kind = 'version' AND parent_id = ? ORDER BY rowid ASC`
      )
      .all(componentId) as Tree1Row[];
    return rows.map(toTree1Record);
  }

  /** Screenshot hash of a component's most recent version, or null if none. */
  getLatestVersionHash(componentId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT screenshot_hash FROM tree1_nodes
          WHERE kind = 'version' AND parent_id = ?
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(componentId) as { screenshot_hash: string | null } | undefined;
    return row?.screenshot_hash ?? null;
  }

  setTree1NodeAnnotation(id: string, annotation: string): void {
    this.db
      .prepare(`UPDATE tree1_nodes SET annotation = @annotation WHERE id = @id`)
      .run({ id, annotation });
  }

  clearTree1NodeAnnotation(id: string): void {
    this.db.prepare(`UPDATE tree1_nodes SET annotation = NULL WHERE id = ?`).run(id);
  }

  // ----- Tree 2 (Component Library classifications) ------------------------

  getClassification(componentKey: string): Tree2Classification | null {
    const row = this.db
      .prepare(`SELECT * FROM tree2_classifications WHERE component_key = ?`)
      .get(componentKey) as Tree2Row | undefined;
    return row ? toClassification(row) : null;
  }

  getClassifications(): Tree2Classification[] {
    const rows = this.db
      .prepare(`SELECT * FROM tree2_classifications ORDER BY group_name ASC, rowid ASC`)
      .all() as Tree2Row[];
    return rows.map(toClassification);
  }

  /** Distinct, persisted group names, so the classifier can reuse them. */
  getClassificationGroups(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT group_name FROM tree2_classifications ORDER BY group_name ASC`)
      .all() as { group_name: string }[];
    return rows.map((r) => r.group_name);
  }

  upsertClassification(rec: Tree2Classification): void {
    this.db
      .prepare(
        `INSERT INTO tree2_classifications
           (component_key, group_name, label, screenshot_path, screenshot_hash, classified_at)
         VALUES
           (@componentKey, @groupName, @label, @screenshotPath, @screenshotHash, @classifiedAt)
         ON CONFLICT(component_key) DO UPDATE SET
           group_name = excluded.group_name,
           label = excluded.label,
           screenshot_path = excluded.screenshot_path,
           screenshot_hash = excluded.screenshot_hash,
           classified_at = excluded.classified_at`
      )
      .run({
        componentKey: rec.componentKey,
        groupName: rec.groupName,
        label: rec.label,
        screenshotPath: rec.screenshotPath,
        screenshotHash: rec.screenshotHash,
        classifiedAt: rec.classifiedAt,
      });
  }

  /** Refreshes only the latest screenshot for an already-classified component. */
  setClassificationScreenshot(
    componentKey: string,
    screenshotPath: string,
    screenshotHash: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE tree2_classifications
            SET screenshot_path = @screenshotPath, screenshot_hash = @screenshotHash
          WHERE component_key = @componentKey`
      )
      .run({ componentKey, screenshotPath, screenshotHash });
  }

  // ----- Tree 3 (Commit overview) -----------------------------------------

  upsertCommitScreenshot(row: Tree3CommitScreenshot): void {
    this.db
      .prepare(
        `INSERT INTO tree3_commit_screenshots
           (id, commit_hash, nav_path, screenshot_path, screenshot_hash, summary, timestamp, page_w, page_h)
         VALUES
           (@id, @commitHash, @navPath, @screenshotPath, @screenshotHash, @summary, @timestamp, @pageW, @pageH)
         ON CONFLICT(id) DO UPDATE SET
           screenshot_path = excluded.screenshot_path,
           screenshot_hash = excluded.screenshot_hash,
           summary = excluded.summary,
           timestamp = excluded.timestamp,
           page_w = excluded.page_w,
           page_h = excluded.page_h`
      )
      .run({
        id: row.id,
        commitHash: row.commitHash,
        navPath: row.navPath,
        screenshotPath: row.screenshotPath,
        screenshotHash: row.screenshotHash,
        summary: row.summary,
        timestamp: row.timestamp,
        pageW: row.pageW ?? null,
        pageH: row.pageH ?? null,
      });
  }

  /**
   * Records (or clears) the highlighted variant for an already-stored commit
   * overview screenshot. Kept separate from the upsert because the highlight is
   * captured as its own job and applied after the plain full-page row exists.
   */
  setCommitScreenshotHighlight(
    id: string,
    highlightScreenshotPath: string | null,
    highlightScreenshotHash: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE tree3_commit_screenshots
            SET highlight_screenshot_path = @highlightScreenshotPath,
                highlight_screenshot_hash = @highlightScreenshotHash
          WHERE id = @id`
      )
      .run({ id, highlightScreenshotPath, highlightScreenshotHash });
  }

  getCommitScreenshots(): Tree3CommitScreenshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM tree3_commit_screenshots ORDER BY timestamp ASC, rowid ASC`)
      .all() as Tree3Row[];
    return rows.map(toCommitScreenshot);
  }

  // ----- render adapters ---------------------------------------------------
  //
  // The Miro/HTML renderers draw any tree from a flat BranchRecord[] +
  // IterationNode[] pair (a branch is one horizontal level row; nodes chain
  // chronologically within it; child branches sit one level below). These
  // adapters project each stored tree onto that shape so the existing layout and
  // drawing code is reused unchanged.

  /**
   * Tree 1 as branches/nodes: each page is a root branch with one node; each
   * component is a branch (under its page) with one node mirroring the latest
   * version; each component's versions form a child branch whose nodes are the
   * chronological history. Yields exactly three levels: page -> component ->
   * versions.
   */
  exportTree1Graph(): { branches: BranchRecord[]; nodes: IterationNode[] } {
    const rows = this.getTree1Nodes();
    const branches: BranchRecord[] = [];
    const nodes: IterationNode[] = [];

    const toNode = (
      r: Tree1NodeRecord,
      branchId: string,
      parentId: string | null
    ): IterationNode => ({
      id: r.id,
      commitHash: r.commitHash ?? "",
      branchId,
      parentId,
      summary: r.summary,
      annotation: r.annotation,
      type: r.type,
      screenshotPath: r.screenshotPath,
      timestamp: r.timestamp,
      geometry: r.geometry,
    });

    for (const r of rows) {
      if (r.kind === "page") {
        branches.push({
          id: r.id,
          parentBranchId: null,
          forkNodeId: null,
          createdAt: r.createdAt,
          navPath: r.navPath ?? undefined,
        });
        nodes.push(toNode(r, r.id, null));
      } else if (r.kind === "component") {
        branches.push({
          id: r.id,
          parentBranchId: r.parentId,
          forkNodeId: r.parentId, // fork from the page node (page node id == page branch id)
          createdAt: r.createdAt,
          navPath: r.navPath ?? undefined,
        });
        nodes.push(toNode(r, r.id, null));
      }
    }

    // Versions: one child branch per component, nodes chained chronologically.
    const versionsByComponent = new Map<string, Tree1NodeRecord[]>();
    for (const r of rows) {
      if (r.kind !== "version" || !r.parentId) continue;
      const list = versionsByComponent.get(r.parentId) ?? [];
      list.push(r);
      versionsByComponent.set(r.parentId, list);
    }
    for (const [componentId, versions] of versionsByComponent) {
      const versionsBranchId = `versions:${componentId}`;
      branches.push({
        id: versionsBranchId,
        parentBranchId: componentId,
        forkNodeId: componentId, // fork from the component node
        createdAt: versions[0]?.createdAt ?? Date.now(),
        navPath: versions[0]?.navPath ?? undefined,
      });
      let prevId: string | null = null;
      for (const v of versions) {
        nodes.push(toNode(v, versionsBranchId, prevId));
        prevId = v.id;
      }
    }

    return { branches, nodes };
  }

  /**
   * Tree 2 as branches/nodes: each component group is a root branch with one
   * label node (no screenshot); each component is a child branch with one node
   * showing its latest screenshot.
   */
  exportTree2Graph(): { branches: BranchRecord[]; nodes: IterationNode[] } {
    const classifications = this.getClassifications();
    const branches: BranchRecord[] = [];
    const nodes: IterationNode[] = [];

    const byGroup = new Map<string, Tree2Classification[]>();
    for (const c of classifications) {
      const list = byGroup.get(c.groupName) ?? [];
      list.push(c);
      byGroup.set(c.groupName, list);
    }

    let order = 0;
    for (const [groupName, members] of byGroup) {
      const groupBranchId = `group:${groupName}`;
      branches.push({
        id: groupBranchId,
        parentBranchId: null,
        forkNodeId: null,
        createdAt: order++,
      });
      // Label node: empty screenshotPath marks it as a sticky-note label.
      nodes.push({
        id: groupBranchId,
        commitHash: "",
        branchId: groupBranchId,
        parentId: null,
        summary: groupName,
        type: "UNKNOWN",
        screenshotPath: "",
        timestamp: order,
      });

      for (const member of members) {
        const compBranchId = `t2:${keyToBranchId({
          key: member.componentKey,
          label: member.label ?? "component",
        })}`;
        branches.push({
          id: compBranchId,
          parentBranchId: groupBranchId,
          forkNodeId: groupBranchId,
          createdAt: order++,
        });
        nodes.push({
          id: compBranchId,
          commitHash: "",
          branchId: compBranchId,
          parentId: null,
          summary: member.label ?? "component",
          type: "UI_CHANGE",
          screenshotPath: member.screenshotPath,
          timestamp: order,
        });
      }
    }

    return { branches, nodes };
  }

  /**
   * Tree 3 as branches/nodes: a single chronological chain of full-page
   * screenshots (one per commit x route), so the commit overview reads as one
   * row of "what each commit changed". When a screenshot has a highlighted
   * variant (the same page with its changed containers outlined in red), that
   * variant is emitted as a one-node child branch forking off the original, so
   * it hangs directly below it without altering the original row.
   */
  exportTree3Graph(): { branches: BranchRecord[]; nodes: IterationNode[] } {
    const rows = this.getCommitScreenshots();
    if (rows.length === 0) return { branches: [], nodes: [] };

    const branchId = "commit-overview";
    const branches: BranchRecord[] = [
      {
        id: branchId,
        parentBranchId: null,
        forkNodeId: null,
        createdAt: rows[0].timestamp,
      },
    ];
    const nodes: IterationNode[] = [];
    let prevId: string | null = null;
    for (const r of rows) {
      nodes.push({
        id: r.id,
        commitHash: r.commitHash,
        branchId,
        parentId: prevId,
        summary: r.summary,
        type: "UNKNOWN",
        screenshotPath: r.screenshotPath,
        timestamp: r.timestamp,
      });
      prevId = r.id;

      if (r.highlightScreenshotPath) {
        const highlightBranchId = `commit-overview-highlight:${r.id}`;
        branches.push({
          id: highlightBranchId,
          parentBranchId: branchId,
          forkNodeId: r.id, // hang directly under the original screenshot
          createdAt: r.timestamp,
        });
        nodes.push({
          id: `${r.id}:highlight`,
          commitHash: r.commitHash,
          branchId: highlightBranchId,
          parentId: null,
          summary: "Highlighted changes",
          type: "UNKNOWN",
          screenshotPath: r.highlightScreenshotPath,
          timestamp: r.timestamp,
        });
      }
    }
    return { branches, nodes };
  }

  /** Runs the given mutations atomically in a single transaction. */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
