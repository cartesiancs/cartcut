// Opens an example template in the real web editor and saves the preview at a
// few instants, to see HTML graphics drawn by whichever host the browser gets.
// Serves the renderer the way boot.mjs does (nothing is built or written).
//
//   node tests/spikes/snapshot/editor.mjs --engines=webkit,firefox --template=cartcut-promo \
//        --times=1000,2500 --out=<dir>
//   node tests/spikes/snapshot/editor.mjs --exe=/path/to/chrome --label=chrome-157 ...
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const TEMPLATE = arg("template") ?? "cartcut-promo";
const TIMES = (arg("times") ?? "1000").split(",").map(Number);
const OUT = arg("out") ?? path.join(os.tmpdir(), "cartcut-snapshot-spike");
const SETTLE_MS = Number(arg("settle") ?? 3000);
const FLAGS = (arg("flags") ?? "").split(" ").filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

// `--examples=<dir>` serves a scratch folder ahead of the repo's own examples
// (where presetTemplate.ts writes the preset gallery).
const EXAMPLES = arg("examples");
const MOUNTS = [
  ...(EXAMPLES != null ? [["/examples/", EXAMPLES + "/"]] : []),
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
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};
function resolve(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (pathname.startsWith(prefix)) {
      const file = path.resolve(REPO, dir, pathname.slice(prefix.length));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return path.extname(pathname) !== "" ? null : path.join(REPO, "apps/app/index.html");
}
const server = http.createServer((req, res) => {
  const file = resolve(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  if (file == null) {
    res.writeHead(404);
    res.end();
    return;
  }
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  if (range != null) {
    const start = range[1] === "" ? 0 : Number(range[1]);
    const end = range[2] === "" ? size - 1 : Number(range[2]);
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const results = {};
for (const engine of ENGINES) {
  const type = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
  const options = { headless: true, args: engine === "firefox" || engine === "webkit" ? [] : ["--mute-audio", ...FLAGS] };
  if (engine === "exe") options.executablePath = EXE;
  const label = LABEL ?? engine;
  let browser;
  const notes = [];
  try {
    browser = await type.launch(options);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    if (process.argv.includes("--export")) {
      // No save picker, so the export lands as a download Playwright can take.
      await page.addInitScript(() => {
        try { delete window.showSaveFilePicker; } catch {}
        window.showSaveFilePicker = undefined;
      });
    }
    if (process.argv.includes("--dump-svg")) {
      // Keep every snapshot SVG the page decodes, to replay one by hand.
      await page.addInitScript(() => {
        const encode = window.encodeURIComponent;
        window.__svgs = [];
        window.encodeURIComponent = (value) => {
          if (typeof value === "string" && value.startsWith("<svg") && value.includes("cc-host")) {
            window.__svgs.push(value);
            if (window.__svgs.length > 40) window.__svgs.shift();
          }
          return encode(value);
        };
      });
    }
    page.on("pageerror", (e) => notes.push("pageerror " + e.message.slice(0, 160)));
    page.on("console", (m) => {
      const text = m.text();
      if (/graphic|snapshot|hb-subset|export|title/i.test(text)) notes.push(`${m.type()} ${text.slice(0, 240)}`);
    });
    await page.goto(`http://localhost:${port}/?template=${TEMPLATE}`);
    await page.waitForFunction(
      () => Object.keys(window.CARTCUT?.useTimelineStore?.getState?.().timeline ?? {}).length > 0,
      null,
      { timeout: 60000 },
    );
    const shots = [];
    for (const time of TIMES) {
      await page.evaluate((t) => window.CARTCUT.useTimelineStore.getState().setCursor(t), time);
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate((t) => window.CARTCUT.useTimelineStore.getState().setCursor(t), time);
      await page.waitForTimeout(SETTLE_MS / 2);
      if (process.argv.includes("--live")) {
        // The live mount itself, made visible: what this engine's own DOM draws.
        // The mount of the preset under the playhead (`--live-names`, one per
        // time). A template opens as one clip, so mounts are `<outer>::spike-<name>`.
        const wanted = "spike-" + ((arg("live-names") ?? "").split(",")[TIMES.indexOf(time)] ?? "");
        const box = await page.evaluate((suffix) => {
          const hosts = Array.from(document.querySelectorAll("div[data-graphic-host]"));
          const host = hosts.find((h) => (h.dataset.graphicHost ?? "").endsWith(suffix)) ?? null;
          if (host == null) {
            console.log("graphic-live-debug " + JSON.stringify({ suffix, hosts: hosts.map((h) => h.dataset.graphicHost) }));
            return null;
          }
          host.style.opacity = "1";
          host.style.zIndex = "2147483647";
          host.style.background = "#202830";
          const r = host.getBoundingClientRect();
          return { x: r.x, y: r.y, width: Math.min(r.width, 1440), height: Math.min(r.height, 900) };
        }, wanted);
        if (box != null) {
          await page.screenshot({ path: path.join(OUT, `${TEMPLATE}-${label}-${time}-live.png`), clip: box });
          await page.evaluate(() => document.querySelectorAll("div[data-graphic-host]").forEach((h) => { h.style.opacity = "0"; h.style.zIndex = "-1"; }));
        }
      }
      if (process.argv.includes("--dump-svg")) {
        const svgs = await page.evaluate(() => window.__svgs.splice(0));
        svgs.forEach((svg, i) => fs.writeFileSync(path.join(OUT, `${TEMPLATE}-${label}-${time}-${i}.svg`), svg));
      }
      const url = await page.evaluate(() => document.querySelector("preview-canvas canvas")?.toDataURL("image/png") ?? null);
      if (url != null) {
        const file = path.join(OUT, `${TEMPLATE}-${label}-${time}.png`);
        fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
        shots.push(file);
      }
    }
    if (process.argv.includes("--export")) {
      const started = Date.now();
      const download = page.waitForEvent("download", { timeout: Number(arg("export-timeout") ?? 300000) });
      await page.evaluate(() => document.querySelector("export-button .export-trigger")?.click());
      try {
        const file = await download;
        const target = path.join(OUT, `${TEMPLATE}-${label}.${(file.suggestedFilename().split(".").pop() ?? "mp4")}`);
        await file.saveAs(target);
        notes.push(`exported ${path.basename(target)} in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (error) {
        notes.push("export failed: " + error.message.split("\n")[0]);
      }
    }
    const hosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-graphic-host]")).map((el) => el.tagName.toLowerCase()),
    );
    results[label] = {
      hosts: hosts.reduce((acc, tag) => ({ ...acc, [tag]: (acc[tag] ?? 0) + 1 }), {}),
      shots,
      notes: [...new Set(notes)].slice(0, 12),
    };
  } catch (error) {
    results[label] = { failed: error.message.split("\n")[0], notes };
  } finally {
    await browser?.close();
  }
}
server.close();
console.log(JSON.stringify(results, null, 1));
