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

type MiroPosition = {
  x: number;
  y: number;
};

type CreateMiroItemBase = {
  accessToken: string;
  boardId: string;
  position?: MiroPosition;
};

type CreateMiroImageInput = CreateMiroItemBase & {
  url: string;
};

type CreateMiroStickyNoteInput = CreateMiroItemBase & {
  content: string;
};

type MiroItemResponse = {
  id: string;
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

export async function createMiroImage({
  accessToken,
  boardId,
  url,
  position = { x: 0, y: 0 },
}: CreateMiroImageInput): Promise<MiroItemResponse> {
  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/images`,
    accessToken,
    {
      data: { url },
      position,
    }
  );
}

export async function createMiroStickyNote({
  accessToken,
  boardId,
  content,
  position = { x: 0, y: 0 },
}: CreateMiroStickyNoteInput): Promise<MiroItemResponse> {
  return postMiroItem(
    `https://api.miro.com/v2/boards/${boardId}/sticky_notes`,
    accessToken,
    {
      data: { content },
      position,
    }
  );
}

export async function createCommitNode(commit: CommitData): Promise<MiroTimelineNode | null> {
  const accessToken = getStoredMiroAccessToken();
  const boardId = process.env.MIRO_BOARD_ID;

  if (!accessToken) {
    console.error("No stored Miro access token found. Complete OAuth first; skipping Miro upload.");
    return null;
  }

  if (!boardId) {
    console.error("MIRO_BOARD_ID is missing. Skipping Miro upload.");
    return null;
  }

  const shortHash = commit.hash.slice(0, 7);
  const repoCapturePath = commit.repoName ? `${commit.repoName}/` : "";
  const screenshotUrl = `http://localhost:3000/captures/${repoCapturePath}${commit.hash}.png`;
  const metadataContent = `${shortHash}\n${commit.message}`;
  const timelineState = loadTimelineState();
  const commitIndex = timelineState.commitIndex;
  const position = getTimelinePosition(commitIndex);
  const previousNode = timelineState.nodes.at(-1) ?? null;

  try {
    /*
    const image = await createMiroImage({
      accessToken,
      boardId,
      url: screenshotUrl,
      position,
    });
    */
    const metadata = await createMiroStickyNote({
      accessToken,
      boardId,
      content: metadataContent,
      position,
    });

    console.log(`Miro commit metadata created: ${metadata.id}`);

    const timelineNode: MiroTimelineNode = {
      commitHash: commit.hash,
      miroNodeId: metadata.id,
      nodeType: "sticky_note",
      commitIndex,
      position,
      previousNodeId: previousNode?.miroNodeId ?? null,
      createdAt: new Date().toISOString(),
    };

    timelineState.nodes.push(timelineNode);

    if (previousNode) {
      timelineState.edges.push({
        previousNodeId: previousNode.miroNodeId,
        currentNodeId: metadata.id,
        previousCommitHash: previousNode.commitHash,
        currentCommitHash: commit.hash,
      });
    }

    timelineState.commitIndex = commitIndex + 1;
    saveTimelineState(timelineState);

    console.log(`Miro timeline node stored at y=${position.y}`);

    return timelineNode;
  } catch (error: unknown) {
    console.error("Failed to create Miro commit node:", getErrorMessage(error));
    return null;
  }
}
