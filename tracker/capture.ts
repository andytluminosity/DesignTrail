import path from "path";
import { createReadStream, createWriteStream } from "fs";
import readline from "readline/promises";
import {
  createDesignSnapshot,
  type DesignSnapshotEntry,
} from "../src/core/snapshotService.js";

type LogEntry = DesignSnapshotEntry & {
  branchId: string;
  parentBranchId: string | null;
  parentId: string | null;
  type: string;
  summary: string;
  screenshotPath: string;
};

function logCommit(hash: string, repo: string, entries: LogEntry[]): void {
  console.log("========================");
  console.log(`COMMIT: ${hash}   REPO: ${repo}`);
  for (const e of entries) {
    console.log("");
    console.log(`COMPONENT: ${e.branchId}`);
    console.log(`  PARENT BRANCH: ${e.parentBranchId ?? "none"}`);
    console.log(`  PARENT NODE:   ${e.parentId ?? "none"}`);
    console.log(`  TYPE:          ${e.type}`);
    console.log(`  SUMMARY:       ${e.summary}`);
    if (e.annotation) {
      console.log(`  ANNOTATION:    ${e.annotation.replace(/\n/g, "\n                 ")}`);
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

async function promptForAnnotation(): Promise<string | undefined> {
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
      console.warn("No interactive terminal available; continuing without annotation.");
      return undefined;
    }
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      "DesignTrail annotation for this commit (press Enter to skip): "
    );
    const trimmed = answer.trim();
    return trimmed ? trimmed : undefined;
  } finally {
    rl.close();
    ttyInput?.destroy();
    ttyOutput?.destroy();
  }
}

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? process.cwd());
  const annotation = await promptForAnnotation();
  const source = process.env.DESIGNTRAIL_SOURCE?.trim() || "cli";
  const result = await createDesignSnapshot({ repoPath, source, annotation });
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
