import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import fse from "fs-extra";
import simpleGit from "simple-git";

// Resolve DesignTrail root so worktrees live beside the rest of the install.
const DESIGNTRAIL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const WORKTREES_ROOT = path.join(DESIGNTRAIL_ROOT, ".preview-worktrees");

const PREVIEW_PORT = Number(process.env.DESIGNTRAIL_PREVIEW_PORT ?? 4180);
// Port for the headless "before" server booted during capture. Kept distinct
// from PREVIEW_PORT and the watched app's CAPTURE_URL so they never collide.
const BEFORE_PORT = Number(process.env.DESIGNTRAIL_BEFORE_PORT ?? 4190);
// Generous ceiling: a cold worktree may need install + build before it serves.
const READY_TIMEOUT_MS = Number(
  process.env.DESIGNTRAIL_PREVIEW_READY_TIMEOUT_MS ?? 180_000
);

type ActivePreview = {
  commitHash: string;
  repoPath: string;
  worktreeDir: string;
  port: number;
  child: ChildProcess;
};

// At most one preview runs at a time; a new request tears down the previous one.
let activePreview: ActivePreview | null = null;
// Serializes start/stop so concurrent requests can't race on the shared worktree
// and port.
let opQueue: Promise<unknown> = Promise.resolve();

export type StartPreviewParams = {
  repoPath: string;
  repoName: string;
  commitHash: string;
  navPath: string;
};

export type StartPreviewResult = {
  url: string;
  port: number;
  commitHash: string;
  // True when the requested commit was already being served (no rebuild).
  reused: boolean;
};

function buildPreviewUrl(port: number, navPath: string): string {
  const suffix = navPath.startsWith("/") ? navPath : `/${navPath}`;
  return `http://localhost:${port}${suffix}`;
}

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

/**
 * Checks out `commitHash` in an isolated worktree, serves it on the preview port,
 * and opens the browser at `navPath`. Replaces any previously running preview.
 * Calls are serialized so the shared worktree/port stay consistent.
 */
export async function startPreview(
  params: StartPreviewParams
): Promise<StartPreviewResult> {
  const run = opQueue.then(() => startPreviewInner(params));
  // Keep the queue alive even if this run rejects, so later calls still proceed.
  opQueue = run.catch(() => undefined);
  return run;
}

async function startPreviewInner(
  params: StartPreviewParams
): Promise<StartPreviewResult> {
  const { repoPath, repoName, commitHash, navPath } = params;
  const port = PREVIEW_PORT;
  const url = buildPreviewUrl(port, navPath);

  // Same commit already serving: just re-open the browser at the new route.
  if (
    activePreview &&
    activePreview.commitHash === commitHash &&
    isChildAlive(activePreview.child)
  ) {
    await openInBrowser(url);
    return { url, port, commitHash, reused: true };
  }

  await stopActivePreview();

  const shortHash = commitHash.slice(0, 12);
  const worktreeDir = path.join(WORKTREES_ROOT, repoName, shortHash);
  await ensureWorktree(repoPath, worktreeDir, commitHash);

  const child = await launchPreviewServer(worktreeDir, port);
  activePreview = { commitHash, repoPath, worktreeDir, port, child };

  // If the server process dies on its own, drop the reference so a later request
  // does a clean restart rather than reusing a dead preview.
  child.once("exit", () => {
    if (activePreview?.child === child) activePreview = null;
  });

  await waitForServer(port, READY_TIMEOUT_MS);
  await openInBrowser(url);
  return { url, port, commitHash, reused: false };
}

/**
 * Stops the running preview (if any): kills the server process group and removes
 * its worktree so the next preview starts clean.
 */
export async function stopActivePreview(): Promise<void> {
  const preview = activePreview;
  activePreview = null;
  if (!preview) return;

  await killProcessTree(preview.child);
  await removeWorktree(preview.repoPath, preview.worktreeDir);
}

export type HeadlessServer = {
  url: string;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Checks out `commitHash` in an isolated worktree and serves it headlessly (no
 * browser opened) so a caller can screenshot that exact code, e.g. the "before"
 * state of a component's first change. Independent of the singleton preview
 * lifecycle: the caller owns the returned `stop()`, which kills the server and
 * removes the worktree. Prefers `npm run dev` to avoid a slow production build.
 */
export async function serveCommitHeadless(params: {
  repoPath: string;
  repoName: string;
  commitHash: string;
  port?: number;
}): Promise<HeadlessServer> {
  const { repoPath, repoName, commitHash } = params;
  const port = params.port ?? BEFORE_PORT;
  const shortHash = commitHash.slice(0, 12);
  const worktreeDir = path.join(WORKTREES_ROOT, repoName, `before-${shortHash}`);

  await ensureWorktree(repoPath, worktreeDir, commitHash);
  const child = await launchPreviewServer(worktreeDir, port, { preferDev: true });

  const stop = async (): Promise<void> => {
    await killProcessTree(child);
    await removeWorktree(repoPath, worktreeDir);
  };

  try {
    await waitForServer(port, READY_TIMEOUT_MS);
  } catch (err) {
    await stop();
    throw err;
  }

  return { url: `http://localhost:${port}`, port, stop };
}

async function ensureWorktree(
  repoPath: string,
  worktreeDir: string,
  commitHash: string
): Promise<void> {
  // Reuse an existing checkout for this commit when present.
  if (await fse.pathExists(path.join(worktreeDir, ".git"))) return;

  const git = simpleGit(repoPath);
  // Clear any stale worktree registrations before (re)creating this one.
  await git.raw(["worktree", "prune"]);
  if (await fse.pathExists(worktreeDir)) {
    await fse.remove(worktreeDir);
  }
  await fse.ensureDir(path.dirname(worktreeDir));
  await git.raw(["worktree", "add", "--detach", worktreeDir, commitHash]);
}

async function removeWorktree(
  repoPath: string,
  worktreeDir: string
): Promise<void> {
  try {
    const git = simpleGit(repoPath);
    await git.raw(["worktree", "remove", "--force", worktreeDir]);
  } catch {
    // Fall back to a plain delete + prune if git refuses (e.g. dirty worktree).
    await fse.remove(worktreeDir).catch(() => undefined);
    try {
      await simpleGit(repoPath).raw(["worktree", "prune"]);
    } catch {
      // Best effort; nothing else to do.
    }
  }
}

type PackageJson = { scripts?: Record<string, string> };

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return (await fse.readJson(path.join(dir, "package.json"))) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Installs deps (when missing) and starts the checked-out app's server on `port`.
 * By default prefers a production `build` + `preview` and falls back to `dev`.
 * When `preferDev` is set the order is reversed (use `dev` when present), which
 * avoids paying for a full production build for short-lived capture servers.
 */
async function launchPreviewServer(
  worktreeDir: string,
  port: number,
  options: { preferDev?: boolean } = {}
): Promise<ChildProcess> {
  const pkg = await readPackageJson(worktreeDir);
  const scripts = pkg?.scripts ?? {};

  if (!(await fse.pathExists(path.join(worktreeDir, "node_modules")))) {
    await runToCompletion("npm", ["install"], worktreeDir);
  }

  let serveArgs: string[];
  if (options.preferDev && scripts.dev) {
    serveArgs = ["run", "dev", "--", "--port", String(port), "--strictPort"];
  } else if (scripts.build && scripts.preview) {
    await runToCompletion("npm", ["run", "build"], worktreeDir);
    serveArgs = ["run", "preview", "--", "--port", String(port), "--strictPort"];
  } else if (scripts.dev) {
    serveArgs = ["run", "dev", "--", "--port", String(port), "--strictPort"];
  } else {
    throw new Error(
      "Checked-out app has no 'preview' or 'dev' npm script to serve a preview"
    );
  }

  const child = spawn("npm", serveArgs, {
    cwd: worktreeDir,
    stdio: "inherit",
    // Own process group so we can kill the whole tree (npm -> vite -> esbuild).
    detached: true,
    env: { ...process.env, PORT: String(port), BROWSER: "none" },
  });

  return child;
}

function runToCompletion(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!isChildAlive(child) || child.pid === undefined) {
      resolve();
      return;
    }

    const pid = child.pid;
    const settled = { done: false };
    const finish = (): void => {
      if (settled.done) return;
      settled.done = true;
      resolve();
    };

    child.once("exit", finish);
    try {
      // Negative pid targets the whole process group (detached spawn above).
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
    }

    // Escalate to SIGKILL if it doesn't exit promptly.
    setTimeout(() => {
      if (settled.done) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      finish();
    }, 4000);
  });
}

function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const req = http.get(
        { host: "localhost", port, path: "/", timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };

    const retry = (): void => {
      if (Date.now() >= deadline) {
        reject(new Error(`Preview server did not become ready on port ${port}`));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const opener =
      process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : process.platform === "win32"
          ? { cmd: "cmd", args: ["/c", "start", "", url] }
          : { cmd: "xdg-open", args: [url] };

    try {
      const child = spawn(opener.cmd, opener.args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => resolve());
      child.unref();
    } catch {
      // Opening the browser is best-effort; the caller still gets the URL.
    }
    resolve();
  });
}

// Best-effort teardown so a killed service doesn't leave a worktree behind.
let cleanupRegistered = false;
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    const preview = activePreview;
    if (!preview) return;
    try {
      if (preview.child.pid !== undefined) {
        process.kill(-preview.child.pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.once("exit", cleanup);
}
registerCleanup();
