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
import { MAIN_BRANCH } from "./branch.js";
import { computeContainerIdentity, keyToBranchId } from "./domKey.js";

const MAX_CONTEXT_ELEMENTS = 150;
const MAX_ROUTES = 10;

/**
 * Extracts a compact map of real, visible elements on the currently loaded page
 * so the LLM can choose selectors/text/roles that actually exist (instead of
 * guessing class names from the diff).
 */
async function extractElements(page: Page, limit: number): Promise<UiElement[]> {
  // Keep this browser callback free of named inner functions. tsx/esbuild can
  // inject a `__name` helper for inner functions, but Playwright's evaluate
  // world does not define it.
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

      // Nearest ancestor that has a stable id/class we can target.
      let parent: string | undefined;
      let parentEl = htmlEl.parentElement;
      while (parentEl && parentEl !== document.body) {
        const parentHtml = parentEl as HTMLElement;
        if (parentHtml.id) {
          parent = `#${parentHtml.id}`;
          break;
        }
        const parentClasses =
          typeof parentHtml.className === "string" && parentHtml.className.trim()
            ? parentHtml.className.trim().split(/\s+/)
            : [];
        if (parentClasses.length) {
          parent = `.${parentClasses[0]}`;
          break;
        }
        parentEl = parentEl.parentElement;
      }

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
  const hrefs = await page.evaluate(() => {
    const out: string[] = [];
    const anchors = document.querySelectorAll("a[href]");
    for (const a of Array.from(anchors)) {
      out.push((a as HTMLAnchorElement).href);
    }
    return out;
  });

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

const CHANGE_HIGHLIGHT_ID = "__designtrail_change_box__";

/**
 * Injects a dotted red box over the originally changed (LLM-located) element so
 * it's visible in the wider ancestor screenshots captured during the DOM climb.
 * The box is an absolutely-positioned overlay appended to `document.body` and
 * placed in document coordinates (rect + scroll), so it stays correctly aligned
 * even as Playwright scrolls elements into view for each capture, and it never
 * gets clipped by an ancestor's `overflow: hidden`.
 */
async function addChangeHighlight(page: Page, located: ElementHandle): Promise<void> {
  await located.evaluate((node, boxId) => {
    const existing = document.getElementById(boxId);
    if (existing) existing.remove();
    const rect = (node as Element).getBoundingClientRect();
    const box = document.createElement("div");
    box.id = boxId;
    box.style.position = "absolute";
    box.style.left = `${rect.left + window.scrollX}px`;
    box.style.top = `${rect.top + window.scrollY}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.border = "3px dashed red";
    box.style.boxSizing = "border-box";
    box.style.pointerEvents = "none";
    box.style.zIndex = "2147483647";
    document.body.appendChild(box);
  }, CHANGE_HIGHLIGHT_ID);
}

/** Removes the change-highlight overlay if present (no-op otherwise). */
async function removeChangeHighlight(page: Page): Promise<void> {
  await page.evaluate((boxId) => {
    document.getElementById(boxId)?.remove();
  }, CHANGE_HIGHLIGHT_ID);
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
): Promise<{ container: ElementHandle; located: ElementHandle } | null> {
  const locateLoc = resolveLocator(page, target);
  if (!locateLoc) return null;

  const located = locateLoc.first();
  await located.waitFor({ state: "visible", timeout: 5000 });

  const elementHandle = await located.elementHandle();
  if (!elementHandle) return null;

  try {
    const parentElement = await parentElementHandle(page, elementHandle);
    if (parentElement) return { container: parentElement, located: elementHandle };
  } catch {
    // Any climb failure falls back to the located element below.
  }

  return { container: elementHandle, located: elementHandle };
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
  // Opaque id echoed back on the result so the caller can join a capture to the
  // source change (its summary/type/target), regardless of the DOM-derived branch.
  jobId: string;
  outputPath: string;
  target: ScreenshotTarget;
  navPath?: string;
};

/**
 * Climbs the live DOM ancestor chain above the already-captured container
 * (`fromHandle`), capturing each ancestor up to body/html. Each ancestor's
 * branch id is derived from its stable, instance-unique DOM identity (a
 * shortest anchored DOM path), so siblings sharing a class never collide.
 * Anonymous wrappers (no id/class/role/name) are skipped for capture but still
 * climbed through, so the chain always reaches the page root. Once body/html is
 * reached, a single full-page capture is taken and tagged for the `main` branch.
 *
 * Ancestor PNGs are written alongside the job's own output (same commit dir),
 * named by derived branch id. `seenBranches` dedupes within the climb so a
 * branch is captured at most once.
 *
 * A dotted red box is drawn around the originally changed element (`located`)
 * for every ancestor capture, so it's clear at higher hierarchy levels what
 * changed. The full-page `main` capture is saved twice: a boxed `main.png` (used
 * by the full + compressed trees) and a clean `main-original.png` sidecar (used
 * by the per-commit overview tree, which keeps the unboxed photo).
 */
async function climbAncestors(
  page: Page,
  fromHandle: ElementHandle,
  outputDir: string,
  navPath: string,
  located: ElementHandle
): Promise<AncestorCapture[]> {
  const ancestors: AncestorCapture[] = [];
  const seenBranches = new Set<string>();
  let current: ElementHandle | null = fromHandle;

  try {
    // Highlight the changed element so it stands out in the wider ancestor shots.
    await addChangeHighlight(page, located);

    // Bound the climb defensively in case of an unexpected DOM cycle.
    for (let depth = 0; depth < 64; depth++) {
      const parent: ElementHandle | null = await parentElementHandle(page, current);
      if (!parent) {
        // Reached body/html: the topmost level is the whole page => main branch.
        // Capture the boxed full page first (full + compressed trees), then drop
        // the box and capture a clean sidecar for the per-commit overview tree.
        const mainPath = path.join(outputDir, `${MAIN_BRANCH}.png`);
        await page.screenshot({ path: mainPath, fullPage: true });
        await removeChangeHighlight(page);
        const mainOriginalPath = path.join(outputDir, `${MAIN_BRANCH}-original.png`);
        await page.screenshot({ path: mainOriginalPath, fullPage: true });
        ancestors.push({
          branchId: MAIN_BRANCH,
          outputPath: mainPath,
          geometry: await fullPageGeometry(page),
          navPath,
        });
        break;
      }

      const identity = await computeContainerIdentity(parent, navPath);
      // Only meaningful, identifiable containers become their own branch; pure
      // anonymous wrappers are climbed THROUGH (so the chain reaches the root)
      // but never noded, otherwise the structural fallback would turn every
      // wrapper div into a container.
      const branchId = identity.meaningful ? keyToBranchId(identity) : null;
      if (branchId && !seenBranches.has(branchId)) {
        seenBranches.add(branchId);
        const ancestorPath = path.join(outputDir, `${branchId}.png`);
        try {
          await parent.screenshot({ path: ancestorPath });
          const geometry = await readGeometry(parent, page);
          ancestors.push({
            branchId,
            outputPath: ancestorPath,
            geometry,
            navPath,
            label: identity.label,
            selector: identity.selector,
          });
          console.log(`Ancestor screenshot saved (${branchId}): ${ancestorPath}`);
        } catch {
          // Skip ancestors that can't be screenshot (e.g. zero-size); keep climbing.
        }
      }

      current = parent;
    }
  } finally {
    // Always clear the overlay so it can't leak into later jobs on this page.
    await removeChangeHighlight(page);
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
  const { jobId, outputPath, target, navPath = "/" } = job;
  const outputDir = path.dirname(outputPath);
  await fse.ensureDir(outputDir);

  await page.goto(new URL(navPath, url).toString(), { waitUntil: "load" });
  await page.waitForTimeout(2000);

  if (target.mode !== "full") {
    try {
      const located = await captureLocator(page, target);
      if (located) {
        const { container, located: changedElement } = located;
        // The captured container's stable DOM identity defines this component's
        // branch — instance-unique, so two sibling cards never collapse together.
        const identity = await computeContainerIdentity(container, navPath);
        const selfBranchId = keyToBranchId(identity);
        await container.screenshot({ path: outputPath });
        // Measure the SAME element we screenshot (the climbed container when one
        // was chosen), so geometry == the captured container's rect.
        const geometry = await readGeometry(container, page);
        console.log(`Screenshot saved (${target.mode}): ${outputPath}`);
        const ancestors = await climbAncestors(
          page,
          container,
          outputDir,
          navPath,
          changedElement
        );
        const chain = [selfBranchId, ...ancestors.map((a) => a.branchId)];
        return {
          self: {
            jobId,
            outputPath,
            geometry,
            branchId: selfBranchId,
            label: identity.label,
            selector: identity.selector,
            navPath,
          },
          ancestors,
          chain,
        };
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
  // spatial tree with a page-sized rect (which would mis-nest the branch). A
  // full/fallback capture has no isolable container, so it belongs to `main`.
  const geometry = target.mode === "full" ? await fullPageGeometry(page) : undefined;
  console.log(`Screenshot saved (full): ${outputPath}`);
  return {
    self: { jobId, outputPath, geometry, branchId: MAIN_BRANCH, label: MAIN_BRANCH, navPath },
    ancestors: [],
    chain: [MAIN_BRANCH],
  };
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
  // A climbed ancestor that resolves to a branch a job already captured as its
  // OWN container must not be re-captured (it would double-node that branch).
  // The job branch id is now the container's DOM identity, only known after
  // capture, so we accumulate self branch ids as jobs complete.
  const seenAncestorBranches = new Set<string>();
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
        if (self.branchId) seenAncestorBranches.add(self.branchId);
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
  const { results } = await takeScreenshots(
    [{ jobId: "single", outputPath, target, navPath }],
    url
  );
  return results[0];
}
