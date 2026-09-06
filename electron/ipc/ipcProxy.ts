/**
 * The renderer's view of proxy media.
 *
 * Four calls and one event. `generate` is the only slow one, and it reports
 * progress on `proxy:progress` rather than resolving late and silently — a
 * 3600x2338 source is a minute of transcoding, and a UI with no signal during
 * that is indistinguishable from one that has hung.
 *
 * Generation is serialised deliberately. Running four x264 encodes at once
 * saturates the same CPU the preview is trying to composite on, which turns
 * "your playback will get better shortly" into "your playback is worse now".
 * One at a time, and the first file the user is looking at finishes soonest.
 */

import type { IpcMainInvokeEvent } from "electron";
import {
  clearProxies,
  ensureProxy,
  listProxies,
  probeSource,
  proxyBytes,
  proxyDir,
  type ProxyEntry,
} from "../lib/proxy";
import { needsProxy } from "../lib/proxyRecipe";

export type GenerateResult = {
  ok: boolean;
  /** Entries created or already present, by source path. */
  made: ProxyEntry[];
  /** Sources that did not need one. */
  skipped: string[];
  /** Sources that failed, with the reason. */
  failed: { source: string; error: string }[];
};

/** True while a generation pass is running, so a second press is a no-op. */
let running = false;

export const ipcProxy = {
  /** Every proxy that exists and still matches its source, keyed by source path. */
  list: async (): Promise<Record<string, ProxyEntry>> => {
    const bySource: Record<string, ProxyEntry> = {};
    for (const entry of Object.values(listProxies())) {
      bySource[entry.source] = entry;
    }
    return bySource;
  },

  /** Folder and total size, for the settings panel. */
  stats: async () => ({ dir: proxyDir(), bytes: proxyBytes() }),

  /**
   * Which of these sources would benefit from a proxy.
   *
   * Separate from `generate` so the UI can say "3 of 6 files" before the user
   * commits to a transcode, rather than after.
   */
  inspect: async (_event: IpcMainInvokeEvent, sources: string[]) => {
    const out: { source: string; needsProxy: boolean; error?: string }[] = [];
    for (const source of sources) {
      try {
        out.push({ source, needsProxy: needsProxy(await probeSource(source)) });
      } catch (error) {
        out.push({
          source,
          needsProxy: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  },

  generate: async (
    event: IpcMainInvokeEvent,
    sources: string[],
    force = false,
  ): Promise<GenerateResult> => {
    if (running) {
      return {
        ok: false,
        made: [],
        skipped: [],
        failed: [{ source: "", error: "A proxy pass is already running." }],
      };
    }
    running = true;

    const made: ProxyEntry[] = [];
    const skipped: string[] = [];
    const failed: { source: string; error: string }[] = [];

    // De-duplicated: a timeline of twelve clips cut from four files must run
    // four transcodes, not twelve.
    const unique = [...new Set(sources)];

    try {
      for (let i = 0; i < unique.length; i++) {
        const source = unique[i];
        try {
          const entry = await ensureProxy(
            source,
            (p) =>
              event.sender.send("proxy:progress", {
                source,
                fraction: p.fraction,
                index: i,
                total: unique.length,
              }),
            force,
          );
          if (entry == null) {
            skipped.push(source);
          } else {
            made.push(entry);
          }
        } catch (error) {
          failed.push({
            source,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      running = false;
    }

    event.sender.send("proxy:done", { made, skipped, failed });
    return { ok: failed.length === 0, made, skipped, failed };
  },

  clear: async () => {
    clearProxies();
    return { ok: true };
  },
};
