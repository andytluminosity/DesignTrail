import path from "path";
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
    console.log(`  SCREENSHOT:    ${e.screenshotPath}`);
  }
  console.log("========================");
}

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? process.cwd());
  const result = await createDesignSnapshot({ repoPath, source: "cli" });
  logCommit(result.commit.hash, result.repoName, result.entries);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
