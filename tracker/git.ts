import path from "path";
import simpleGit from "simple-git";

function getGit(repoPath = process.cwd()) {
  return simpleGit(repoPath);
}

export async function getRepoName(repoPath?: string): Promise<string> {
  const git = getGit(repoPath);

  try {
    const root = (await git.revparse(["--show-toplevel"])).trim();
    return path.basename(root) || "unknown-repo";
  } catch {
    return "unknown-repo";
  }
}

export async function getLatestCommit(repoPath?: string): Promise<{ hash: string; message: string }> {
  const git = getGit(repoPath);
  const log = await git.log(["-1"]);
  const latest = log.latest;

  if (!latest) {
    throw new Error("No commits found in this repository.");
  }

  return { hash: latest.hash, message: latest.message };
}

export async function getDiff(commitHash: string, repoPath?: string): Promise<string> {
  const git = getGit(repoPath);

  try {
    return await git.diff([`${commitHash}~1`, commitHash]);
  } catch {
    // First commit has no parent, so fall back to showing the commit itself.
    return await git.show([commitHash]);
  }
}
