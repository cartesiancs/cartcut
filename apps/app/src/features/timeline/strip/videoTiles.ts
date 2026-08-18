/**
 * Decodes filmstrip frames from the source files.
 *
 * One hidden `<video>` per source file, seeked to each frame the timeline asks
 * for. That is the same trick `assetList.captureVideoThumbnail` already uses for
 * the asset browser, made repeatable and bounded.
 *
 * The rules that keep it from wrecking the frame rate:
 *
 *   - `get` never decodes. It reads the cache and returns, so the draw pass is
 *     never blocked; misses paint the clip's flat colour and fill in later.
 *   - One seek at a time per file. A `<video>` has a single playhead, so
 *     overlapping seeks would fight each other.
 *   - Requests dedupe by key and the queue is bounded. Scrolling fast generates
 *     far more requests than anyone will ever look at, so the oldest are
 *     dropped — they are the ones most likely to be off-screen by now.
 *   - Completions are coalesced into one repaint per animation frame.
 */

import { getLocationEnv } from "../../../functions/getLocationEnv";
import { createTileCache, type Disposable } from "./cache";
import type { TileProvider, TileRequest } from "./provider";

/** Roughly a few screens' worth of 40px tiles. */
const MAX_TILES = 400;
/** Beyond this, the oldest pending requests are dropped unrendered. */
const MAX_PENDING = 24;

type CachedTile = CanvasImageSource & Disposable;

/** Mirrors `loadedAssetStore.getPath` so web mode resolves the same way. */
function resolvePath(localpath: string): string {
  return getLocationEnv() === "electron"
    ? localpath
    : `/api/file?path=${localpath}`;
}

export type VideoTileProvider = TileProvider & {
  /** Called after new tiles land, so the host can repaint. */
  onReady(callback: () => void): () => void;
  invalidate(localpath: string): void;
  dispose(): void;
  /** How many frames are currently held. Useful for diagnosing a blank strip. */
  readonly cachedTiles: number;
  /** How many requests are still waiting to be decoded. */
  readonly pendingTiles: number;
};

export function createVideoTileProvider(): VideoTileProvider {
  const cache = createTileCache<CachedTile>({ maxTiles: MAX_TILES });
  const videos = new Map<string, HTMLVideoElement>();
  const pending: TileRequest[] = [];
  const queued = new Set<string>();
  const listeners = new Set<() => void>();

  let working = false;
  let readyHandle = 0;

  function notifyReady() {
    if (readyHandle !== 0) {
      return;
    }
    readyHandle = requestAnimationFrame(() => {
      readyHandle = 0;
      for (const listener of listeners) {
        listener();
      }
    });
  }

  function videoFor(localpath: string): HTMLVideoElement {
    const existing = videos.get(localpath);
    if (existing) {
      return existing;
    }

    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = resolvePath(localpath);
    videos.set(localpath, video);
    return video;
  }

  function seek(video: HTMLVideoElement, timeSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("seek failed"));
      };
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };

      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      try {
        video.currentTime = timeSec;
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  async function ready(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= 1) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("load failed")), {
        once: true,
      });
    });
  }

  async function capture(request: TileRequest): Promise<void> {
    const video = videoFor(request.localpath);
    await ready(video);

    // Seeking past the end never fires `seeked`, so clamp into the file.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const timeSec = Math.min(
      Math.max(0, request.sourceMs / 1000),
      Math.max(0, duration - 0.05),
    );
    await seek(video, timeSec);

    let tile: CachedTile;
    if (typeof createImageBitmap === "function") {
      tile = (await createImageBitmap(video, {
        resizeWidth: request.tileW,
        resizeHeight: request.tileH,
        resizeQuality: "low",
      })) as unknown as CachedTile;
    } else {
      // Older runtimes: a canvas is also a valid drawImage source.
      const canvas = document.createElement("canvas");
      canvas.width = request.tileW;
      canvas.height = request.tileH;
      canvas
        .getContext("2d")
        ?.drawImage(video, 0, 0, request.tileW, request.tileH);
      tile = canvas as unknown as CachedTile;
    }

    cache.set(request.key, tile);
  }

  async function pump(): Promise<void> {
    if (working) {
      return;
    }
    working = true;

    try {
      while (pending.length > 0) {
        const request = pending.shift()!;
        queued.delete(request.key);

        if (cache.has(request.key)) {
          continue;
        }

        try {
          await capture(request);
          notifyReady();
        } catch {
          // A missing or undecodable file just leaves the flat colour showing;
          // failing loudly here would spam on every repaint.
        }
      }
    } finally {
      working = false;
    }
  }

  return {
    get(key) {
      return cache.get(key);
    },

    request(request) {
      if (cache.has(request.key) || queued.has(request.key)) {
        return;
      }

      pending.push(request);
      queued.add(request.key);

      // Drop the oldest rather than the newest: the newest requests are the
      // ones for what is on screen right now.
      while (pending.length > MAX_PENDING) {
        const dropped = pending.shift()!;
        queued.delete(dropped.key);
      }

      void pump();
    },

    onReady(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    invalidate(localpath) {
      cache.invalidatePath(localpath);
      videos.get(localpath)?.removeAttribute("src");
      videos.delete(localpath);
    },

    get cachedTiles() {
      return cache.size;
    },

    get pendingTiles() {
      return pending.length;
    },

    dispose() {
      cache.clear();
      for (const video of videos.values()) {
        video.removeAttribute("src");
      }
      videos.clear();
      listeners.clear();
      pending.length = 0;
      queued.clear();
      if (readyHandle !== 0) {
        cancelAnimationFrame(readyHandle);
        readyHandle = 0;
      }
    },
  };
}
