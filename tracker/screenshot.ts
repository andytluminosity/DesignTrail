import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";
import type { ElementHandle, Locator, Page } from "playwright";
import type {
  NodeGeometry,
  PageContext,
  ScreenshotResult,
  ScreenshotTarget,
  UiElement,
} from "./types.js";

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
 * Resolves the element to screenshot. The LLM locates the changed element via
 * `mode`/`value`, then we climb exactly one DOM level to its immediate parent —
 * that parent container defines the branch and drives both the screenshot and
 * the measured geometry. Priority order:
 *  1. the located element's immediate parent (when it exists and isn't the
 *     page root);
 *  2. the located changed element (no usable parent);
 *  3. null (caller falls back to full page).
 */
async function captureLocator(
  page: Page,
  target: ScreenshotTarget
): Promise<Locator | ElementHandle | null> {
  const locateLoc = resolveLocator(page, target);
  if (!locateLoc) return null;

  const located = locateLoc.first();
  await located.waitFor({ state: "visible", timeout: 5000 });

  try {
    const elementHandle = await located.elementHandle();
    if (elementHandle) {
      // Climb exactly one level to the immediate parent, but never to the page
      // root (body/html) — a page-sized rect would corrupt spatial nesting, so
      // fall back to the located element in that case.
      const parentHandle = await page.evaluateHandle((el) => {
        const parent = (el as Element).parentElement;
        if (!parent) return null;
        const tag = parent.tagName.toLowerCase();
        if (tag === "body" || tag === "html") return null;
        return parent;
      }, elementHandle);
      const parentElement = parentHandle.asElement();
      if (parentElement) return parentElement;
    }
  } catch {
    // Any climb failure falls back to the located element below.
  }

  return located;
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
 * Captures a single job on an already-open page: navigates to its route, then
 * screenshots the located element, falling back to full page on any
 * failure. Returns the file written plus the located element's geometry. Throws
 * only if navigation itself fails (so the caller can decide).
 */
async function captureOnePage(
  page: Page,
  job: ScreenshotJob,
  url: string
): Promise<ScreenshotResult> {
  const { outputPath, target, navPath = "/" } = job;
  await fse.ensureDir(path.dirname(outputPath));

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
        return { outputPath, geometry };
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
  return { outputPath, geometry };
}

/**
 * Captures many targeted screenshots reusing a SINGLE browser/page (one launch
 * for N component captures). A failure on one job does not abort the rest.
 * Returns one result per successfully captured job (with geometry when known).
 */
export async function takeScreenshots(
  jobs: ScreenshotJob[],
  url: string
): Promise<ScreenshotResult[]> {
  if (jobs.length === 0) return [];

  const results: ScreenshotResult[] = [];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    for (const job of jobs) {
      try {
        results.push(await captureOnePage(page, job, url));
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
  return results;
}

export async function takeScreenshot(
  outputPath: string,
  target: ScreenshotTarget,
  url: string,
  navPath: string = "/"
): Promise<ScreenshotResult | undefined> {
  const [result] = await takeScreenshots([{ outputPath, target, navPath }], url);
  return result;
}
