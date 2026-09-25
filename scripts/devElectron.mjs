#!/usr/bin/env node
/**
 * `npm run start:hot`: run the app and keep it on the latest build.
 *
 * Two halves, because the two builds need different things:
 *
 * - `main/` (from `tsc -w`) can only take effect in a new process, so this
 *   script owns the Electron process and restarts it when a compiled file's
 *   content changes.
 * - `apps/app/dist` (from `webpack --watch`) is picked up inside the running
 *   app by `electron/lib/devReload.ts`, which this script switches on with
 *   `CARTCUT_HOT_RELOAD=1`. Nothing else sets it, and a packaged build ignores
 *   it, so the feature does not exist outside this script.
 *
 * Development only by construction: a packaged app is launched by the OS, not
 * by this script, and `devReload.ts` also requires `isDev`, which a packaged
 * build never has, so setting the variable by hand does nothing there.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_DIR = path.join(ROOT, "main");
const REQUIRED = [path.join(MAIN_DIR, "main.js"), path.join(ROOT, "apps/app/dist/index.js")];

// `tsc -w` writes every changed file in one burst; one restart per burst.
const RESTART_DEBOUNCE_MS = 400;

// The `electron` package's main export is the path to the binary. Spawned
// directly, not through its `cli.js`, so the kill below reaches the app and
// not a wrapper that has to forward it.
const ELECTRON = createRequire(import.meta.url)("electron");

const log = (message) => console.log(`[hot] ${message}`);

const isMainOutput = (file) => file.endsWith(".js") || file.endsWith(".json");

const digestOf = (file) => {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

// `tsc -w` rewrites every output on its first pass, identical or not. Only a
// file whose bytes moved restarts the app, or every `npm run dev:hot` would
// open the window twice.
const digests = new Map();
const seed = () => {
  for (const rel of fs.readdirSync(MAIN_DIR, { recursive: true })) {
    const file = path.join(MAIN_DIR, rel);
    if (isMainOutput(file)) {
      digests.set(file, digestOf(file));
    }
  }
};

let child = null;
let restarting = false;
let shuttingDown = false;

const start = () => {
  child = spawn(ELECTRON, ["."], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CARTCUT_HOT_RELOAD: "1" },
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    if (shuttingDown || code === 0) {
      // The window was closed on purpose: the dev session is over.
      process.exit(code ?? 0);
    }
    // A crash. Stay up, so the fix that is about to be saved brings it back.
    log(`electron exited (${signal ?? code}); waiting for the next main build`);
  });
};

const restart = () => {
  if (child == null) {
    start();
    return;
  }
  restarting = true;
  // Killed, not asked to quit. A quit reaches the window's `close` handler,
  // which hands it to the renderer, and an unsaved project there holds it on a
  // prompt that nobody asked for. Auto Save has the work; the OS frees port
  // 9826; Chromium's helpers and the extension host exit with their parent.
  child.kill("SIGKILL");
};

// Compared when the burst is over, never per event: the first event of a
// write is the truncation, and hashing then would call every rewrite a change.
const pending = new Set();
let timer = null;
const flush = () => {
  const moved = [];
  for (const file of pending) {
    const digest = digestOf(file);
    // Deleted, or rewritten unchanged.
    if (digest != null && digests.get(file) !== digest) {
      digests.set(file, digest);
      moved.push(path.relative(MAIN_DIR, file));
    }
  }
  pending.clear();
  if (moved.length > 0) {
    log(`main process changed (${moved.join(", ")}); restarting electron`);
    restart();
  }
};

const onMainWrite = (_event, rel) => {
  if (typeof rel !== "string" || !isMainOutput(rel)) {
    return;
  }
  pending.add(path.join(MAIN_DIR, rel));
  clearTimeout(timer);
  timer = setTimeout(flush, RESTART_DEBOUNCE_MS);
};

const waitForBuild = async () => {
  let announced = false;
  while (!REQUIRED.every((file) => fs.existsSync(file))) {
    if (!announced) {
      log("waiting for the first build (npm run dev)");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    clearTimeout(timer);
    if (child == null) {
      process.exit(0);
    }
    // Not `signal`: Electron turns SIGINT into a quit, which can stop on the
    // same unsaved-work prompt `restart` avoids, and Ctrl+C would then hang.
    child.kill("SIGKILL");
  });
}

await waitForBuild();
seed();
fs.watch(MAIN_DIR, { recursive: true }, onMainWrite);
log("watching main/ (the app itself watches apps/app/dist)");
start();
