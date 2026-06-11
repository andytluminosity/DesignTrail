import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyDesignSnapshotAnnotations,
  createDesignSnapshot,
} from "../../src/core/snapshotService.js";
import type { AnnotationChoice, AnnotationMode } from "../../tracker/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESIGNTRAIL_ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(DESIGNTRAIL_ROOT, ".env") });

const { MIRO_CLIENT_ID, MIRO_CLIENT_SECRET, MIRO_REDIRECT_URI } = process.env;

const PORT = Number(process.env.PORT ?? 3002);
const TOKEN_FILE = path.join(DESIGNTRAIL_ROOT, ".miro-token.json");
let miroAccessToken: string | null = null;

const app = express();
app.use(express.json());
app.use(
  "/captures",
  express.static(path.join(DESIGNTRAIL_ROOT, "captures"), {
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);

type SnapshotRequestBody = {
  repoPath?: unknown;
  /** @deprecated Use per-node annotationChoices/defaultAnnotationMode. */
  annotation?: unknown;
  annotationChoices?: unknown;
  defaultAnnotationMode?: unknown;
  /** @deprecated Use defaultAnnotationMode. */
  generateAiAnnotations?: unknown;
  source?: unknown;
  syncMiro?: unknown;
};

type ApplyAnnotationsRequestBody = {
  repoPath?: unknown;
  commitHash?: unknown;
  annotationChoices?: unknown;
  syncMiro?: unknown;
};

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAnnotationMode(value: unknown): AnnotationMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["skip", "skip_annotations", "none"].includes(normalized)) return "skip";
  if (["manual", "manually_add_annotation", "user"].includes(normalized)) {
    return "manual";
  }
  if (["ai", "ai_generated_annotations"].includes(normalized)) return "ai";
  if (
    ["manual_and_ai", "manual_ai", "manual_and_ai_generated_annotations"].includes(
      normalized
    )
  ) {
    return "manual_and_ai";
  }
  return undefined;
}

function normalizeAnnotationChoices(value: unknown): AnnotationChoice[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("annotationChoices must be an array when provided");
  }

  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`annotationChoices[${index}] must be an object`);
    }

    const choice = raw as Record<string, unknown>;
    const mode = normalizeAnnotationMode(choice.mode);
    if (!mode) {
      throw new Error(`annotationChoices[${index}].mode is invalid`);
    }

    const nodeId = normalizeOptionalString(choice.nodeId, `annotationChoices[${index}].nodeId`);
    const branchId = normalizeOptionalString(
      choice.branchId,
      `annotationChoices[${index}].branchId`
    );
    const screenshotPath = normalizeOptionalString(
      choice.screenshotPath,
      `annotationChoices[${index}].screenshotPath`
    );
    if (!nodeId && !branchId && !screenshotPath) {
      throw new Error(
        `annotationChoices[${index}] must include nodeId, branchId, or screenshotPath`
      );
    }

    return {
      nodeId,
      branchId,
      screenshotPath,
      mode,
      annotation: normalizeOptionalString(
        choice.annotation,
        `annotationChoices[${index}].annotation`
      ),
    };
  });
}

app.get("/login", (_req, res) => {
  const authorizeUrl =
    "https://miro.com/oauth/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: MIRO_CLIENT_ID ?? "",
      redirect_uri: MIRO_REDIRECT_URI ?? "",
    }).toString();

  res.redirect(authorizeUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string | undefined;

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const response = await axios.post(
      "https://api.miro.com/v1/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: MIRO_CLIENT_ID ?? "",
        client_secret: MIRO_CLIENT_SECRET ?? "",
        code,
        redirect_uri: MIRO_REDIRECT_URI ?? "",
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const accessToken = response.data.access_token;
    miroAccessToken = accessToken;
    writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken }, null, 2));
    console.log("Miro token stored successfully");

    return res.send("OAuth complete. You can return to the app.");
  } catch (error: any) {
    console.error("Miro token exchange failed:", error.response?.data ?? error.message);
    return res.status(500).send("OAuth failed");
  }
});

app.post("/snapshot", async (req, res) => {
  const {
    repoPath,
    annotation,
    annotationChoices,
    defaultAnnotationMode,
    generateAiAnnotations,
    source,
    syncMiro,
  } =
    req.body as SnapshotRequestBody;

  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: "repoPath is required and must be a non-empty string",
    });
  }

  if (
    generateAiAnnotations !== undefined &&
    typeof generateAiAnnotations !== "boolean"
  ) {
    return res.status(400).json({
      success: false,
      error: "generateAiAnnotations must be a boolean when provided",
    });
  }

  if (syncMiro !== undefined && typeof syncMiro !== "boolean") {
    return res.status(400).json({
      success: false,
      error: "syncMiro must be a boolean when provided",
    });
  }

  let normalizedChoices: AnnotationChoice[] | undefined;
  let normalizedDefaultMode: AnnotationMode | undefined;
  let normalizedAnnotation: string | undefined;
  let normalizedSource: string | undefined;
  try {
    normalizedAnnotation = normalizeOptionalString(annotation, "annotation");
    normalizedChoices = normalizeAnnotationChoices(annotationChoices);
    if (defaultAnnotationMode !== undefined) {
      normalizedDefaultMode = normalizeAnnotationMode(defaultAnnotationMode);
      if (!normalizedDefaultMode) {
        throw new Error("defaultAnnotationMode is invalid");
      }
    }
    normalizedSource = normalizeOptionalString(source, "source");
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await createDesignSnapshot({
      repoPath,
      annotation: normalizedAnnotation,
      annotationChoices: normalizedChoices,
      defaultAnnotationMode: normalizedDefaultMode,
      generateAiAnnotations,
      source: normalizedSource ?? "claude",
      syncMiro,
    });

    return res.json({
      success: true,
      commit: {
        hash: result.commit.hash,
        message: result.commit.message,
        timestamp: result.commit.timestamp,
        source: result.commit.source,
      },
      repoName: result.repoName,
      repoPath: result.repoPath,
      entries: result.entries,
      screenshotCount: result.screenshots.length,
      miroSynced: result.miroNodes.length > 0,
    });
  } catch (error) {
    console.error("Snapshot creation failed:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Snapshot creation failed",
    });
  }
});

app.post("/snapshot/annotations", async (req, res) => {
  const { repoPath, commitHash, annotationChoices, syncMiro } =
    req.body as ApplyAnnotationsRequestBody;

  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: "repoPath is required and must be a non-empty string",
    });
  }

  if (syncMiro !== undefined && typeof syncMiro !== "boolean") {
    return res.status(400).json({
      success: false,
      error: "syncMiro must be a boolean when provided",
    });
  }

  let normalizedCommitHash: string | undefined;
  let normalizedChoices: AnnotationChoice[] | undefined;
  try {
    normalizedCommitHash = normalizeOptionalString(commitHash, "commitHash");
    normalizedChoices = normalizeAnnotationChoices(annotationChoices);
    if (!normalizedChoices || normalizedChoices.length === 0) {
      throw new Error("annotationChoices must include at least one choice");
    }
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await applyDesignSnapshotAnnotations({
      repoPath,
      commitHash: normalizedCommitHash,
      annotationChoices: normalizedChoices,
      syncMiro,
    });

    return res.json({
      success: true,
      commit: {
        hash: result.commit.hash,
        message: result.commit.message,
        timestamp: result.commit.timestamp,
        source: result.commit.source,
      },
      repoName: result.repoName,
      repoPath: result.repoPath,
      entries: result.entries,
      screenshotCount: result.screenshots.length,
      miroSynced: result.miroNodes.length > 0,
    });
  } catch (error) {
    console.error("Snapshot annotation update failed:", error);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Snapshot annotation update failed",
    });
  }
});

app.post("/test-node", async (req, res) => {
  const { boardId } = req.body as {
    boardId?: string;
  };

  if (!miroAccessToken) {
    return res.status(401).send("Not authenticated with Miro");
  }

  if (!boardId) {
    return res.status(400).send("Missing boardId");
  }

  try {
    const response = await axios.post(
      `https://api.miro.com/v2/boards/${boardId}/sticky_notes`,
      {
        data: { content: "Hello from DesignTrail 🚀" },
        position: { x: 0, y: 0 },
      },
      {
        headers: {
          Authorization: `Bearer ${miroAccessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json(response.data);
  } catch (error: any) {
    console.error("Miro create node failed:", error.response?.data ?? error.message);
    return res.status(500).send("Failed to create node");
  }
});

app.listen(PORT, () => {
  console.log(`DesignTrail service listening on http://localhost:${PORT}`);
  console.log(`Start the flow at http://localhost:${PORT}/login`);
  console.log(`Serving captures from http://localhost:${PORT}/captures`);
});
