import { getLatestCommit, getDiff } from "./git.js";
import { takeScreenshot } from "./screenshot.js";
import type { CommitData } from "./types.js";

async function main(): Promise<void> {
  const { hash, message } = await getLatestCommit();
  const diff = await getDiff(hash);

  const commit: CommitData = {
    hash,
    message,
    diff,
    timestamp: Date.now(),
  };

  console.log("NEW COMMIT DETECTED");
  console.log(`hash: ${commit.hash}`);
  console.log(`message: "${commit.message}"`);
  console.log("");
  console.log("DIFF:");
  console.log(commit.diff);

  await takeScreenshot(commit.hash);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
