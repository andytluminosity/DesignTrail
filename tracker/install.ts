import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import simpleGit from "simple-git";

// DesignTrail install root (parent of this tracker/ dir). The generated hook
// points back here so any watched repo runs THIS tracker.
const TRACKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MARKER_START = "# >>> DesignTrail tracker >>>";
const MARKER_END = "# <<< DesignTrail tracker <<<";

function hookBlock(): string {
  return [
    MARKER_START,
    "# Auto-installed by DesignTrail. Runs the AI iteration tracker on each commit.",
    `DESIGNTRAIL="${TRACKER_ROOT}"`,
    `"$DESIGNTRAIL/node_modules/.bin/tsx" "$DESIGNTRAIL/tracker/capture.ts"`,
    MARKER_END,
  ].join("\n");
}

async function resolveHooksDir(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  // Honor core.hooksPath / worktrees by asking git where hooks live.
  const hooksPathRaw = (await git.raw(["rev-parse", "--git-path", "hooks"])).trim();
  return path.resolve(repoPath, hooksPathRaw);
}

async function installInto(repoPath: string): Promise<void> {
  const absRepo = path.resolve(repoPath);
  const repoName = path.basename((await simpleGit(absRepo).revparse(["--show-toplevel"])).trim());
  const hooksDir = await resolveHooksDir(absRepo);
  await fse.ensureDir(hooksDir);

  const hookPath = path.join(hooksDir, "post-commit");
  const block = hookBlock();

  let contents: string;
  if (await fse.pathExists(hookPath)) {
    const existing = await fse.readFile(hookPath, "utf8");
    if (existing.includes(MARKER_START)) {
      // Already installed; refresh the block in case the path changed.
      const refreshed = existing.replace(
        new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`),
        block
      );
      contents = refreshed;
      console.log(`Updated existing DesignTrail hook in ${repoName} (${hookPath})`);
    } else {
      // Preserve the user's existing hook and append our block.
      const sep = existing.endsWith("\n") ? "\n" : "\n\n";
      contents = `${existing}${sep}${block}\n`;
      console.log(`Appended DesignTrail hook to existing post-commit in ${repoName} (${hookPath})`);
    }
  } else {
    contents = `#!/bin/sh\n${block}\n`;
    console.log(`Installed DesignTrail hook in ${repoName} (${hookPath})`);
  }

  await fse.writeFile(hookPath, contents, { mode: 0o755 });
  await fse.chmod(hookPath, 0o755);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repos = args.length > 0 ? args : [process.cwd()];

  for (const repo of repos) {
    try {
      await installInto(repo);
    } catch (err) {
      console.error(
        `Failed to install tracker into ${repo}:`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
    }
  }

  console.log("\nDone. New commits in the watched repo(s) will trigger the tracker.");
}

main().catch((err) => {
  console.error("Install failed:", err);
  process.exit(1);
});
