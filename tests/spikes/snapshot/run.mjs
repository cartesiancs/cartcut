// The snapshot spike's driver: serves the repository root, opens spike.html in
// each engine and prints what `runSpike()` measured, as JSON. Run from the
// repository root:
//
//   node tests/spikes/snapshot/run.mjs                  # chromium, firefox, webkit
//   node tests/spikes/snapshot/run.mjs --engines=webkit --only=taint,clipText
//   node tests/spikes/snapshot/run.mjs --exe=/path/to/chrome --label=chrome-120
//
// `--exe` launches any Chromium build through Playwright's chromium driver,
// which is how the old Chrome builds are measured.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit == null ? null : hit.slice(name.length + 3);
};
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const EXE = arg("exe");
const LABEL = arg("label");
const ENGINES = EXE != null ? ["exe"] : (arg("engines") ?? "chromium,firefox,webkit").split(",");
const FLAGS = (arg("flags") ?? "").split(" ").filter(Boolean);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = path.join(REPO, decodeURIComponent(url.pathname));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const results = {};
for (const engine of ENGINES) {
  const type = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
  const options = { headless: true, args: FLAGS };
  if (engine === "exe") {
    options.executablePath = EXE;
  }
  let browser;
  try {
    browser = await type.launch(options);
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error(`[${engine}] pageerror`, error.message));
    await page.goto(`http://localhost:${port}/tests/spikes/snapshot/spike.html`);
    results[LABEL ?? engine] = await page.evaluate((only) => window.runSpike(only), ONLY);
  } catch (error) {
    results[LABEL ?? engine] = `launch or run failed: ${error.message}`;
  } finally {
    await browser?.close();
  }
}
server.close();
console.log(JSON.stringify(results, null, 1));
