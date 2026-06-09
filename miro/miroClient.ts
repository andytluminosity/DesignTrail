import axios from "axios";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import path from "path";
import type { CommitData } from "../tracker/types.js";

dotenv.config();

const TOKEN_FILE = path.resolve(process.cwd(), ".miro-token.json");

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

export async function createMiroImage({
  accessToken,
  boardId,
  url,
  position = { x: 0, y: 0 },
}: CreateMiroImageInput): Promise<any> {
  const response = await axios.post(
    `https://api.miro.com/v2/boards/${boardId}/images`,
    {
      data: { url },
      position,
    },
    {
      headers: getMiroHeaders(accessToken),
    }
  );

  return response.data;
}

export async function createMiroStickyNote({
  accessToken,
  boardId,
  content,
  position = { x: 0, y: 0 },
}: CreateMiroStickyNoteInput): Promise<any> {
  const response = await axios.post(
    `https://api.miro.com/v2/boards/${boardId}/sticky_notes`,
    {
      data: { content },
      position,
    },
    {
      headers: getMiroHeaders(accessToken),
    }
  );

  return response.data;
}

export async function createCommitNode(commit: CommitData): Promise<any> {
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
  const screenshotUrl = `http://localhost:3000/captures/${commit.hash}.png`;
  const metadataContent = `${shortHash}\n${commit.message}`;

  try {
    const image = await createMiroImage({
      accessToken,
      boardId,
      url: screenshotUrl,
      position: { x: 0, y: 0 },
    });

    const metadata = await createMiroStickyNote({
      accessToken,
      boardId,
      content: metadataContent,
      position: { x: 0, y: 320 },
    });

    console.log(`Miro commit image created: ${image.id}`);
    console.log(`Miro commit metadata created: ${metadata.id}`);

    return {
      imageId: image.id,
      metadataId: metadata.id,
    };
  } catch (error: any) {
    console.error("Failed to create Miro commit node:", error.response?.data ?? error.message);
    return null;
  }
}
