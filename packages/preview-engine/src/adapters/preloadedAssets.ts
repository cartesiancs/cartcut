/**
 * Browser adapter for the export paths' preloaded media map.
 *
 * Both exporters load every asset up front into a flat `{ [elementId]: media }`
 * map — images as `HTMLImageElement`, videos as `HTMLVideoElement`, GIFs as the
 * decoded frame array from gifuct-js — and then composite from it. This turns
 * that map into the three things the frame loop needs: an `AssetResolver`, a
 * `prepareFrame` that seeks videos, and a canvas encoder.
 *
 * DOM-dependent by nature (canvases, `<video>` events), like glFilter, so it
 * lives beside the pure core rather than inside it. The preview does *not* use
 * this — it has its own lazy-loading resolver, because it must draw a usable
 * frame before every asset has arrived.
 */

import type { RenderElement, RenderTimeline } from "../model/timeline.types";
import type { AssetResolver, ImageSource, VideoHandle } from "../render/types";
import { pickGifFrameIndex } from "../assets/gifFrame";

/** Element id -> preloaded media. Values are whatever the loader put there. */
export type LoadedMedia = Record<string, any>;

/**
 * Resolver over a preloaded map. Anything not yet in the map resolves to `null`,
 * which makes the drawer skip that element for the frame instead of throwing —
 * the originals indexed the map unguarded and crashed on a slow load.
 */
export function createPreloadedResolver(loaded: LoadedMedia): AssetResolver {
  // One scratch canvas per GIF. The preview shared a single canvas across every
  // GIF in the project, so two GIFs with different frame sizes overwrote each
  // other's pixels; keying by element removes that without changing what a
  // project with one GIF renders.
  const gifScratch = new Map<
    string,
    { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
  >();

  // Kept per resolver, not module-wide, so two renders never share GL state.
  const videoHandles = new Map<string, VideoHandle>();

  return {
    getImage(id: string): ImageSource | null {
      return (loaded[id] as ImageSource) ?? null;
    },

    getVideo(id: string): VideoHandle | null {
      const media = loaded[id];
      if (!media) return null;
      // The filter code caches its WebGL handles on this object between frames,
      // so it has to be the same object every time for a given element.
      let handle = videoHandles.get(id);
      if (!handle || handle.object !== media) {
        handle = { object: media as ImageSource };
        videoHandles.set(id, handle);
      }
      return handle;
    },

    getGifFrame(
      id: string,
      _el: RenderElement,
      timeMs: number,
    ): ImageSource | null {
      const frames = loaded[id];
      if (!Array.isArray(frames) || frames.length === 0) return null;

      const index = pickGifFrameIndex(frames.length, frames[0]?.delay, timeMs);
      const frame = frames[index];
      if (!frame?.dims) return null;

      const { width, height } = frame.dims;
      let scratch = gifScratch.get(id);
      if (!scratch) {
        const canvas = document.createElement("canvas");
        scratch = {
          canvas,
          ctx: canvas.getContext("2d") as CanvasRenderingContext2D,
        };
        gifScratch.set(id, scratch);
      }
      if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
        scratch.canvas.width = width;
        scratch.canvas.height = height;
      }

      const imageData = scratch.ctx.createImageData(width, height);
      imageData.data.set(frame.patch);
      scratch.ctx.putImageData(imageData, 0, 0);
      return scratch.canvas;
    },
  };
}

/**
 * `prepareFrame` for the frame loop: seek every video that is on screen at
 * `timeMs` and wait for it to present that frame.
 *
 * Each seek is bounded by `seekTimeoutMs`. The originals waited on `seeked`
 * with no timeout, so one video that never fired the event stopped the export
 * for good; here the frame is composited with whatever is currently presented
 * and the render moves on.
 */
export function createVideoSeeker(
  loaded: LoadedMedia,
  timeline: RenderTimeline,
  { seekTimeoutMs = 3000 }: { seekTimeoutMs?: number } = {},
) {
  return async function prepareFrame(
    timeMs: number,
    visibleIds: string[],
  ): Promise<void> {
    const seeks = visibleIds
      .filter((id) => timeline[id]?.filetype === "video")
      .map((id) => {
        const video = loaded[id] as HTMLVideoElement | undefined;
        if (!video) return null;
        const el = timeline[id];
        const startTime = Number(el.startTime) || 0;
        const speed = Number(el.speed) || 1;
        // Same mapping the originals used: project time -> media time.
        const target = (-(startTime - timeMs) * speed) / 1000;
        return seekVideo(video, target, seekTimeoutMs);
      })
      .filter(Boolean) as Promise<void>[];

    if (seeks.length > 0) await Promise.all(seeks);
  };
}

function seekVideo(
  video: HTMLVideoElement,
  target: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener("seeked", done);
    try {
      video.currentTime = target;
    } catch {
      done();
    }
  });
}

/** `encodeCanvas` for the frame loop: the canvas as a PNG ArrayBuffer. */
export function createCanvasEncoder(canvas: HTMLCanvasElement) {
  return function encodeCanvas(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("canvas.toBlob produced no data"));
          return;
        }
        blob.arrayBuffer().then(resolve, reject);
      }, "image/png");
    });
  };
}
