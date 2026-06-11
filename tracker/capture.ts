import path from "path";
import { createReadStream, createWriteStream } from "fs";
import readline from "readline/promises";
import {
  createDesignSnapshot,
  type DesignSnapshotEntry,
} from "../src/core/snapshotService.js";
import type {
  AnnotationChoice,
  AnnotationChoiceTarget,
  AnnotationMode,
} from "./types.js";

type LogEntry = DesignSnapshotEntry & {
  nodeId: string;
  branchId: string;
  parentBranchId: string | null;
  parentId: string | null;
  type: string;
  summary: string;
  annotationMode?: AnnotationMode;
  manualAnnotation?: string | null;
  aiAnnotation?: string | null;
  screenshotPath: string;
};

const MODE_LABELS: Record<AnnotationMode, string> = {
  skip: "Skip annotations",
  manual: "Manually add annotation",
  ai: "AI generated annotations",
  manual_and_ai: "Manual and AI generated annotations",
};

function logCommit(hash: string, repo: string, entries: LogEntry[]): void {
  console.log("========================");
  console.log(`COMMIT: ${hash}   REPO: ${repo}`);
  for (const e of entries) {
    console.log("");
    console.log(`COMPONENT: ${e.branchId}`);
    console.log(`  NODE:          ${e.nodeId}`);
    console.log(`  PARENT BRANCH: ${e.parentBranchId ?? "none"}`);
    console.log(`  PARENT NODE:   ${e.parentId ?? "none"}`);
    console.log(`  TYPE:          ${e.type}`);
    console.log(`  SUMMARY:       ${e.summary}`);
    if (e.annotationMode) {
      console.log(`  ANNOTATION MODE: ${MODE_LABELS[e.annotationMode]}`);
    }
    if (e.manualAnnotation) {
      console.log(
        `  MANUAL NOTE:   ${e.manualAnnotation.replace(/\n/g, "\n                 ")}`
      );
    }
    if (e.aiAnnotation) {
      console.log(`  AI NOTE:       ${e.aiAnnotation.replace(/\n/g, "\n                 ")}`);
    }
    console.log(`  SCREENSHOT:    ${e.screenshotPath}`);
  }
  console.log("========================");
}

async function flushOutput(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
}

function envOptionalString(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function envBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  console.warn(`Ignoring invalid ${name} value "${process.env[name]}"; using ${defaultValue}.`);
  return defaultValue;
}

function parseAnnotationMode(value: string | undefined): AnnotationMode | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return undefined;
  if (["1", "skip", "skip_annotations", "none"].includes(normalized)) return "skip";
  if (["2", "manual", "manually_add_annotation", "user"].includes(normalized)) {
    return "manual";
  }
  if (["3", "ai", "ai_generated_annotations"].includes(normalized)) return "ai";
  if (
    ["4", "manual_and_ai", "manual_ai", "manual_and_ai_generated_annotations"].includes(
      normalized
    )
  ) {
    return "manual_and_ai";
  }
  return undefined;
}

function defaultAnnotationMode(): AnnotationMode {
  const explicit = parseAnnotationMode(envOptionalString("DESIGNTRAIL_DEFAULT_ANNOTATION_MODE"));
  if (explicit) return explicit;
  return envBoolean("DESIGNTRAIL_AI_ANNOTATIONS", true) ? "ai" : "skip";
}

function parseAnnotationChoicesEnv(): AnnotationChoice[] | undefined {
  const raw = envOptionalString("DESIGNTRAIL_ANNOTATION_CHOICES");
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed
      .map((choice): AnnotationChoice | null => {
        if (!choice || typeof choice !== "object") return null;
        const record = choice as Record<string, unknown>;
        const mode = parseAnnotationMode(
          typeof record.mode === "string" ? record.mode : undefined
        );
        if (!mode) return null;
        return {
          nodeId: typeof record.nodeId === "string" ? record.nodeId : undefined,
          branchId: typeof record.branchId === "string" ? record.branchId : undefined,
          screenshotPath:
            typeof record.screenshotPath === "string" ? record.screenshotPath : undefined,
          mode,
          annotation:
            typeof record.annotation === "string" ? record.annotation : undefined,
        };
      })
      .filter((choice): choice is AnnotationChoice => choice !== null);
  } catch (error) {
    console.warn(
      "Ignoring invalid DESIGNTRAIL_ANNOTATION_CHOICES:",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

function defaultChoices(
  targets: AnnotationChoiceTarget[],
  mode: AnnotationMode
): AnnotationChoice[] {
  return targets.map((target) => ({ nodeId: target.nodeId, mode }));
}

async function promptForAnnotationChoices(
  targets: AnnotationChoiceTarget[],
  defaultMode: AnnotationMode
): Promise<AnnotationChoice[]> {
  if (targets.length === 0) return [];

  let input: NodeJS.ReadableStream = process.stdin;
  let output: NodeJS.WritableStream = process.stdout;
  let ttyInput: ReturnType<typeof createReadStream> | undefined;
  let ttyOutput: ReturnType<typeof createWriteStream> | undefined;

  try {
    ttyInput = createReadStream("/dev/tty");
    ttyOutput = createWriteStream("/dev/tty");
    input = ttyInput;
    output = ttyOutput;
  } catch {
    if (!process.stdin.isTTY) {
      console.warn(
        `No interactive terminal available; using ${MODE_LABELS[defaultMode]} for all screenshots.`
      );
      return defaultChoices(targets, defaultMode);
    }
  }

  const rl = readline.createInterface({ input, output });
  try {
    const choices: AnnotationChoice[] = [];
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      output.write(
        `\nDesignTrail annotation for screenshot ${i + 1}/${targets.length}\n` +
          `Component: ${target.branchId}\n` +
          `Summary: ${target.summary}\n` +
          `Screenshot: ${target.screenshotPath}\n` +
          `  1. ${MODE_LABELS.skip}\n` +
          `  2. ${MODE_LABELS.manual}\n` +
          `  3. ${MODE_LABELS.ai}\n` +
          `  4. ${MODE_LABELS.manual_and_ai}\n`
      );

      const modeAnswer = await rl.question(
        `Choose annotation mode [1-4] (default: ${MODE_LABELS[defaultMode]}): `
      );
      const mode = parseAnnotationMode(modeAnswer) ?? defaultMode;
      let annotation: string | undefined;
      if (mode === "manual" || mode === "manual_and_ai") {
        const answer = await rl.question(
          "Manual annotation for this screenshot (press Enter to skip manual note): "
        );
        annotation = envOptionalStringFromValue(answer);
      }

      choices.push({ nodeId: target.nodeId, mode, annotation });
    }
    return choices;
  } finally {
    rl.close();
    ttyInput?.destroy();
    ttyOutput?.destroy();
  }
}

function envOptionalStringFromValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? process.cwd());
  const skipPrompt = envBoolean("DESIGNTRAIL_SKIP_PROMPT", false);
  const annotationChoices = parseAnnotationChoicesEnv();
  const defaultMode = defaultAnnotationMode();
  const source = envOptionalString("DESIGNTRAIL_SOURCE") ?? "cli";
  const syncMiro = envBoolean("DESIGNTRAIL_SYNC_MIRO", true);
  const result = await createDesignSnapshot({
    repoPath,
    source,
    annotationChoices,
    defaultAnnotationMode: defaultMode,
    syncMiro,
    resolveAnnotationChoices:
      annotationChoices || skipPrompt
        ? undefined
        : (targets) => promptForAnnotationChoices(targets, defaultMode),
  });
  logCommit(result.commit.hash, result.repoName, result.entries);
  console.log(
    `DesignTrail post-commit hook complete for ${result.commit.hash.slice(0, 8)}.`
  );
}

main()
  .then(async () => {
    await flushOutput();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Capture failed:", err);
    console.error("The git commit was created, but DesignTrail did not finish cleanly.");
    await flushOutput();
    process.exit(1);
  });
