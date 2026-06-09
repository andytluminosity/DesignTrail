import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";
import type { ElementHandle, Locator, Page } from "playwright";
import type { PageContext, ScreenshotTarget, UiElement } from "./types.js";

const MAX_CONTEXT_ELEMENTS = 150;
const MAX_ROUTES = 10;

// Used only as a fallback: when a text/role match lands on a leaf node, climb to
// the nearest meaningful container so we capture the whole component. Uses
// word-match ([class~=...]) so BEM sub-element classes (e.g. "card__title") do
// not match the leaf itself and defeat the climb.
const CONTAINER_SELECTOR =
  '[data-testid], section, article, li, ' +
  '[class~="card"], [class~="panel"], [class~="tile"], [class~="item"], [class~="widget"], [class~="box"]';

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

      // Include text in the key so structurally identical but distinct
      // components (e.g. repeated cards) are not collapsed into one entry.
      const key = `${tag}#${id ?? ""}.${classes.join(".")}[${role ?? ""}]{${text}}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ tag, id, classes, role, testid, text: text || undefined });
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
 * Resolves the element to screenshot, in priority order:
 *  1. the LLM's explicit capture target (trusted region), if present and found;
 *  2. the located element — for text/role, climbing to the nearest container;
 *  3. null (caller falls back to full page).
 */
async function captureLocator(
  page: Page,
  target: ScreenshotTarget
): Promise<Locator | ElementHandle | null> {
  if (target.capture) {
    const captureLoc = resolveLocator(page, target.capture);
    if (captureLoc && (await captureLoc.count()) > 0) {
      try {
        await captureLoc.first().waitFor({ state: "visible", timeout: 5000 });
        return captureLoc.first();
      } catch {
        // Explicit capture target not visible; fall through to located element.
      }
    }
  }

  const locateLoc = resolveLocator(page, target);
  if (!locateLoc) return null;

  await locateLoc.first().waitFor({ state: "visible", timeout: 5000 });

  if (target.mode === "text" || target.mode === "role") {
    const handle = await locateLoc.first().elementHandle();
    if (handle) {
      const container = await handle.evaluateHandle(
        (el, sel) => (el as Element).closest(sel) ?? el,
        CONTAINER_SELECTOR
      );
      return container.asElement() ?? handle;
    }
  }

  return locateLoc.first();
}

export type ScreenshotJob = {
  outputPath: string;
  target: ScreenshotTarget;
  navPath?: string;
};

/**
 * Captures a single job on an already-open page: navigates to its route, then
 * screenshots the located/capture element, falling back to full page on any
 * failure. Throws only if navigation itself fails (so the caller can decide).
 */
async function captureOnePage(
  page: Page,
  job: ScreenshotJob,
  url: string
): Promise<void> {
  const { outputPath, target, navPath = "/" } = job;
  await fse.ensureDir(path.dirname(outputPath));

  await page.goto(new URL(navPath, url).toString(), { waitUntil: "load" });
  await page.waitForTimeout(2000);

  if (target.mode !== "full" || target.capture) {
    try {
      const locator = await captureLocator(page, target);
      if (locator) {
        await locator.screenshot({ path: outputPath });
        console.log(`Screenshot saved (${target.mode}): ${outputPath}`);
        return;
      }
    } catch {
      console.warn(
        `Target not found for mode "${target.mode}" value "${target.value ?? ""}". Falling back to full page.`
      );
    }
  }

  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`Screenshot saved (full): ${outputPath}`);
}

/**
 * Captures many targeted screenshots reusing a SINGLE browser/page (one launch
 * for N component captures). A failure on one job does not abort the rest.
 */
export async function takeScreenshots(jobs: ScreenshotJob[], url: string): Promise<void> {
  if (jobs.length === 0) return;

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    for (const job of jobs) {
      try {
        await captureOnePage(page, job, url);
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
}

export async function takeScreenshot(
  outputPath: string,
  target: ScreenshotTarget,
  url: string,
  navPath: string = "/"
): Promise<void> {
  await takeScreenshots([{ outputPath, target, navPath }], url);
}
