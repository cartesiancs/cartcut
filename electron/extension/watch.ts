/**
 * Reloading an unpacked extension when its author saves a file.
 *
 * The whole host restarts rather than one extension reloading, and that is a
 * deliberate choice rather than a shortcut. Purging `require.cache` for one
 * extension leaves every module it pulled in still cached and every closure
 * the old copy handed out still live, and an ES module cannot be purged at
 * all. A restart is a second of work and is always correct; the other version
 * is instant and is wrong in a way that produces bug reports nobody can
 * reproduce.
 */

import * as fs from "fs";

/**
 * Long enough for a build to finish writing every file it is going to.
 *
 * A bundler writes a dozen files in a burst, and without the debounce each one
 * would restart the host, so a single save would fork the process a dozen
 * times and the last fork would race the build's own last write.
 */
export const RELOAD_DEBOUNCE_MS = 300;

type Watcher = { close(): void };

let watchers: Watcher[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function watchUnpacked(paths: readonly string[], onChange: () => void): void {
  stopWatching();

  for (const dir of paths) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        // A build writes its output and its sourcemaps and its own scratch
        // files. Restarting for a `.map` is a restart for something no
        // running code will ever read.
        if (typeof filename === "string" && (filename.endsWith(".map") || filename.includes("node_modules"))) {
          return;
        }
        if (timer != null) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          onChange();
        }, RELOAD_DEBOUNCE_MS);
      });
      watchers.push(watcher);
    } catch (error) {
      // A folder that has been deleted, or a platform without recursive
      // watching. Losing live reload is a papercut; failing to start the
      // extension host over it would not be.
      console.warn("[extension] cannot watch " + dir + " for changes:", error);
    }
  }
}

export function stopWatching(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
  }
  watchers = [];
}
