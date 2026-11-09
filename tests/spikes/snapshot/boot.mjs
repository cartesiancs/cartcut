// Does the web editor boot in this browser? Serves the renderer the way
// scripts/buildWeb.mjs lays out dist-web/ (without writing anything) and
// reports whether <app-root> rendered and which errors the page threw.
//
//   node tests/spikes/snapshot/boot.mjs --exe=/path/to/chrome --label=chrome-113
//   node tests/spikes/snapshot/boot.mjs --engines=chromium,firefox,webkit
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
const EXE = arg("exe");
const LABEL = arg("label");
const ENGINES = EXE != null ? ["exe"] : (arg("engines") ?? "chromium").split(",");
const WAIT_MS = Number(arg("wait") ?? 8000);

// buildWeb.mjs's copies, first match wins (the app's own assets over the root's).
const MOUNTS = [
  ["/dist/", "apps/app/dist/"],
  ["/vendor/", "apps/app/vendor/"],
  ["/page/", "apps/app/page/"],
  ["/sample/", "apps/app/sample/"],
  ["/assets/", "apps/app/assets/"],
  ["/assets/", "assets/"],
  ["/examples/", "examples/"],
];
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif",
};
function resolve(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (pathname.startsWith(prefix)) {
      const file = path.join(REPO, dir, pathname.slice(prefix.length));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return path.join(REPO, "apps/app/index.html");
}
const server = http.createServer((req, res) => {
  const file = resolve(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const results = {};
for (const engine of ENGINES) {
  const type = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
  const options = { headless: true, args: ["--mute-audio"] };
  if (engine === "exe") options.executablePath = EXE;
  let browser;
  const errors = [];
  try {
    browser = await type.launch(options);
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(`http://localhost:${port}/`);
    await page.waitForTimeout(WAIT_MS);
    const state = await page.evaluate(() => {
      const root = document.querySelector("app-root");
      return {
        ua: navigator.userAgent.replace(/.*(Chrome|Firefox|Version)\//, "$1/").slice(0, 40),
        appRootDefined: !!customElements.get("app-root"),
        appRootChildren: root ? root.querySelectorAll("*").length : -1,
        previewCanvas: !!document.querySelector("preview-canvas canvas"),
        timeline: !!document.querySelector("element-timeline-canvas, element-timeline"),
      };
    });
    results[LABEL ?? engine] = { ...state, errors: [...new Set(errors)].slice(0, 5) };
  } catch (error) {
    results[LABEL ?? engine] = `failed: ${error.message.split("\n")[0]}`;
  } finally {
    await browser?.close();
  }
}
server.close();
console.log(JSON.stringify(results, null, 1));
