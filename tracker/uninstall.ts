import path from "path";
import fse from "fs-extra";
import simpleGit from "simple-git";

const MARKER_START = "# >>> DesignTrail tracker >>>";
const MARKER_END = "# <<< DesignTrail tracker <<<";

// The invocation every DesignTrail hook contains, regardless of whether it was
// installed with the marker fences or as a stand-alone hook.
const TRACKER_INVOCATION = "tracker/capture.ts";

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

function isDesignTrailLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("DESIGNTRAIL=") ||
    t.includes(TRACKER_INVOCATION) ||
    (t.startsWith("#") && t.includes("DesignTrail"))
  );
}

// True when, ignoring shebang and comments, no real command lines remain — i.e.
// the hook existed only for DesignTrail and can be deleted outright.
function hasNoOtherCommands(lines: string[]): boolean {
  return !lines.some((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return false; // blank, comment, or shebang
    return !isDesignTrailLine(line);
  });
}

async function writeHook(hookPath: string, contents: string): Promise<void> {
  const normalized = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fse.writeFile(hookPath, normalized, { mode: 0o755 });
  await fse.chmod(hookPath, 0o755);
}

async function uninstallFrom(repoPath: string): Promise<void> {
  const absRepo = path.resolve(repoPath);
  const repoName = path.basename((await simpleGit(absRepo).revparse(["--show-toplevel"])).trim());
  const hooksDir = await resolveHooksDir(absRepo);
  const hookPath = path.join(hooksDir, "post-commit");

  if (!(await fse.pathExists(hookPath))) {
    console.log(`No post-commit hook found in ${repoName}; nothing to untrack.`);
    return;
  }

  const existing = await fse.readFile(hookPath, "utf8");
  const hasMarkers = existing.includes(MARKER_START);
  const hasInvocation = existing.includes(TRACKER_INVOCATION);

  if (!hasMarkers && !hasInvocation) {
    console.log(`${repoName} is not tracked by DesignTrail; left its post-commit hook untouched.`);
    return;
  }

  let cleaned: string;
  if (hasMarkers) {
    // Strip our fenced block (plus any blank lines hugging it).
    cleaned = existing.replace(
      new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`),
      "\n"
    );
  } else {
    // Marker-less DesignTrail hook: drop the DesignTrail-specific lines.
    cleaned = existing
      .split("\n")
      .filter((line) => !isDesignTrailLine(line))
      .join("\n");
  }

  if (hasNoOtherCommands(cleaned.split("\n"))) {
    // The hook only existed for DesignTrail; remove it entirely.
    await fse.remove(hookPath);
    console.log(`Removed DesignTrail hook from ${repoName} (${hookPath})`);
  } else {
    // Preserve the user's pre-existing hook content.
    await writeHook(hookPath, cleaned.replace(/\n{3,}/g, "\n\n").trimStart());
    console.log(`Removed DesignTrail block from ${repoName}'s post-commit hook (${hookPath})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repos = args.length > 0 ? args : [process.cwd()];

  for (const repo of repos) {
    try {
      await uninstallFrom(repo);
    } catch (err) {
      console.error(
        `Failed to untrack ${repo}:`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
    }
  }

  console.log("\nDone. The untracked repo(s) will no longer trigger the tracker on commit.");
}

main().catch((err) => {
  console.error("Untrack failed:", err);
  process.exit(1);
});
