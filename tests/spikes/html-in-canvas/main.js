// The html-in-canvas spike: what Chromium 152's CanvasDrawElement actually does
// inside this Electron. Run it from the repository root with
//
//   unset ELECTRON_RUN_AS_NODE
//   ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/spikes/html-in-canvas/main.js
//
// and read the JSON it writes ($SPIKE_OUT, or the OS temp dir). `--only=a,b`
// runs named tests. The iframe tests in spike.html are not in the default list:
// an iframe placed under a layoutsubtree canvas crashes the renderer.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const OUT = process.env.SPIKE_OUT || path.join(require("os").tmpdir(), "html-in-canvas-spike.json");
const REPO = path.resolve(__dirname, "../../..");
const FONT =
  process.argv.find((a) => a.endsWith(".ttf")) ||
  path.join(REPO, "assets/fonts/google/Anton-Regular.ttf");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);

const TESTS = [
  "t1_basic", "t2_shadow", "t3_anim_shadow",
  "t3_smil", "t4_sync", "t5_scale", "t7_fonts", "t7_images",
  "t8_urlref_shadow", "t9_property_shadow",
  "t10_timing",
  "t13_capture_other_canvas", "t14_visibility_variants", "t15_large",
  "t16_transform_root", "t17_overflow", "t9b_property_hoisted",
  "t7b_font_in_shadow", "t18_two_children_one_paint",
];

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}

async function freshWindow(opts = {}) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: opts.show !== false,
    webPreferences: {
      enableBlinkFeatures: "CanvasDrawElement",
      contextIsolation: true,
      backgroundThrottling: opts.throttle !== false,
    },
  });
  win.webContents.on("render-process-gone", (_e, d) => console.log("GONE", JSON.stringify(d)));
  win.webContents.on("unresponsive", () => console.log("UNRESPONSIVE"));
  await win.loadFile(path.join(__dirname, "spike.html"), {
    query: { font: FONT, repo: REPO },
  });
  return win;
}

app.whenReady().then(async () => {
  const results = {};
  const names = ONLY ? ONLY.split(",") : TESTS;
  let win = await freshWindow();
  results.features = await win.webContents.executeJavaScript("features()");
  for (const name of names) {
    console.log("run", name);
    const r = await withTimeout(
      win.webContents.executeJavaScript(`guard(${JSON.stringify(name)}, ${name})`),
      8000,
    );
    results[name] = r;
    if (r && r.hung) {
      console.log("hung:", name);
      win.destroy();
      win = await freshWindow();
    }
  }

  if (!ONLY) {
    try {
      win.minimize();
      await new Promise((r) => setTimeout(r, 800));
      results.minimized = await withTimeout(win.webContents.executeJavaScript("paintProbe()"), 8000);
      win.restore();
      await new Promise((r) => setTimeout(r, 500));
      win.webContents.setBackgroundThrottling(false);
      win.minimize();
      await new Promise((r) => setTimeout(r, 800));
      results.minimizedNoThrottle = await withTimeout(win.webContents.executeJavaScript("paintProbe()"), 8000);
      win.restore();
    } catch (e) {
      results.minimizedError = String(e);
    }
    try {
      const hidden = await freshWindow({ show: false, throttle: false });
      results.hidden = await withTimeout(hidden.webContents.executeJavaScript("paintProbe()"), 8000);
      hidden.destroy();
    } catch (e) {
      results.hiddenError = String(e);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log("written");
  app.quit();
});
