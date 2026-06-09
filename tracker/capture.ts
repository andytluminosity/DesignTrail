import path from "path";
import { fileURLToPath } from "url";
import { getLatestCommit, getDiff, getRepoName } from "./git.js";
import { takeScreenshot } from "./screenshot.js";
import { analyzeCommit } from "./llm.js";
import type { CommitData } from "./types.js";

// Resolve the tracker's own root (DesignTrail) so the pipeline works no matter
// which repo's git hook triggered it (e.g. DesignTrail itself or TempRepo).
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load env (OPENAI_API_KEY, optional CAPTURE_URL) from the tracker root, since
// the current working directory will be the committing repo, not DesignTrail.
try {
  process.loadEnvFile(path.join(TRACKER_ROOT, ".env"));
} catch {
  // No .env present; rely on the ambient environment.
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";

async function main(): Promise<void> {
  const { hash, message } = await getLatestCommit();
  const diff = await getDiff(hash);
  const repoName = await getRepoName();

  const commit: CommitData = {
    hash,
    message,
    diff,
    timestamp: Date.now(),
  };

  // Step: analyze the commit with the LLM BEFORE capturing anything.
  const analysis = await analyzeCommit({
    diff: commit.diff,
    commitMessage: commit.message,
  });

  const { mode, value } = analysis.screenshotTarget;

  console.log(`COMMIT: ${commit.hash}`);
  console.log(`REPO: ${repoName}`);
  console.log("");
  console.log("LLM SUMMARY:");
  console.log(analysis.summary);
  console.log("");
  console.log("SCREENSHOT MODE:");
  console.log(mode);
  console.log("");
  console.log("SCREENSHOT TARGET:");
  console.log(mode === "full" ? "(full page)" : value ?? "(full page)");
  console.log("");

  // Captures are centralized in DesignTrail and namespaced by repo.
  const outputPath = path.join(TRACKER_ROOT, "captures", repoName, `${commit.hash}.png`);
  await takeScreenshot(outputPath, analysis.screenshotTarget, CAPTURE_URL);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
