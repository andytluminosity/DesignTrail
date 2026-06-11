import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";
import type { ElementHandle, Locator, Page } from "playwright";
import type {
  AncestorCapture,
  NodeGeometry,
  PageContext,
  ScreenshotResult,
  ScreenshotTarget,
  UiElement,
} from "./types.js";
import { deriveDomBranchId, MAIN_BRANCH } from "./branch.js";

const MAX_CONTEXT_ELEMENTS = 150;
const MAX_ROUTES = 10;

/**
 * Extracts a compact map of real, visible elements on the currently loaded page
 * so the LLM can choose selectors/text/roles that actually exist (instead of
 * guessing class names from the diff).
 */
async function extractElements(page: Page, limit: number): Promise<UiElement[]> {
  return await page.evaluate((max) => {
    const out: Array<{
      tag: string;
      id?: string;
      classes: string[];
      role?: string;
      testid?: string;
      text?: string;
      parent?: string;
    }> = [];
    const seen = new Set<string>();

    // Best-effort selector for an element from its id or first class.
    const selectorFor = (el: Element): string | undefined => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.id) return `#${htmlEl.id}`;
      const cls =
        typeof htmlEl.className === "string" && htmlEl.className.trim()
          ? htmlEl.className.trim().split(/\s+/)
          : [];
      if (cls.length) return `.${cls[0]}`;
      return undefined;
    };

    // Nearest ancestor that has a stable id/class we can target.
    const nearestIdentifiableAncestor = (el: Element): string | undefined => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const sel = selectorFor(parent);
        if (sel) return sel;
        parent = parent.parentElement;
      }
      return undefined;
    };

    const all = Array.from(document.body.querySelectorAll("*"));
    for (const el of all) {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const tag = htmlEl.tagName.toLowerCase();
      const classes =
        typeof htmlEl.className === "string" && htmlEl.className.trim()
          ? htmlEl.className.trim().split(/\s+/)
          : [];
      const id = htmlEl.id || undefined;
      const role = htmlEl.getAttribute("role") || undefined;
      const testid =
        htmlEl.getAttribute("data-testid") ||
        htmlEl.getAttribute("data-test-id") ||
        undefined;

      let text = (htmlEl.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 60) text = text.slice(0, 60);

      // Skip elements with no useful identifier at all.
      if (!id && classes.length === 0 && !role && !testid && !text) continue;

      const parent = nearestIdentifiableAncestor(htmlEl);

      // Include text in the key so structurally identical but distinct
      // components (e.g. repeated cards) are not collapsed into one entry.
      const key = `${tag}#${id ?? ""}.${classes.join(".")}[${role ?? ""}]{${text}}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ tag, id, classes, role, testid, text: text || undefined, parent });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

/**
 * Discovers same-origin routes reachable from the landing page's anchors so the
 * LLM can be told which page each element lives on (and pick where to navigate).
 */
async function discoverRoutes(page: Page, url: string): Promise<string[]> {
  const origin = new URL(url).origin;
  const landing = new URL(url).pathname || "/";
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map(
      (a) => (a as HTMLAnchorElement).href
    )
  );

  const routes = new Set<string>([landing]);
  for (const href of hrefs) {
    try {
      const u = new URL(href, url);
      if (u.origin !== origin) continue;
      routes.add(u.pathname || "/");
    } catch {
      // Ignore unparseable hrefs.
    }
  }
  return Array.from(routes).slice(0, MAX_ROUTES);
}

/**
 * Loads the site and builds a per-route map of real, visible elements. Returns
 * an empty array if the page can't be reached.
 */
export async function getSiteContext(url: string): Promise<PageContext[]> {
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    const routes = await discoverRoutes(page, url);

    const contexts: PageContext[] = [];
    for (const route of routes) {
      try {
        await page.goto(new URL(route, url).toString(), { waitUntil: "load" });
        await page.waitForTimeout(1000);
        const elements = await extractElements(page, MAX_CONTEXT_ELEMENTS);
        contexts.push({ path: route, elements });
      } catch {
        // Skip routes that fail to load; keep whatever we gathered.
      }
    }
    return contexts;
  } catch (err) {
    console.warn(
      `Could not read site context from ${url} (is your dev server running?).`,
      err instanceof Error ? err.message : err
    );
    return [];
  } finally {
    await browser?.close();
  }
}

function resolveLocator(
  page: Page,
  target: { mode: ScreenshotTarget["mode"]; value?: string }
): Locator | null {
  const value = target.value ?? "";
  switch (target.mode) {
    case "selector":
      return page.locator(value);
    case "text":
      return page.getByText(value);
    case "role":
      return page.getByRole(value as Parameters<Page["getByRole"]>[0]);
    case "full":
    default:
      return null;
  }
}

/**
 * Returns `el`'s immediate parent element handle, or null when the parent is the
 * page root (body/html) or there is none. A page-sized rect would corrupt
 * spatial nesting, so the root is treated as "no usable parent".
 */
async function parentElementHandle(
  page: Page,
  el: ElementHandle
): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle((node) => {
    const parent = (node as Element).parentElement;
    if (!parent) return null;
    const tag = parent.tagName.toLowerCase();
    if (tag === "body" || tag === "html") return null;
    return parent;
  }, el);
  return handle.asElement() as ElementHandle | null;
}

/** Reads a climbed container's DOM identity (id + first class) for branch derivation. */
async function readIdentity(
  el: ElementHandle
): Promise<{ id?: string; firstClass?: string }> {
  return await el.evaluate((node) => {
    const e = node as HTMLElement;
    const id = e.id || undefined;
    const firstClass =
      typeof e.className === "string" && e.className.trim()
        ? e.className.trim().split(/\s+/)[0]
        : undefined;
    return { id, firstClass };
  });
}

/**
 * Resolves the element to screenshot. The LLM locates the changed element via
 * `mode`/`value`, then we climb exactly one DOM level to its immediate parent —
 * that parent container defines the branch and drives both the screenshot and
 * the measured geometry. Priority order:
 *  1. the located element's immediate parent (when it exists and isn't the
 *     page root);
 *  2. the located changed element (no usable parent).
 * Returns null when the target can't be located at all.
 */
async function captureLocator(
  page: Page,
  target: ScreenshotTarget
): Promise<ElementHandle | null> {
  const locateLoc = resolveLocator(page, target);
  if (!locateLoc) return null;

  const located = locateLoc.first();
  await located.waitFor({ state: "visible", timeout: 5000 });

  const elementHandle = await located.elementHandle();
  if (!elementHandle) return null;

  try {
    const parentElement = await parentElementHandle(page, elementHandle);
    if (parentElement) return parentElement;
  } catch {
    // Any climb failure falls back to the located element below.
  }

  return elementHandle;
}

/** Full scrollable document dimensions of the currently loaded page. */
async function pageDimensions(page: Page): Promise<{ pageW: number; pageH: number }> {
  return await page.evaluate(() => ({
    pageW: document.documentElement.scrollWidth,
    pageH: document.documentElement.scrollHeight,
  }));
}

/** Geometry of a located element in document (page) pixels, or undefined if unmeasurable. */
async function readGeometry(
  loc: Locator | ElementHandle,
  page: Page
): Promise<NodeGeometry | undefined> {
  try {
    const box = await loc.boundingBox();
    if (!box) return undefined;
    const { pageW, pageH } = await pageDimensions(page);
    const scroll = await page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY }));
    return {
      x: box.x + scroll.sx,
      y: box.y + scroll.sy,
      w: box.width,
      h: box.height,
      pageW,
      pageH,
    };
  } catch {
    return undefined;
  }
}

/** Full-page rect spanning the whole document, used for `full` captures (e.g. main). */
async function fullPageGeometry(page: Page): Promise<NodeGeometry> {
  const { pageW, pageH } = await pageDimensions(page);
  return { x: 0, y: 0, w: pageW, h: pageH, pageW, pageH };
}

export type ScreenshotJob = {
  outputPath: string;
  target: ScreenshotTarget;
  navPath?: string;
};

/**
 * Climbs the live DOM ancestor chain above the already-captured container
 * (`fromHandle`), capturing each ancestor up to body/html. Each ancestor's
 * branch id is derived from its DOM identity (id, else first class); anonymous
 * wrappers (no stable id) are skipped for capture but still climbed through, so
 * the chain always reaches the page root. Once body/html is reached, a single
 * full-page capture is taken and tagged for the `main` branch.
 *
 * Ancestor PNGs are written alongside the job's own output (same commit dir),
 * named by derived branch id. `seenBranches` dedupes within the climb so a
 * branch is captured at most once.
 */
async function climbAncestors(
  page: Page,
  fromHandle: ElementHandle,
  outputDir: string,
  navPath: string
): Promise<AncestorCapture[]> {
  const ancestors: AncestorCapture[] = [];
  const seenBranches = new Set<string>();
  let current: ElementHandle | null = fromHandle;

  // Bound the climb defensively in case of an unexpected DOM cycle.
  for (let depth = 0; depth < 64; depth++) {
    const parent: ElementHandle | null = await parentElementHandle(page, current);
    if (!parent) {
      // Reached body/html: the topmost level is the whole page => main branch.
      const mainPath = path.join(outputDir, `${MAIN_BRANCH}.png`);
      await page.screenshot({ path: mainPath, fullPage: true });
      ancestors.push({
        branchId: MAIN_BRANCH,
        outputPath: mainPath,
        geometry: await fullPageGeometry(page),
        navPath,
      });
      break;
    }

    const branchId = deriveDomBranchId(await readIdentity(parent));
    if (branchId && !seenBranches.has(branchId)) {
      seenBranches.add(branchId);
      const ancestorPath = path.join(outputDir, `${branchId}.png`);
      try {
        await parent.screenshot({ path: ancestorPath });
        const geometry = await readGeometry(parent, page);
        ancestors.push({ branchId, outputPath: ancestorPath, geometry, navPath });
        console.log(`Ancestor screenshot saved (${branchId}): ${ancestorPath}`);
      } catch {
        // Skip ancestors that can't be screenshot (e.g. zero-size); keep climbing.
      }
    }

    current = parent;
  }

  return ancestors;
}

/**
 * Captures a single job on an already-open page: navigates to its route,
 * screenshots the located element's immediate parent container (the job's own
 * branch), then climbs the DOM ancestor chain capturing each container up to
 * `main`. Falls back to a full page capture (with no ancestors) on any failure.
 * Throws only if navigation itself fails (so the caller can decide).
 *
 * `chain` is the true DOM containment succession for this job, innermost-first:
 * the job's own branch followed by each climbed ancestor branch up to `main`.
 * It is the authoritative ancestor order (a thing physically nested inside
 * another in the live DOM), used to build the component tree instead of relying
 * on bounding-box geometry, which cannot express overflow/equal-rect nesting.
 */
async function captureOnePage(
  page: Page,
  job: ScreenshotJob,
  url: string
): Promise<{ self: ScreenshotResult; ancestors: AncestorCapture[]; chain: string[] }> {
  const { outputPath, target, navPath = "/" } = job;
  const outputDir = path.dirname(outputPath);
  const selfBranchId = path.basename(outputPath, ".png");
  await fse.ensureDir(outputDir);

  await page.goto(new URL(navPath, url).toString(), { waitUntil: "load" });
  await page.waitForTimeout(2000);

  if (target.mode !== "full") {
    try {
      const element = await captureLocator(page, target);
      if (element) {
        await element.screenshot({ path: outputPath });
        // Measure the SAME element we screenshot (the climbed container when one
        // was chosen), so geometry == the captured container's rect.
        const geometry = await readGeometry(element, page);
        console.log(`Screenshot saved (${target.mode}): ${outputPath}`);
        const ancestors = await climbAncestors(page, element, outputDir, navPath);
        const chain = [selfBranchId, ...ancestors.map((a) => a.branchId)];
        return { self: { outputPath, geometry }, ancestors, chain };
      }
    } catch {
      console.warn(
        `Target not found for mode "${target.mode}" value "${target.value ?? ""}". Falling back to full page.`
      );
    }
  }

  await page.screenshot({ path: outputPath, fullPage: true });
  // Only treat a full-page capture as real geometry when the target WAS full
  // (e.g. main). A targeted capture that fell back to full page never actually
  // measured its component, so record no geometry rather than polluting the
  // spatial tree with a page-sized rect (which would mis-nest the branch).
  const geometry = target.mode === "full" ? await fullPageGeometry(page) : undefined;
  console.log(`Screenshot saved (full): ${outputPath}`);
  return { self: { outputPath, geometry }, ancestors: [], chain: [selfBranchId] };
}

// True DOM containment succession discovered while climbing: each branch mapped
// to the branch it is directly nested inside (its next captured ancestor up the
// chain). `main` (the page root) has no entry. This is the authoritative source
// for the component tree's parent_branch_id.
export type DomAncestry = Map<string, string>;

/**
 * Folds a single job's containment chain (innermost-first, ending at `main`)
 * into the run-wide ancestry map. Each branch's parent is the next branch up the
 * chain; first writer wins so a deeper job's fuller chain isn't clobbered by a
 * shallower one (the DOM is a tree, so the parent is the same either way).
 */
function recordChain(ancestry: DomAncestry, chain: string[]): void {
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (child && parent && child !== parent && !ancestry.has(child)) {
      ancestry.set(child, parent);
    }
  }
}

/**
 * Captures many targeted screenshots reusing a SINGLE browser/page (one launch
 * for N component captures). A failure on one job does not abort the rest.
 * Returns one `result` per successfully captured job, the deduped set of
 * `ancestors` discovered by climbing the DOM container chain of each job (a
 * given ancestor branch is captured once per run, first climb wins), and the
 * `ancestry` map of true DOM containment edges (child branch -> the branch it is
 * nested inside) built from every job's full climb.
 */
export async function takeScreenshots(
  jobs: ScreenshotJob[],
  url: string
): Promise<{
  results: ScreenshotResult[];
  ancestors: AncestorCapture[];
  ancestry: DomAncestry;
}> {
  if (jobs.length === 0) return { results: [], ancestors: [], ancestry: new Map() };

  const results: ScreenshotResult[] = [];
  const ancestors: AncestorCapture[] = [];
  const ancestry: DomAncestry = new Map();
  // Seed with each job's OWN branch (its output filename is `<branchId>.png`) so
  // a climbed ancestor that derives the same id never overwrites a level-0
  // capture's PNG or double-nodes a branch the job already owns.
  const seenAncestorBranches = new Set<string>(
    jobs.map((job) => path.basename(job.outputPath, ".png"))
  );
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    for (const job of jobs) {
      try {
        const { self, ancestors: jobAncestors, chain } = await captureOnePage(
          page,
          job,
          url
        );
        results.push(self);
        // Build ancestry from the FULL per-job chain (before cross-job ancestor
        // dedup) so containment edges are never dropped for branches that also
        // appear as their own jobs.
        recordChain(ancestry, chain);
        for (const ancestor of jobAncestors) {
          if (seenAncestorBranches.has(ancestor.branchId)) continue;
          seenAncestorBranches.add(ancestor.branchId);
          ancestors.push(ancestor);
        }
      } catch (err) {
        console.warn(
          `Could not capture ${job.navPath ?? "/"} for ${job.outputPath}. Skipping this one.`
        );
        console.warn(err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn(
      `Could not capture ${url} (is your dev server running?). Skipping screenshots.`
    );
    console.warn(err instanceof Error ? err.message : err);
  } finally {
    await browser?.close();
  }
  return { results, ancestors, ancestry };
}

export async function takeScreenshot(
  outputPath: string,
  target: ScreenshotTarget,
  url: string,
  navPath: string = "/"
): Promise<ScreenshotResult | undefined> {
  const { results } = await takeScreenshots([{ outputPath, target, navPath }], url);
  return results[0];
}
