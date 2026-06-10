import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CommitData } from "../tracker/types.js";

const DESIGNTRAIL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(DESIGNTRAIL_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const TOKEN_FILE = path.join(DESIGNTRAIL_ROOT, ".miro-token.json");
const TIMELINE_STATE_FILE = path.join(DESIGNTRAIL_ROOT, ".designtrail", "miro-timeline.json");
const TIMELINE_SPACING = 200;
// Horizontal gap between a single commit's screenshots, laid out left-to-right.
const COLUMN_SPACING = 420;
// Small downward nudge so a screenshot's label sits below its image instead of
// fully covering it.
const STICKY_NOTE_OFFSET_Y = 40;

type MiroPosition = {
  x: number;
  y: number;
};

type CreateMiroItemBase = {
  accessToken: string;
  boardId: string;
  position?: MiroPosition;
  anchorItemId?: string;
  anchorOffset?: Partial<MiroPosition>;
};

type CreateMiroImageInput = CreateMiroItemBase & {
  url: string;
};

type CreateMiroStickyNoteInput = CreateMiroItemBase & {
  content: string;
};

type MiroConnectorShape = "straight" | "elbowed" | "curved";

type MiroConnectorStyle = {
  strokeColor?: string;
  strokeWidth?: string;
  strokeStyle?: string;
  startStrokeCap?: string;
  endStrokeCap?: string;
  [key: string]: string | undefined;
};

type CreateMiroConnectorInput = {
  accessToken: string;
  boardId: string;
  startItemId: string;
  endItemId: string;
  shape?: MiroConnectorShape;
  style?: MiroConnectorStyle;
};

type MiroItemResponse = {
  id: string;
  position?: MiroPosition;
  [key: string]: unknown;
};

type MiroTimelineNode = {
  commitHash: string;
  miroNodeId: string;
  nodeType: "image" | "sticky_note";
  commitIndex: number;
  position: MiroPosition;
  previousNodeId: string | null;
  createdAt: string;
};

type MiroTimelineEdge = {
  previousNodeId: string;
  currentNodeId: string;
  previousCommitHash: string;
  currentCommitHash: string;
};

type MiroTimelineState = {
  commitIndex: number;
  nodes: MiroTimelineNode[];
  edges: MiroTimelineEdge[];
};

export type CommitScreenshot = {
  screenshotPath?: string;
  branchId: string;
  summary: string;
  annotation?: string;
  type?: string;
};

type CreateCommitNodeOptions = {
  screenshots: CommitScreenshot[];
  publicBaseUrl?: string;
};

function getStoredMiroAccessToken(): string | null {
  if (!existsSync(TOKEN_FILE)) {
    return null;
  }

  try {
    const tokenData = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as {
      accessToken?: string;
    };

    return tokenData.accessToken ?? null;
  } catch (error) {
    console.error("Could not read stored Miro token:", error);
    return null;
  }
}

function getMiroHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function postMiroItem(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<MiroItemResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: getMiroHeaders(accessToken),
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  const responseBody = parseResponseBody(responseText);

  if (!response.ok) {
    throw new Error(`Miro API error ${response.status}: ${JSON.stringify(responseBody)}`);
  }

  return responseBody as MiroItemResponse;
}

async function getMiroItem(
  accessToken: string,
  boardId: string,
  itemId: string
): Promise<MiroItemResponse> {
  const response = await fetch(
    `https://api.miro.com/v2/boards/${boardId}/items/${encodeURIComponent(itemId)}`,
    {
      method: "GET",
      headers: getMiroHeaders(accessToken),
    }
  );
  const responseText = await response.text();
  const responseBody = parseResponseBody(responseText);

  if (!response.ok) {
    throw new Error(`Miro API error ${response.status}: ${JSON.stringify(responseBody)}`);
  }

  return responseBody as MiroItemResponse;
}

function parseResponseBody(responseText: string): unknown {
  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function loadTimelineState(): MiroTimelineState {
  if (!existsSync(TIMELINE_STATE_FILE)) {
    return { commitIndex: 0, nodes: [], edges: [] };
  }

  try {
    const state = JSON.parse(readFileSync(TIMELINE_STATE_FILE, "utf8")) as Partial<MiroTimelineState>;

    return {
      commitIndex: typeof state.commitIndex === "number" ? state.commitIndex : 0,
      nodes: Array.isArray(state.nodes) ? state.nodes : [],
      edges: Array.isArray(state.edges) ? state.edges : [],
    };
  } catch (error) {
    console.error("Could not read Miro timeline state; starting a new timeline:", error);
    return { commitIndex: 0, nodes: [], edges: [] };
  }
}

function saveTimelineState(state: MiroTimelineState): void {
  mkdirSync(path.dirname(TIMELINE_STATE_FILE), { recursive: true });
  writeFileSync(TIMELINE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getTimelinePosition(commitIndex: number): MiroPosition {
  return {
    x: 0,
    y: commitIndex * TIMELINE_SPACING,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUrlBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function pathToUrlPath(value: string): string {
  return value
    .split(path.sep)
    .join("/")
    .replace(/^\/+/, "");
}

function getPublicScreenshotUrl(
  commit: CommitData,
  screenshotPath?: string,
  publicBaseUrlOverride?: string
): string {
  const publicBaseUrl =
    publicBaseUrlOverride ??
    process.env.CAPTURE_PUBLIC_URL ??
    process.env.PUBLIC_CAPTURE_URL ??
    process.env.CAPTURE_URL ??
    "http://localhost:3000";
  const normalizedBase = normalizeUrlBase(publicBaseUrl);

  if (screenshotPath) {
    return `${normalizedBase}/${pathToUrlPath(screenshotPath)}`;
  }

  const repoCapturePath = commit.repoName ? `${commit.repoName}/` : "";
  return `${normalizedBase}/captures/${repoCapturePath}${commit.hash}.png`;
}

function isMiroPosition(value: unknown): value is MiroPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MiroPosition).x === "number" &&
    typeof (value as MiroPosition).y === "number"
  );
}

async function resolveMiroPosition({
  accessToken,
  boardId,
  position = { x: 0, y: 0 },
  anchorItemId,
  anchorOffset = {},
}: CreateMiroItemBase): Promise<MiroPosition> {
  if (!anchorItemId) {
    return position;
  }

  const anchorItem = await getMiroItem(accessToken, boardId, anchorItemId);

  if (!isMiroPosition(anchorItem.position)) {
    throw new Error(`Miro item ${anchorItemId} does not expose a usable position.`);
  }

  return {
    x: anchorItem.position.x + (anchorOffset.x ?? 0),
    y: anchorItem.position.y + (anchorOffset.y ?? 0),
  };
}

export async function createMiroImage({
  accessToken,
  boardId,
  url,
  position = { x: 0, y: 0 },
  anchorItemId,
  anchorOffset,
}: CreateMiroImageInput): Promise<MiroItemResponse> {
  const resolvedPosition = await resolveMiroPosition({
    accessToken,
    boardId,
    position,
    anchorItemId,
    anchorOffset,
  });

  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/images`,
    accessToken,
    {
      data: { url },
      position: resolvedPosition,
    }
  );
}

export async function createMiroStickyNote({
  accessToken,
  boardId,
  content,
  position = { x: 0, y: 0 },
  anchorItemId,
  anchorOffset,
}: CreateMiroStickyNoteInput): Promise<MiroItemResponse> {
  const resolvedPosition = await resolveMiroPosition({
    accessToken,
    boardId,
    position,
    anchorItemId,
    anchorOffset,
  });

  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/sticky_notes`,
    accessToken,
    {
      data: { content },
      position: resolvedPosition,
    }
  );
}

export async function createConnector({
  accessToken,
  boardId,
  startItemId,
  endItemId,
  shape = "straight",
  style,
}: CreateMiroConnectorInput): Promise<MiroItemResponse> {
  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/connectors`,
    accessToken,
    {
      startItem: {
        id: startItemId,
        snapTo: "auto",
      },
      endItem: {
        id: endItemId,
        snapTo: "auto",
      },
      shape,
      ...(style ? { style } : {}),
    }
  );
}

/**
 * Builds a single screenshot's sticky-note content: a per-component label
 * (short hash + branch, type, summary, and the design annotation). The commit's
 * anchor note (the first screenshot, normally `main`) additionally carries the
 * commit-level metadata (message, source, commit annotation) so that context
 * appears exactly once per row.
 */
function buildStickyContent(
  commit: CommitData,
  shortHash: string,
  screenshot: CommitScreenshot,
  isAnchor: boolean
): string {
  const label = screenshot.branchId || "main";
  const lines = [`${shortHash} · ${label}`];
  if (screenshot.type) lines.push(screenshot.type);
  if (screenshot.summary) lines.push(screenshot.summary);
  if (screenshot.annotation) lines.push(screenshot.annotation);
  if (isAnchor) {
    lines.push(commit.message);
    if (commit.source) lines.push(`source: ${commit.source}`);
    if (commit.annotation) lines.push(commit.annotation);
  }
  return lines.join("\n");
}

export async function createCommitNode(
  commit: CommitData,
  options: CreateCommitNodeOptions = { screenshots: [] }
): Promise<MiroTimelineNode[]> {
  const accessToken = getStoredMiroAccessToken();
  const boardId = process.env.MIRO_BOARD_ID;

  if (!accessToken) {
    console.error("No stored Miro access token found. Complete OAuth first; skipping Miro upload.");
    return [];
  }

  if (!boardId) {
    console.error("MIRO_BOARD_ID is missing. Skipping Miro upload.");
    return [];
  }

  const shortHash = commit.hash.slice(0, 7);
  // Fall back to a single commit-level capture so a commit always lands on the
  // board even when no per-component screenshot succeeded.
  const screenshots: CommitScreenshot[] =
    options.screenshots.length > 0
      ? options.screenshots
      : [{ branchId: "", summary: "" }];

  const timelineState = loadTimelineState();
  const commitIndex = timelineState.commitIndex;
  const rowY = getTimelinePosition(commitIndex).y;
  const previousNode = timelineState.nodes.at(-1) ?? null;

  let anchorNode: MiroTimelineNode | null = null;

  for (let i = 0; i < screenshots.length; i += 1) {
    const screenshot = screenshots[i];
    const isAnchor = anchorNode === null;
    const position: MiroPosition = { x: i * COLUMN_SPACING, y: rowY };
    const screenshotUrl = getPublicScreenshotUrl(
      commit,
      screenshot.screenshotPath,
      options.publicBaseUrl
    );

    try {
      await createMiroImage({
        accessToken,
        boardId,
        url: screenshotUrl,
        position,
      });
      const note = await createMiroStickyNote({
        accessToken,
        boardId,
        content: buildStickyContent(commit, shortHash, screenshot, isAnchor),
        position: { x: position.x, y: position.y + STICKY_NOTE_OFFSET_Y },
      });

      console.log(
        `Miro screenshot uploaded (${screenshot.branchId || "main"}): note ${note.id}`
      );

      // The first screenshot that lands becomes the commit's timeline anchor so
      // commit-to-commit chaining stays one node per commit.
      if (anchorNode === null) {
        anchorNode = {
          commitHash: commit.hash,
          miroNodeId: note.id,
          nodeType: "sticky_note",
          commitIndex,
          position,
          previousNodeId: previousNode?.miroNodeId ?? null,
          createdAt: new Date().toISOString(),
        };
      }
    } catch (error: unknown) {
      console.error(
        `Failed to upload Miro screenshot (${screenshot.branchId || "main"}):`,
        getErrorMessage(error)
      );
    }
  }

  if (!anchorNode) {
    console.error("No Miro screenshots could be uploaded for this commit.");
    return [];
  }

  timelineState.nodes.push(anchorNode);

  if (previousNode) {
    timelineState.edges.push({
      previousNodeId: previousNode.miroNodeId,
      currentNodeId: anchorNode.miroNodeId,
      previousCommitHash: previousNode.commitHash,
      currentCommitHash: commit.hash,
    });
  }

  timelineState.commitIndex = commitIndex + 1;
  saveTimelineState(timelineState);

  console.log(`Miro timeline node stored at y=${rowY}`);

  return [anchorNode];
}
