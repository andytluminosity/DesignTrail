import path from "path";
import fse from "fs-extra";
import { chromium } from "playwright";

const CAPTURES_DIR = "captures";
const TARGET_URL = "http://localhost:3000";

export async function takeScreenshot(hash: string): Promise<void> {
  await fse.ensureDir(CAPTURES_DIR);
  const outputPath = path.join(CAPTURES_DIR, `${hash}.png`);

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`Screenshot saved: ${outputPath}`);
  } catch (err) {
    console.warn(
      `Could not capture ${TARGET_URL} (is your dev server running?). Skipping screenshot.`
    );
    console.warn(err instanceof Error ? err.message : err);
  } finally {
    await browser?.close();
  }
}
