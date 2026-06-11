import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  AnnotationColor,
  AnnotationRecord,
  BranchRecord,
  CommitData,
  IterationNode,
} from "../tracker/types.js";
import {
  parseAnnotationBlocks,
  placeAnnotations,
  readPngDimensions,
  type AnnotationBlock,
  type AnnotationPlacement,
} from "./annotationPlacement.js";
import {
  computeClusterFootprint,
  computeStickyLayout,
  planTreeLayout,
  DEFAULT_IMAGE_ASPECT,
  IMAGE_W,
  NOTE_MARGIN,
  STICKY_W,
  STICKY_H,
  type ClusterFootprint,
  type MiroPosition,
  type MiroRelativePosition,
  type NodeBox,
} from "./treeLayout.js";
import {
  planSignificancePrune,
  applySignificancePrune,
} from "../tracker/significancePrune.js";
import { MAIN_BRANCH } from "../tracker/branch.js";

const DESIGNTRAIL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Horizontal gap between the full-history tree and the significance-pruned tree
// drawn beside it. Much larger than the in-tree H_GAP so the two never touch.
const TREE_GAP = 4000;
// Vertical clearance above a tree where its title note sits.
const TREE_TITLE_OFFSET = 500;
// Extra space between a tree's outermost cluster/title and its gray frame.
const TREE_FRAME_PADDING = 350;

try {
  process.loadEnvFile(path.join(DESIGNTRAIL_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const TOKEN_FILE = path.join(DESIGNTRAIL_ROOT, ".miro-token.json");

// Max in-flight Miro API calls. Miro rate-limits per user+app (HTTP 429), so
// calls run in parallel but are globally capped at this concurrency. Kept modest
// because concurrent writes to a single board trip 429s well before the raw
// credit budget; retry/backoff handles any that still hit the limit.
const MIRO_CONCURRENCY = Number(process.env.MIRO_CONCURRENCY ?? 4);
// Minimum spacing between successive Miro request starts (token-bucket style), so
// a burst of parallel work doesn't fire dozens of calls in the same instant.
const MIN_MIRO_REQUEST_INTERVAL_MS = Number(process.env.MIRO_MIN_INTERVAL_MS ?? 200);
// Retry policy for 429 / 5xx responses (and transient network errors).
const MAX_MIRO_RETRIES = 8;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;
// Max in-flight precompute tasks (PNG read + OpenAI vision placement) before the
// board is drawn. Bounded so a large graph doesn't hammer the OpenAI API.
const PRECOMPUTE_CONCURRENCY = 6;

/**
 * Caps how many async tasks run concurrently. A finished task hands its slot to
 * the next waiter, so at most `max` tasks are ever in flight.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the held slot directly to the next waiter (active stays constant).
      next();
    } else {
      this.active -= 1;
    }
  }
}

// Shared limiter for every Miro write so unbounded Promise.all bursts across the
// render stay within MIRO_CONCURRENCY.
const miroLimiter = new Semaphore(MIRO_CONCURRENCY);

/**
 * Runs `worker` over `items` with at most `limit` concurrent invocations,
 * preserving input order in the returned results.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runnerCount = Math.min(Math.max(1, limit), items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Token-bucket spacing: tracks the earliest time the next request may start so
// concurrent callers don't all fire in the same instant.
let nextRequestAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + MIN_MIRO_REQUEST_INTERVAL_MS;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

/**
 * How long to wait before retrying a throttled/failed Miro response: prefer the
 * `Retry-After` header (seconds), then `X-RateLimit-Reset` (epoch seconds),
 * otherwise exponential backoff with jitter, all capped at MAX_BACKOFF_MS.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }

  const reset = response.headers.get("X-RateLimit-Reset");
  if (reset) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs + 250, MAX_BACKOFF_MS);
    }
  }

  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/**
 * Single entry point for every Miro HTTP call. Caps total concurrency, spaces
 * out request starts, and retries 429 / 5xx responses (and transient network
 * errors) with backoff that honors Miro's `Retry-After` header, so a rate-limited
 * call waits and succeeds instead of being dropped. The retry holds its
 * concurrency slot while backing off, which naturally pauses the whole render
 * when the board is being throttled.
 */
async function miroFetch(url: string, init: RequestInit): Promise<Response> {
  return miroLimiter.run(async () => {
    for (let attempt = 0; ; attempt += 1) {
      await throttle();

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        if (attempt >= MAX_MIRO_RETRIES) throw error;
        const exponential = BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(Math.min(exponential + Math.random() * BASE_BACKOFF_MS, MAX_BACKOFF_MS));
        continue;
      }

      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      if (attempt >= MAX_MIRO_RETRIES) {
        return response;
      }

      const delay = retryDelayMs(response, attempt);
      // Drain the body so the connection can be reused before we back off.
      await response.text().catch(() => undefined);
      await sleep(delay);
    }
  });
}

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

type CreateMiroImageFromFileInput = CreateMiroItemBase & {
  filePath: string;
  width?: number;
};

type CreateMiroStickyNoteInput = CreateMiroItemBase & {
  content: string;
  width?: number;
  color?: AnnotationColor;
};

type CreateMiroShapeInput = CreateMiroItemBase & {
  shape: "rectangle";
  width: number;
  height: number;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: string;
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
  // Relative point on the end item the connector should land on (e.g. "50%"),
  // so an annotation line can point at a specific element inside the image.
  endPosition?: MiroRelativePosition;
};

type MiroItemResponse = {
  id: string;
  position?: MiroPosition;
  [key: string]: unknown;
};

// One screenshot node that was successfully placed on the board.
export type RenderedBoardNode = {
  nodeId: string;
  miroImageId: string;
};

type RenderBoardOptions = {
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

async function postMiroItem(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<MiroItemResponse> {
  const response = await miroFetch(url, {
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

async function postMiroMultipartItem(
  url: string,
  accessToken: string,
  body: Buffer,
  boundary: string
): Promise<MiroItemResponse> {
  const response = await miroFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body as unknown as BodyInit,
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
  const response = await miroFetch(
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

/**
 * The clean (unboxed) sidecar path for a full-page `main` capture. The DOM climb
 * saves `main.png` with the change highlight box (used by the full + compressed
 * trees) and a `main-original.png` copy without it (used by the commit-overview
 * tree). Derived by name convention so it tracks the node's current PNG path.
 */
function originalMainSidecarPath(screenshotPath: string): string {
  return screenshotPath.replace(/\.png$/i, "-original.png");
}

/** Public URL Miro fetches a saved screenshot from, derived from its repo path. */
function publicScreenshotUrl(screenshotPath: string, override?: string): string {
  const base =
    override ??
    process.env.CAPTURE_PUBLIC_URL ??
    process.env.PUBLIC_CAPTURE_URL ??
    process.env.CAPTURE_URL ??
    "http://localhost:3000";
  return `${normalizeUrlBase(base)}/${pathToUrlPath(screenshotPath)}`;
}

/**
 * Pages through a board collection (items or connectors) and returns every id.
 * Miro returns at most `limit` per page plus a `cursor` for the next page.
 */
async function listAllIds(
  accessToken: string,
  url: string
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", "50");
    if (cursor) pageUrl.searchParams.set("cursor", cursor);

    const response = await miroFetch(pageUrl.toString(), {
      method: "GET",
      headers: getMiroHeaders(accessToken),
    });
    const body = parseResponseBody(await response.text());
    if (!response.ok) {
      throw new Error(`Miro API error ${response.status}: ${JSON.stringify(body)}`);
    }

    const data = (body as { data?: Array<{ id?: unknown }> })?.data;
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry?.id != null) ids.push(String(entry.id));
      }
    }
    cursor = (body as { cursor?: string })?.cursor;
  } while (cursor);

  return ids;
}

async function deleteBoardResource(
  accessToken: string,
  url: string
): Promise<void> {
  const response = await miroFetch(url, {
    method: "DELETE",
    headers: getMiroHeaders(accessToken),
  });
  if (!response.ok && response.status !== 404) {
    const body = parseResponseBody(await response.text());
    throw new Error(`Miro API error ${response.status}: ${JSON.stringify(body)}`);
  }
}

/**
 * Wipes the entire board: deletes all connectors first, then every item.
 * Individual failures are logged but never abort the wipe, so a stale element
 * can't block the re-render that follows.
 */
export async function clearBoard(accessToken: string, boardId: string): Promise<void> {
  const base = `https://api.miro.com/v2/boards/${boardId}`;

  const [connectorIds, itemIds] = await Promise.all([
    listAllIds(accessToken, `${base}/connectors`).catch((error) => {
      console.error("Failed to list Miro connectors:", getErrorMessage(error));
      return [] as string[];
    }),
    listAllIds(accessToken, `${base}/items`).catch((error) => {
      console.error("Failed to list Miro items:", getErrorMessage(error));
      return [] as string[];
    }),
  ]);

  // Delete connectors and items together; the limiter inside deleteBoardResource
  // caps how many run at once. A connector already removed via an item deletion
  // just returns 404, which is ignored.
  const urls = [
    ...connectorIds.map((id) => `${base}/connectors/${encodeURIComponent(id)}`),
    ...itemIds.map((id) => `${base}/items/${encodeURIComponent(id)}`),
  ];

  await Promise.all(
    urls.map(async (url) => {
      try {
        await deleteBoardResource(accessToken, url);
      } catch (error) {
        console.error(`Failed to delete ${url}:`, getErrorMessage(error));
      }
    })
  );
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

export async function createMiroImageFromFile({
  accessToken,
  boardId,
  filePath,
  position = { x: 0, y: 0 },
  anchorItemId,
  anchorOffset,
  width,
}: CreateMiroImageFromFileInput): Promise<MiroItemResponse> {
  const resolvedPosition = await resolveMiroPosition({
    accessToken,
    boardId,
    position,
    anchorItemId,
    anchorOffset,
  });

  const imageBytes = readFileSync(filePath);
  const boundary = `----DesignTrail${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2)}`;
  const fileName = path.basename(filePath).replace(/"/g, "");
  const data = JSON.stringify({
    position: resolvedPosition,
    ...(width ? { geometry: { width } } : {}),
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="data"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${data}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="resource"; filename="${fileName}"\r\n` +
        `Content-Type: image/png\r\n\r\n`
    ),
    imageBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return postMiroMultipartItem(
    `https://api.miro.com/v2/boards/${boardId}/images`,
    accessToken,
    body,
    boundary
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
  color,
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
      ...(color ? { style: { fillColor: color } } : {}),
      ...(width ? { geometry: { width } } : {}),
    }
  );
}

async function createMiroShape({
  accessToken,
  boardId,
  shape,
  position = { x: 0, y: 0 },
  anchorItemId,
  anchorOffset,
  width,
  height,
  fillColor = "#f2f2f2",
  borderColor = "#808080",
  borderWidth = "2",
}: CreateMiroShapeInput): Promise<MiroItemResponse> {
  const resolvedPosition = await resolveMiroPosition({
    accessToken,
    boardId,
    position,
    anchorItemId,
    anchorOffset,
  });

  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/shapes`,
    accessToken,
    {
      data: { shape },
      position: resolvedPosition,
      geometry: { width, height },
      style: {
        fillColor,
        borderColor,
        borderWidth,
      },
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
 * (short hash + branch, type, summary) plus commit-level metadata. Manual commit
 * annotations render as their own designated sticky note, not hidden here.
 */
function groupAnnotationsByNode(
  annotations: AnnotationRecord[]
): Map<string, AnnotationRecord[]> {
  const map = new Map<string, AnnotationRecord[]>();
  for (const annotation of annotations) {
    const list = map.get(annotation.nodeId) ?? [];
    list.push(annotation);
    map.set(annotation.nodeId, list);
  }
  return map;
}

function getAnnotationContent(
  annotations: AnnotationRecord[] | undefined,
  source: AnnotationRecord["source"],
  fallback?: string
): string {
  const record = annotations?.find((annotation) => annotation.source === source);
  return (record?.content ?? fallback ?? "").trim();
}

function colorForAnnotationSource(
  source: AnnotationRecord["source"]
): AnnotationColor | undefined {
  if (source === "ai") return "yellow";
  if (source === "user") return "blue";
  return undefined;
}

function getAnnotationColor(
  annotations: AnnotationRecord[] | undefined,
  source: AnnotationRecord["source"]
): AnnotationColor | undefined {
  return (
    annotations?.find((annotation) => annotation.source === source)?.color ??
    colorForAnnotationSource(source)
  );
}

function buildStickyContent(params: {
  node: IterationNode;
  commit: CommitData | undefined;
  annotations: AnnotationRecord[] | undefined;
}): string {
  const { node, commit, annotations } = params;
  const shortHash = node.commitHash.slice(0, 7);
  const label = node.branchId || "main";
  const lines = [`${shortHash} · ${label}`];
  if (node.type) lines.push(node.type);
  if (node.summary) lines.push(node.summary);
  const commitMessage = getAnnotationContent(
    annotations,
    "commit_message",
    commit?.message
  );
  if (commitMessage) lines.push(commitMessage);
  if (commit) {
    if (commit.source) lines.push(`source: ${commit.source}`);
  }
  return lines.join("\n");
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
  color?: AnnotationColor;
}): Promise<void> {
  const layout = computeStickyLayout(
    params.imageCenter,
    IMAGE_W,
    params.imageH,
    params.placements
  );
  const blockByIndex = new Map(params.blocks.map((block) => [block.index, block]));

  await Promise.all(
    layout.map(async (item) => {
      const block = blockByIndex.get(item.index);
      if (!block) return;

      try {
        const note = await createMiroStickyNote({
          accessToken: params.accessToken,
          boardId: params.boardId,
          content: block.text,
          position: item.position,
          width: STICKY_W,
          color: params.color,
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
    })
  );
}

async function uploadManualAnnotationNote(params: {
  accessToken: string;
  boardId: string;
  imageItemId: string;
  imageCenter: MiroPosition;
  imageH: number;
  nodeId: string;
  content: string;
  color?: AnnotationColor;
}): Promise<void> {
  const layout = computeStickyLayout(params.imageCenter, IMAGE_W, params.imageH, [
    { index: 1, x: 1, y: 0.5 },
  ]);
  const item = layout[0];
  if (!item) {
    console.error(`Manual annotation note skipped for ${params.nodeId}: no layout slot.`);
    return;
  }

  let note: MiroItemResponse;
  try {
    note = await createMiroStickyNote({
      accessToken: params.accessToken,
      boardId: params.boardId,
      content: params.content,
      position: item.position,
      width: STICKY_W,
      color: params.color,
    });
    console.log(
      `Manual annotation note created for ${params.nodeId}: ${note.id} at (${Math.round(
        item.position.x
      )}, ${Math.round(item.position.y)}).`
    );
  } catch (error: unknown) {
    console.error(
      `Failed to create manual annotation note for ${params.nodeId}:`,
      getErrorMessage(error)
    );
    return;
  }

  try {
    await createConnector({
      accessToken: params.accessToken,
      boardId: params.boardId,
      startItemId: note.id,
      endItemId: params.imageItemId,
      endPosition: item.anchor,
    });
    console.log(`Manual annotation connector created for ${params.nodeId}: ${note.id}.`);
  } catch (error: unknown) {
    console.error(
      `Manual annotation note ${note.id} was created, but connector failed for ${params.nodeId}:`,
      getErrorMessage(error)
    );
  }
}

function groupNodesByBranch(nodes: IterationNode[]): Map<string, IterationNode[]> {
  const map = new Map<string, IterationNode[]>();
  for (const node of nodes) {
    const list = map.get(node.branchId) ?? [];
    list.push(node);
    map.set(node.branchId, list);
  }
  return map;
}

async function safeConnector(
  accessToken: string,
  boardId: string,
  startItemId: string,
  endItemId: string,
  style?: MiroConnectorStyle
): Promise<void> {
  try {
    await createConnector({ accessToken, boardId, startItemId, endItemId, style });
  } catch (error) {
    console.error("Failed to draw tree connector:", getErrorMessage(error));
  }
}

// Chronology connectors (consecutive screenshots within one branch) render red
// to set them apart from the default branch-fork connectors.
const CHRONOLOGY_CONNECTOR_STYLE: MiroConnectorStyle = { strokeColor: "#ff0000" };

// One screenshot node with everything precomputed for layout and drawing.
type PreparedNode = {
  node: IterationNode;
  aiAnnotation: string;
  aiAnnotationColor?: AnnotationColor;
  imageH: number;
  blocks: AnnotationBlock[];
  manualAnnotation: string;
  manualAnnotationColor?: AnnotationColor;
  manualPlacements: AnnotationPlacement[];
  placements: AnnotationPlacement[];
  footprint: ClusterFootprint;
  url: string;
};

type DrawTreeArgs = {
  accessToken: string;
  boardId: string;
  // Branch/node graph THIS tree is laid out from (the pruned tree passes
  // re-anchored copies). Connectors are drawn only between prepared nodes.
  branches: BranchRecord[];
  nodes: IterationNode[];
  prepared: PreparedNode[];
  commitsByHash: Map<string, CommitData>;
  annotationsByNode: Map<string, AnnotationRecord[]>;
  // Board-units this tree is shifted to the right, so two trees sit side by side.
  offsetX: number;
  // Namespaces image-item lookups so the SAME node id can be drawn in both trees
  // without their connectors crossing wires.
  keyPrefix: string;
  // Optional banner note placed above the tree.
  title?: string;
};

async function createScreenshotImage(params: {
  accessToken: string;
  boardId: string;
  url: string;
  screenshotPath: string;
  position: MiroPosition;
  width: number;
}): Promise<MiroItemResponse> {
  try {
    return await createMiroImage({
      accessToken: params.accessToken,
      boardId: params.boardId,
      url: params.url,
      position: params.position,
      width: params.width,
    });
  } catch (urlError: unknown) {
    const filePath = path.join(DESIGNTRAIL_ROOT, params.screenshotPath);
    console.warn(
      `Miro URL image upload failed for ${params.screenshotPath}; retrying local file upload:`,
      getErrorMessage(urlError)
    );
    return await createMiroImageFromFile({
      accessToken: params.accessToken,
      boardId: params.boardId,
      filePath,
      position: params.position,
      width: params.width,
    });
  }
}

/**
 * Lays out and draws ONE tree from the given prepared nodes: every screenshot
 * cluster (image + header note + annotation notes), the per-branch chronological
 * chain, and the branch-fork edges. Positions come from planTreeLayout, shifted
 * by `offsetX` so multiple trees can share one board without overlapping. Returns
 * the nodes it rendered plus the tree's right edge (in board units) so a caller
 * can place the next tree beyond it.
 */
async function drawTree(args: DrawTreeArgs): Promise<{
  rendered: RenderedBoardNode[];
  maxRight: number;
}> {
  const {
    accessToken,
    boardId,
    branches,
    nodes,
    prepared,
    commitsByHash,
    annotationsByNode,
    offsetX,
    keyPrefix,
    title,
  } = args;

  const rendered: RenderedBoardNode[] = [];
  if (prepared.length === 0) return { rendered, maxRight: offsetX };

  const boxes: NodeBox[] = prepared.map((p) => ({
    id: p.node.id,
    width: p.footprint.width,
    height: p.footprint.height,
    imageCenterOffset: p.footprint.imageCenterOffset,
  }));
  const plan = await planTreeLayout(branches, nodes, boxes);
  const layout = plan.positions;

  // Bounds in pre-offset coordinates, for frame/title placement and the right edge.
  let minX = Infinity;
  let minY = Infinity;
  let rightEdge = -Infinity;
  let bottomEdge = -Infinity;
  for (const p of prepared) {
    const box = layout.get(p.node.id);
    if (!box) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    rightEdge = Math.max(rightEdge, box.x + p.footprint.width);
    bottomEdge = Math.max(bottomEdge, box.y + p.footprint.height);
  }
  if (!Number.isFinite(rightEdge)) return { rendered, maxRight: offsetX };

  // Image item ids keyed by `keyPrefix + node.id` so two trees never collide.
  const imageIdByNode = new Map<string, string>();

  const titleY = minY - TREE_TITLE_OFFSET;
  const frameLeft = offsetX + minX - TREE_FRAME_PADDING;
  const frameRight = offsetX + rightEdge + TREE_FRAME_PADDING;
  const frameTop =
    Math.min(minY, title ? titleY - STICKY_H / 2 : minY) - TREE_FRAME_PADDING;
  const frameBottom = bottomEdge + TREE_FRAME_PADDING;

  await createMiroShape({
    accessToken,
    boardId,
    shape: "rectangle",
    position: {
      x: (frameLeft + frameRight) / 2,
      y: (frameTop + frameBottom) / 2,
    },
    width: frameRight - frameLeft,
    height: frameBottom - frameTop,
    fillColor: "#f2f2f2",
    borderColor: "#808080",
    borderWidth: "2",
  }).catch((error: unknown) =>
    console.error("Failed to place tree frame:", getErrorMessage(error))
  );

  if (title) {
    await createMiroStickyNote({
      accessToken,
      boardId,
      content: title,
      position: { x: offsetX + (minX + rightEdge) / 2, y: titleY },
      width: IMAGE_W,
    }).catch((error: unknown) =>
      console.error("Failed to place tree title note:", getErrorMessage(error))
    );
  }

  // Insert phase: draw every screenshot in parallel. Each node creates its image
  // first (annotation connectors need the image id), then fires its header and
  // annotation notes together. The shared limiter caps total concurrency.
  await Promise.all(
    prepared.map(async (p) => {
      const box = layout.get(p.node.id);
      if (!box) return;

      const imageCenter: MiroPosition = {
        x: offsetX + box.x + p.footprint.imageCenterOffset.x,
        y: box.y + p.footprint.imageCenterOffset.y,
      };

      let imageItemId: string;
      try {
        const imageItem = await createScreenshotImage({
          accessToken,
          boardId,
          url: p.url,
          screenshotPath: p.node.screenshotPath,
          position: imageCenter,
          width: IMAGE_W,
        });
        imageItemId = imageItem.id;
        imageIdByNode.set(keyPrefix + p.node.id, imageItem.id);
        rendered.push({ nodeId: p.node.id, miroImageId: imageItem.id });
      } catch (error: unknown) {
        console.error(
          `Failed to render Miro screenshot (${p.node.branchId || "main"}):`,
          getErrorMessage(error)
        );
        return;
      }

      const left = imageCenter.x - IMAGE_W / 2;
      const top = imageCenter.y - p.imageH / 2;

      // Header note carries the commit/component metadata, sitting diagonally
      // off the image's top-left corner so it stays clear of the note bands.
      const noteWork: Promise<unknown>[] = [
        createMiroStickyNote({
          accessToken,
          boardId,
          content: buildStickyContent({
            node: p.node,
            commit: commitsByHash.get(p.node.commitHash),
            annotations: annotationsByNode.get(p.node.id),
          }),
          position: {
            x: left - NOTE_MARGIN - STICKY_W / 2,
            y: top - NOTE_MARGIN - STICKY_H / 2,
          },
          width: STICKY_W,
        }).catch((error: unknown) =>
          console.error("Failed to place header note:", getErrorMessage(error))
        ),
      ];

      if (p.manualAnnotation) {
        noteWork.push(
          uploadManualAnnotationNote({
            accessToken,
            boardId,
            imageItemId,
            imageCenter,
            imageH: p.imageH,
            nodeId: p.node.id,
            content: p.manualAnnotation,
            color: p.manualAnnotationColor,
          })
        );
      }

      // Per-element annotation notes around the image; on a missing placement we
      // fall back to a single combined note beside the image.
      if (p.placements.length > 0 && p.blocks.length > 0) {
        noteWork.push(
          uploadAnnotationNotes({
            accessToken,
            boardId,
            imageItemId,
            imageCenter,
            imageH: p.imageH,
            blocks: p.blocks,
            placements: p.placements,
            color: p.aiAnnotationColor,
          })
        );
      } else if (p.aiAnnotation) {
        noteWork.push(
          createMiroStickyNote({
            accessToken,
            boardId,
            content: p.aiAnnotation,
            position: {
              x: imageCenter.x + IMAGE_W / 2 + NOTE_MARGIN + STICKY_W / 2,
              y: imageCenter.y,
            },
            width: STICKY_W,
            color: p.aiAnnotationColor,
          }).catch((error: unknown) =>
            console.error("Failed to place annotation note:", getErrorMessage(error))
          )
        );
      }

      await Promise.all(noteWork);
    })
  );

  // Tree connectors: a red chronological chain between consecutive screenshots
  // within each branch, then a (default-colored) fork edge from each branch's
  // fork point to that branch's first screenshot. Duplicate edges are dropped so
  // each image points to a given target at most once. Built after all images
  // exist, then drawn in parallel.
  const resolveImageId = (nodeId: string): string | undefined =>
    imageIdByNode.get(keyPrefix + nodeId);

  const drawnConnectors = new Set<string>();
  const connectorWork: Promise<void>[] = [];
  const queueConnector = (
    startNodeId: string,
    endNodeId: string,
    style?: MiroConnectorStyle
  ): void => {
    const startId = resolveImageId(startNodeId);
    const endId = resolveImageId(endNodeId);
    if (!startId || !endId || startId === endId) return;
    const key = `${startId}->${endId}`;
    if (drawnConnectors.has(key)) return;
    drawnConnectors.add(key);
    connectorWork.push(safeConnector(accessToken, boardId, startId, endId, style));
  };

  // Chronology runs between consecutive DRAWN nodes of each branch. Prepared
  // preserves export (chronological) order, so the pruned tree naturally links
  // surviving screenshots straight through the dropped ones.
  const nodesByBranch = groupNodesByBranch(prepared.map((p) => p.node));
  for (const branchNodes of nodesByBranch.values()) {
    for (let i = 1; i < branchNodes.length; i += 1) {
      queueConnector(branchNodes[i - 1].id, branchNodes[i].id, CHRONOLOGY_CONNECTOR_STYLE);
    }
  }

  // Fork edges come from this tree's layout (re-anchored fork points), so each
  // branch connects to where it actually hangs in this tree.
  for (const edge of plan.forkEdges) {
    queueConnector(edge.from, edge.to);
  }

  await Promise.all(connectorWork);

  return { rendered, maxRight: frameRight };
}

/**
 * Wipes the board and re-renders the ENTIRE design-evolution graph as THREE spatial
 * trees side by side: a significance-pruned tree first (where screenshots that are
 * only a minor change from their parent have been hidden), then the full-history
 * tree to its right, then a per-commit overview tree (the full-page `main` capture
 * for each commit, one screenshot per commit, as the overall view of what that
 * commit changed). Children re-anchor upward in the pruned tree and leaves are
 * preserved. Each node draws its screenshot, header note, and per-element
 * annotation notes; tree connectors show per-branch chronology and branch forks.
 * Positions come from planTreeLayout so each tree is non-overlapping. Called fresh
 * on every render so the board always reflects the full, current graph.
 */
export async function renderBoardFromGraph(
  branches: BranchRecord[],
  nodes: IterationNode[],
  commitsByHash: Map<string, CommitData>,
  annotationsOrOptions: AnnotationRecord[] | RenderBoardOptions = [],
  optionsArg: RenderBoardOptions = {}
): Promise<RenderedBoardNode[]> {
  const annotationRecords = Array.isArray(annotationsOrOptions)
    ? annotationsOrOptions
    : [];
  const options = Array.isArray(annotationsOrOptions) ? optionsArg : annotationsOrOptions;
  const annotationsByNode = groupAnnotationsByNode(annotationRecords);
  const accessToken = getStoredMiroAccessToken();
  const boardId = process.env.MIRO_BOARD_ID;

  if (!accessToken) {
    console.error("No stored Miro access token found. Complete OAuth first; skipping Miro render.");
    return [];
  }

  if (!boardId) {
    console.error("MIRO_BOARD_ID is missing. Skipping Miro render.");
    return [];
  }

  // Keep only nodes whose screenshot file actually exists on disk.
  const renderable = nodes.filter(
    (node) =>
      node.screenshotPath &&
      existsSync(path.join(DESIGNTRAIL_ROOT, node.screenshotPath))
  );

  // Precompute, per node: image height, annotation blocks, vision-placed
  // annotation positions, the cluster footprint, and the public image URL. Done
  // once and reused by BOTH trees (the pruned tree draws a subset of these).
  const prepared: PreparedNode[] = await mapWithConcurrency(
    renderable,
    PRECOMPUTE_CONCURRENCY,
    async (node) => {
      const absPng = path.join(DESIGNTRAIL_ROOT, node.screenshotPath);
      const dims = await readPngDimensions(absPng);
      const imageH = IMAGE_W * (dims ? dims.height / dims.width : DEFAULT_IMAGE_ASPECT);
      const commit = commitsByHash.get(node.commitHash);
      const nodeAnnotations = annotationsByNode.get(node.id);
      const manualAnnotation = getAnnotationContent(
        nodeAnnotations,
        "user",
        commit?.annotation
      );
      const manualAnnotationColor = manualAnnotation
        ? getAnnotationColor(nodeAnnotations, "user")
        : undefined;
      const aiAnnotation = getAnnotationContent(nodeAnnotations, "ai", node.annotation);
      const aiAnnotationColor = aiAnnotation
        ? getAnnotationColor(nodeAnnotations, "ai")
        : undefined;
      const manualPlacements: AnnotationPlacement[] = manualAnnotation
        ? [{ index: 1, x: 1, y: 0.5 }]
        : [];
      const blocks = aiAnnotation ? parseAnnotationBlocks(aiAnnotation) : [];
      const placements =
        blocks.length > 0 ? (await placeAnnotations(absPng, blocks)) ?? [] : [];
      const footprint = computeClusterFootprint(imageH, [
        ...manualPlacements,
        ...placements,
      ]);
      return {
        node,
        aiAnnotation,
        aiAnnotationColor,
        imageH,
        blocks,
        manualAnnotation,
        manualAnnotationColor,
        manualPlacements,
        placements,
        footprint,
        url: publicScreenshotUrl(node.screenshotPath, options.publicBaseUrl),
      };
    }
  );

  if (prepared.length === 0) {
    console.error("No renderable screenshots found for this repo; skipping Miro render.");
    return [];
  }

  // Wipe the whole board so the re-render starts from a clean slate.
  await clearBoard(accessToken, boardId);

  // Tree 1: the significance-pruned view. Compute the prune plan (one vision call
  // per hierarchy level band), apply it to IN-MEMORY graph copies (the DB is
  // never touched), and draw the surviving nodes first.
  const prunePlan = await planSignificancePrune(branches, nodes, DESIGNTRAIL_ROOT);
  const { branches: prunedBranches, nodes: prunedNodes } = applySignificancePrune(
    branches,
    nodes,
    prunePlan
  );
  const deletedIds = new Set(prunePlan.deletedNodeIds);
  const prunedPrepared = prepared.filter((p) => !deletedIds.has(p.node.id));

  const pruned = await drawTree({
    accessToken,
    boardId,
    branches: prunedBranches,
    nodes: prunedNodes,
    prepared: prunedPrepared,
    commitsByHash,
    annotationsByNode,
    offsetX: 0,
    keyPrefix: "pruned:",
    title: "Significant changes only",
  });

  // Tree 2: the full design-evolution history exactly as stored, placed to the
  // right of the compressed tree.
  const full = await drawTree({
    accessToken,
    boardId,
    branches,
    nodes,
    prepared,
    commitsByHash,
    annotationsByNode,
    offsetX: pruned.maxRight + TREE_GAP,
    keyPrefix: "",
    title: "Full history",
  });

  // Tree 3: the per-commit overview. Each commit's full-page `main` capture is
  // the overall view of what that commit changed, so feeding only the main
  // branch's nodes to the same layout yields a single chronological row (one
  // screenshot per commit), placed to the right of the full-history tree.
  const mainBranches = branches.filter((b) => b.id === MAIN_BRANCH);
  const mainNodes = nodes.filter((n) => n.branchId === MAIN_BRANCH);
  // The commit-overview tree shows the original, unboxed full page: swap each
  // main node's image to its clean `main-original.png` sidecar when present
  // (falling back to the boxed `main.png` used by the other two trees).
  const mainPrepared = prepared
    .filter((p) => p.node.branchId === MAIN_BRANCH)
    .map((p) => {
      const sidecarRel = originalMainSidecarPath(p.node.screenshotPath);
      const sidecarAbs = path.join(DESIGNTRAIL_ROOT, sidecarRel);
      if (!existsSync(sidecarAbs)) return p;
      return { ...p, url: publicScreenshotUrl(sidecarRel, options.publicBaseUrl) };
    });

  const commitOverview = await drawTree({
    accessToken,
    boardId,
    branches: mainBranches,
    nodes: mainNodes,
    prepared: mainPrepared,
    commitsByHash,
    annotationsByNode,
    offsetX: full.maxRight + TREE_GAP,
    keyPrefix: "commit:",
    title: "Commit overview (one per commit)",
  });

  const rendered = [...pruned.rendered, ...full.rendered, ...commitOverview.rendered];
  console.log(
    `Miro board re-rendered: significant-changes (${pruned.rendered.length}), ` +
      `full history (${full.rendered.length}), and ` +
      `commit overview (${commitOverview.rendered.length}) trees.`
  );

  return rendered;
}
