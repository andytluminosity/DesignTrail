import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";
import type { Locator, Page } from "playwright";
import type { ScreenshotTarget } from "./types.js";

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
