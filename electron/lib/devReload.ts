/**
 * Hot reload of the editor window during development.
 *
 * Main watches `apps/app/dist`, where `webpack --watch` writes the renderer
 * bundle, and answers a rebuild in the cheapest way that is still correct: a
 * stylesheet-only change swaps `dist/style.css` in place and keeps the page,
 * anything else reloads the window.
 *
 * A reload drops the `TimelineDocument` and the undo history, which is why
 * `menu.ts` refuses to offer one. So this is off unless it is asked for twice:
 * `isDev` (never true in a packaged build) and `CARTCUT_HOT_RELOAD=1`, which
 * only `scripts/devElectron.mjs` sets. A plain `npm run start` and the e2e
 * harness, both unpackaged, therefore behave exactly as they did before.
 *
 * The main process is not reloaded from here. A new `main/` build needs a new
 * process, and that restart belongs to the runner that owns the process.
 *
 * No `electron-is-dev` import: it throws outside Electron, and the decisions
 * below have to run under vitest.
 */

import * as fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { WebContents } from "electron";

export const HOT_RELOAD_ENV = "CARTCUT_HOT_RELOAD";

/**
 * Long enough for webpack to finish writing both assets of one rebuild, so a
 * change that touches the script and the stylesheet is one reload and not a
 * stylesheet swap followed by a reload.
 */
export const RELOAD_DEBOUNCE_MS = 200;

export function hotReloadEnabled(isDev: boolean, env: Record<string, string | undefined>): boolean {
  return isDev === true && env[HOT_RELOAD_ENV] === "1";
}

export type ReloadAction = "none" | "css" | "reload";

/** A stylesheet can be swapped under a live page; a script cannot. */
export function actionFor(changed: readonly string[]): ReloadAction {
  if (changed.length === 0) {
    return "none";
  }
  return changed.every((file) => file.endsWith(".css")) ? "css" : "reload";
}

/** Only what `index.html` loads. A `.map` is read by nothing that runs. */
export function isBundleAsset(file: string): boolean {
  return file.endsWith(".js") || file.endsWith(".css");
}

/**
 * Which files really differ from the last time they were seen.
 *
 * `fs.watch` reports a write, not a change. The first build of a watch session
 * rewrites the bundle the window already loaded, and a reload for identical
 * bytes is a lost document for nothing.
 */
export function createChangeTracker(read: (file: string) => Buffer | null) {
  const digests = new Map<string, string>();

  const digestOf = (file: string): string | null => {
    const bytes = read(file);
    return bytes == null ? null : createHash("sha1").update(bytes).digest("hex");
  };

  return {
    seed(files: readonly string[]): void {
      for (const file of files) {
        const digest = digestOf(file);
        if (digest != null) {
          digests.set(file, digest);
        }
      }
    },

    /** The subset of `files` whose content moved. Records what it saw. */
    changed(files: readonly string[]): string[] {
      const moved: string[] = [];
      for (const file of files) {
        const digest = digestOf(file);
        // Deleted, or rewritten with the bytes already loaded. A file still
        // mid-write never gets here: the caller compares only after the
        // burst's last event, never on the truncation that starts it.
        if (digest == null || digests.get(file) === digest) {
          continue;
        }
        digests.set(file, digest);
        moved.push(file);
      }
      return moved;
    },
  };
}

/**
 * Re-requests each changed stylesheet by rewriting its `href`. Matched on the
 * attribute with any earlier cache-buster stripped, because `link.href` is the
 * resolved `file://` URL and would stop matching after the first swap.
 */
export function stylesheetSwapScript(files: readonly string[], stamp: number): string {
  const hrefs = JSON.stringify(files.map((file) => "dist/" + file));
  return `(() => {
  const hrefs = ${hrefs};
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const href = (link.getAttribute("href") || "").split("?")[0];
    if (hrefs.includes(href)) {
      link.setAttribute("href", href + "?hot=${stamp}");
    }
  }
})();`;
}

/**
 * Watch the renderer bundle and keep `webContents` on the latest build.
 * Returns the function that stops watching.
 */
export function watchRendererBundle(webContents: WebContents, distDir: string): () => void {
  const read = (file: string): Buffer | null => {
    try {
      return fs.readFileSync(path.join(distDir, file));
    } catch {
      return null;
    }
  };

  const tracker = createChangeTracker(read);
  try {
    tracker.seed(fs.readdirSync(distDir).filter(isBundleAsset));
  } catch {
    // No build yet. Every file is then new, and the first one reloads.
  }

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (webContents.isDestroyed()) {
      return;
    }
    const changed = tracker.changed([...pending]);
    pending.clear();

    const action = actionFor(changed);
    if (action === "none") {
      return;
    }
    console.log(`[hot] ${changed.join(", ")} changed: ${action === "css" ? "swapping stylesheet" : "reloading window"}`);
    if (action === "css") {
      // A page that is mid-load has no stylesheet to swap yet; reloading it
      // lands on the new one either way.
      webContents
        .executeJavaScript(stylesheetSwapScript(changed, Date.now()))
        .catch(() => webContents.reloadIgnoringCache());
    } else {
      webContents.reloadIgnoringCache();
    }
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(distDir, (_event, filename) => {
      if (typeof filename !== "string" || !isBundleAsset(filename)) {
        return;
      }
      pending.add(filename);
      if (timer != null) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, RELOAD_DEBOUNCE_MS);
    });
  } catch (error) {
    console.warn("[hot] cannot watch " + distDir + ":", error);
    return () => {};
  }

  console.log("[hot] watching " + distDir);

  const stop = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    watcher.close();
  };
  webContents.once("destroyed", stop);
  return stop;
}
