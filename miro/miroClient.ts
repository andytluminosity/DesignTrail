import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CommitData } from "../tracker/types.js";
import {
  parseAnnotationBlocks,
  placeAnnotations,
  readPngDimensions,
  type AnnotationBlock,
  type AnnotationPlacement,
} from "./annotationPlacement.js";

const DESIGNTRAIL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(DESIGNTRAIL_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const TOKEN_FILE = path.join(DESIGNTRAIL_ROOT, ".miro-token.json");
const TIMELINE_STATE_FILE = path.join(DESIGNTRAIL_ROOT, ".designtrail", "miro-timeline.json");

// Display width (board units) we render every screenshot at. Height is derived
// from the PNG's real aspect ratio so we can map normalized element coordinates
// onto exact board positions. Used as a default aspect when dimensions are
// unknown.
const IMAGE_W = 600;
const DEFAULT_IMAGE_ASPECT = 0.66; // height/width fallback when PNG dims unreadable
// Approximate on-board footprint of a sticky note, used for spacing math.
const STICKY_W = 200;
const STICKY_H = 200;
// Gap between the image edge and the band of sticky notes, and between adjacent
// notes sharing an edge.
const NOTE_MARGIN = 90;
const NOTE_GAP = 28;

// A whole screenshot + its surrounding notes occupies this much board space, so
// adjacent screenshots (columns) and commits (rows) don't collide.
const TIMELINE_SPACING = 1200;
const COLUMN_SPACING = IMAGE_W + 2 * (NOTE_MARGIN + STICKY_W) + 160; // ≈ 1340

type Edge = "left" | "right" | "top" | "bottom";

type StickyLayoutItem = {
  index: number;
  position: MiroPosition;
  // Relative endpoint on the image (e.g. "42%") the connector points at.
  anchor: { x: string; y: string };
};

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
  width?: number;
};

type CreateMiroStickyNoteInput = CreateMiroItemBase & {
  content: string;
  width?: number;
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

type MiroRelativePosition = {
  x: string;
  y: string;
};

type CreateMiroConnectorInput = {
  accessToken: string;
  boardId: string;
  startItemId: string;
  endItemId: string;
  shape?: MiroConnectorShape;
  style?: MiroConnectorStyle;
  // Relative point on the end item the connector should land on (e.g. "50%"),
  // so an annotation line can point at a specific element inside the image.
  endPosition?: MiroRelativePosition;
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
  width,
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
      ...(width ? { geometry: { width } } : {}),
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
  width,
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
      ...(width ? { geometry: { width } } : {}),
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
  endPosition,
}: CreateMiroConnectorInput): Promise<MiroItemResponse> {
  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/connectors`,
    accessToken,
    {
      startItem: {
        id: startItemId,
        snapTo: "auto",
      },
      // When a relative endpoint is given, point the connector at that exact
      // spot on the end item (the element inside the image); otherwise let Miro
      // auto-snap to the nearest edge.
      endItem: endPosition
        ? { id: endItemId, position: endPosition }
        : { id: endItemId, snapTo: "auto" },
      shape,
      ...(style ? { style } : {}),
    }
  );
}

/**
 * Builds a screenshot's HEADER sticky-note content: a per-component label
 * (short hash + branch, type, summary). The per-element design annotation is no
 * longer embedded here — it is split into its own notes placed around the image.
 * The commit's anchor note (the first screenshot, normally `main`) additionally
 * carries the commit-level metadata (message, source, commit annotation) so that
 * context appears exactly once per row.
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
  if (isAnchor) {
    lines.push(commit.message);
    if (commit.source) lines.push(`source: ${commit.source}`);
    if (commit.annotation) lines.push(commit.annotation);
  }
  return lines.join("\n");
}

/**
 * Given an image's center and on-board size, lays each annotation out in the
 * margin nearest its element. Notes are bucketed by the closest edge, then
 * spaced apart along that edge so they don't overlap, while staying aligned to
 * the element they describe. Each item also carries the relative point on the
 * image (e.g. "42%") a connector should point at.
 */
function computeStickyLayout(
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
 * Creates one sticky note per annotation block in its computed margin slot and
 * draws a connector from each note to the exact element it describes on the
 * image. Individual note/connector failures are logged but never abort the rest.
 */
async function uploadAnnotationNotes(params: {
  accessToken: string;
  boardId: string;
  imageItemId: string;
  imageCenter: MiroPosition;
  imageH: number;
  blocks: AnnotationBlock[];
  placements: AnnotationPlacement[];
}): Promise<void> {
  const layout = computeStickyLayout(
    params.imageCenter,
    IMAGE_W,
    params.imageH,
    params.placements
  );
  const blockByIndex = new Map(params.blocks.map((block) => [block.index, block]));

  for (const item of layout) {
    const block = blockByIndex.get(item.index);
    if (!block) continue;

    try {
      const note = await createMiroStickyNote({
        accessToken: params.accessToken,
        boardId: params.boardId,
        content: block.text,
        position: item.position,
        width: STICKY_W,
      });
      await createConnector({
        accessToken: params.accessToken,
        boardId: params.boardId,
        startItemId: note.id,
        endItemId: params.imageItemId,
        endPosition: item.anchor,
      });
    } catch (error: unknown) {
      console.error("Failed to place annotation note:", getErrorMessage(error));
    }
  }
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
      const imageItem = await createMiroImage({
        accessToken,
        boardId,
        url: screenshotUrl,
        position,
        width: IMAGE_W,
      });

      // Derive the on-board image height from the PNG's real aspect ratio so
      // annotations map to exact element positions.
      const absPng = screenshot.screenshotPath
        ? path.join(DESIGNTRAIL_ROOT, screenshot.screenshotPath)
        : null;
      const dims = absPng ? await readPngDimensions(absPng) : null;
      const imageH = IMAGE_W * (dims ? dims.height / dims.width : DEFAULT_IMAGE_ASPECT);
      const left = position.x - IMAGE_W / 2;
      const top = position.y - imageH / 2;

      // Header note carries the commit/component metadata and is the commit's
      // timeline anchor. Sits diagonally off the image's top-left corner so it
      // stays clear of the per-element note bands.
      const headerNote = await createMiroStickyNote({
        accessToken,
        boardId,
        content: buildStickyContent(commit, shortHash, screenshot, isAnchor),
        position: {
          x: left - NOTE_MARGIN - STICKY_W / 2,
          y: top - NOTE_MARGIN - STICKY_H / 2,
        },
        width: STICKY_W,
      });

      // Split the annotation into per-element notes positioned around the image.
      // A vision model decides each note's on-image location; on any failure we
      // fall back to a single combined note beside the image so the commit is
      // never blocked.
      const annotation = (screenshot.annotation ?? "").trim();
      const blocks = annotation ? parseAnnotationBlocks(annotation) : [];
      const placements =
        absPng && blocks.length > 0 ? await placeAnnotations(absPng, blocks) : null;

      if (placements && placements.length > 0) {
        await uploadAnnotationNotes({
          accessToken,
          boardId,
          imageItemId: imageItem.id,
          imageCenter: position,
          imageH,
          blocks,
          placements,
        });
      } else if (annotation) {
        await createMiroStickyNote({
          accessToken,
          boardId,
          content: annotation,
          position: {
            x: position.x + IMAGE_W / 2 + NOTE_MARGIN + STICKY_W / 2,
            y: position.y,
          },
          width: STICKY_W,
        });
      }

      console.log(
        `Miro screenshot uploaded (${screenshot.branchId || "main"}): note ${headerNote.id}`
      );

      // The first screenshot that lands becomes the commit's timeline anchor so
      // commit-to-commit chaining stays one node per commit.
      if (anchorNode === null) {
        anchorNode = {
          commitHash: commit.hash,
          miroNodeId: headerNote.id,
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
