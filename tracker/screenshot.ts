import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";
import type { Locator, Page } from "playwright";
import type { ScreenshotTarget, UiElement } from "./types.js";

const MAX_CONTEXT_ELEMENTS = 150;

/**
 * Loads the page and extracts a compact map of real, visible elements so the
 * LLM can choose selectors/text/roles that actually exist (instead of guessing
 * class names from the diff). Returns null if the page can't be reached.
 */
export async function getPageContext(url: string): Promise<UiElement[] | null> {
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1000);

    return await page.evaluate((limit) => {
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

        const key = `${tag}#${id ?? ""}.${classes.join(".")}[${role ?? ""}]`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({ tag, id, classes, role, testid, text: text || undefined });
        if (out.length >= limit) break;
      }
      return out;
    }, MAX_CONTEXT_ELEMENTS);
  } catch (err) {
    console.warn(
      `Could not read page context from ${url} (is your dev server running?).`,
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    await browser?.close();
  }
}

function resolveLocator(page: Page, target: ScreenshotTarget): Locator | null {
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

export async function takeScreenshot(
  outputPath: string,
  target: ScreenshotTarget,
  url: string
): Promise<void> {
  await fse.ensureDir(path.dirname(outputPath));

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(2000);

    const locator = resolveLocator(page, target);

    if (locator) {
      try {
        await locator.first().waitFor({ state: "visible", timeout: 5000 });
        await locator.first().screenshot({ path: outputPath });
        console.log(`Screenshot saved (${target.mode}): ${outputPath}`);
        return;
      } catch {
        console.warn(
          `Target not found for mode "${target.mode}" value "${target.value ?? ""}". Falling back to full page.`
        );
      }
    }

    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`Screenshot saved (full): ${outputPath}`);
  } catch (err) {
    console.warn(
      `Could not capture ${url} (is your dev server running?). Skipping screenshot.`
    );
    console.warn(err instanceof Error ? err.message : err);
  } finally {
    await browser?.close();
  }
}
