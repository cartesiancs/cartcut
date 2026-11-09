// A screenshot of the browser editor's top bar, after the first-run cards.
//   node tests/spikes/webmenu/shot.mjs <out.png> [engine]
import { chromium, firefox, webkit } from "playwright";
import { serve } from "./serve.mjs";

const out = process.argv[2];
const engine = { chromium, firefox, webkit }[process.argv[3] ?? "chromium"];
const site = await serve();
const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ONBOARDING_COMPLETED", "true");
  localStorage.setItem("TUTORIAL_COMPLETED", "true");
});
await page.goto(site.url + "/");
await page.waitForFunction(() => window.CARTCUT?.useTimelineStore != null, null, { timeout: 60000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1440, height: 120 } });
await browser.close();
site.close();
