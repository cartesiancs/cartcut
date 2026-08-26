/**
 * Rendered preview frames for preset tiles.
 *
 * The third implementation of this codebase's provider shape, after
 * `strip/videoTiles.ts` and `strip/audioPeaks.ts`, and deliberately the same
 * one: **`get` is synchronous and never renders; `request` is fire-and-forget
 * and dedupes.** A tile that misses draws nothing this frame, asks, and is
 * repainted when the frame lands. A panel of seventy tiles therefore paints
 * immediately and fills in, rather than blocking on seventy GL draws.
 *
 * ## Its own GL context, and why that is not optional
 *
 * `FxCompositor.applyEffect` and `drawTransition` both size the GL canvas to
 * the frame they are given, and **assigning any canvas dimension reallocates
 * and clears the drawing buffer even when the value is identical** — the
 * existing pipeline guards against exactly that. Sharing the preview
 * compositor would mean bouncing between 1920×1080 and 192×108 and wiping both
 * every frame. `createExportFxRuntime` already sets the precedent for a second
 * compositor with a context of its own.
 *
 * ## Why a `step` and not a progress
 *
 * Rendering at a continuous progress means a fresh cache key every frame, so
 * the cache never hits and a hovered tile re-renders sixty times a second.
 * Quantising to a fixed ladder of steps bounds a preset to `STEPS` frames
 * total, all reusable — the same trick `strip/tiles.ts` plays with `sourceMs`
 * to keep a filmstrip's keys stable across a zoom nudge.
 */

import type {
  EffectElementType,
  TransitionElementType,
} from "../../@types/timeline";
import { createTileCache } from "../timeline/strip/cache";
import type { TileProvider } from "../timeline/strip/provider";
import { FxCompositor } from "../renderer/fx/compositor";
import type {
  ActiveEffect,
  ActiveTransition,
} from "../renderer/fx/planFrame";
import { presetById } from "./presetRegistry";
import { defaultParamsOf } from "./presetTypes";
import { sampleFrameCanvas } from "./sampleFrames";

/** Tile size every preview renders at. Fixed, so the GL canvas never resizes. */
export const PREVIEW_W = 192;
export const PREVIEW_H = 108;

/**
 * How many distinct frames a preset's animation is quantised to.
 *
 * Twenty-four is enough that a hovered transition reads as motion and few
 * enough that one preset's whole loop costs 24 small draws, cached once.
 */
export const PREVIEW_STEPS = 24;

/**
 * The step shown when a tile is not hovered.
 *
 * Part-way through, because at 0 or 1 every transition is just one of the two
 * frames and they would all look identical. Not the *midpoint*, though, which
 * is where a whole class of them is momentarily at its least informative: Dip
 * to Colour is exactly at its dip colour there and renders solid black, Flash
 * is blown to solid white, and Card Flip is edge-on and renders nothing at all.
 * A third of the way in, all three show what they do, and nothing that reads
 * well at the midpoint reads worse here.
 */
export const RESTING_STEP = Math.round((PREVIEW_STEPS - 1) / 3);

/**
 * Frames kept across all presets.
 *
 * Seventy presets × one resting frame each, plus a full 24-frame loop for the
 * few most recently hovered. `close()` on eviction releases the `ImageBitmap`'s
 * GPU memory, which is the whole reason `createTileCache` takes a `Disposable`.
 */
const MAX_TILES = 260;

/** How many renders may be outstanding. Keeps a scroll from queuing hundreds. */
const MAX_PENDING = 16;

export type FxPreviewRequest = {
  key: string;
  presetId: string;
  /** 0..PREVIEW_STEPS-1. */
  step: number;
};

export type FxPreviewProvider = TileProvider & {
  onReady(callback: () => void): () => void;
  dispose(): void;
  readonly cachedTiles: number;
  readonly pendingTiles: number;
};

export function previewKey(presetId: string, step: number): string {
  return presetId + "|" + step;
}

/** Progress or seconds for a step. Transitions run 0..1; effects run a loop. */
export function progressForStep(step: number): number {
  return PREVIEW_STEPS <= 1 ? 0.5 : step / (PREVIEW_STEPS - 1);
}

/** Seconds an effect preview is at. Two seconds of loop reads as motion. */
export function timeForStep(step: number): number {
  return (step / PREVIEW_STEPS) * 2;
}

export function createFxPreviewProvider(): FxPreviewProvider {
  const cache = createTileCache<ImageBitmap>({ maxTiles: MAX_TILES });
  const pending: FxPreviewRequest[] = [];
  const queued = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();

  let gl: WebGLRenderingContext | null = null;
  let compositor: FxCompositor | null = null;
  let target: HTMLCanvasElement | null = null;
  let working = false;
  let disposed = false;
  let readyHandle = 0;

  /**
   * Tell subscribers at most once per frame.
   *
   * N tiles landing in the same tick would otherwise be N repaints of the whole
   * panel. Lifted from `videoTiles.ts`, where it exists for the same reason.
   */
  function notifyReady(): void {
    if (readyHandle !== 0 || disposed) {
      return;
    }
    readyHandle = requestAnimationFrame(() => {
      readyHandle = 0;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("fx preview: listener failed", error);
        }
      }
    });
  }

  function ensureContext(): boolean {
    if (compositor != null) {
      return true;
    }
    if (disposed) {
      return false;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_W;
      canvas.height = PREVIEW_H;
      gl = canvas.getContext("webgl", {
        preserveDrawingBuffer: true,
        alpha: true,
        premultipliedAlpha: false,
      }) as WebGLRenderingContext | null;
      if (gl == null) {
        return false;
      }
      // Not blocking: nothing reads these back on the CPU, and a `finish()` per
      // tile would stall the panel for no gain.
      compositor = new FxCompositor(gl, { blocking: false });

      target = document.createElement("canvas");
      target.width = PREVIEW_W;
      target.height = PREVIEW_H;
    } catch {
      return false;
    }
    return true;
  }

  /** A 2D context holding the A sample frame, which effects are applied over. */
  function freshTarget(): CanvasRenderingContext2D | null {
    if (target == null) {
      return null;
    }
    const ctx = target.getContext("2d");
    const sample = sampleFrameCanvas("a", PREVIEW_W, PREVIEW_H);
    if (ctx == null || sample == null) {
      return null;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    ctx.drawImage(sample, 0, 0, PREVIEW_W, PREVIEW_H);
    return ctx;
  }

  async function render(request: FxPreviewRequest): Promise<void> {
    const preset = presetById(request.presetId);
    if (preset == null || !ensureContext() || compositor == null) {
      failed.add(request.key);
      return;
    }

    const ctx = freshTarget();
    if (ctx == null) {
      failed.add(request.key);
      return;
    }

    const params = defaultParamsOf(preset);

    if (preset.kind === "transition") {
      // A hand-built literal is enough: the compositor reads only `progress`,
      // `params` and the two ids off it, and never touches the document.
      const active = {
        id: "preview",
        element: { params } as unknown as TransitionElementType,
        fromId: "a",
        toId: "b",
        progress: progressForStep(request.step),
        drawAtId: "a",
      } as ActiveTransition;

      compositor.drawTransition(
        ctx,
        active,
        preset,
        PREVIEW_W,
        PREVIEW_H,
        // The `DrawOne` the paint loop normally supplies. Here it paints a
        // sample frame instead of a clip, which is what keeps this whole path
        // independent of whether a project is even open.
        (into, elementId) => {
          const sample = sampleFrameCanvas(
            elementId === "a" ? "a" : "b",
            PREVIEW_W,
            PREVIEW_H,
          );
          if (sample != null) {
            into.drawImage(sample, 0, 0, PREVIEW_W, PREVIEW_H);
          }
        },
      );
    } else {
      const active = {
        id: "preview",
        element: {
          params,
          intensity: 100,
          startTime: 0,
        } as unknown as EffectElementType,
        mode: preset.render.type === "overlay" ? "overlay" : "shader",
      } as ActiveEffect;

      // An overlay preset has no still to show — its media is a video this
      // panel does not decode — so it previews as its sample frame untouched
      // rather than as nothing at all.
      compositor.applyEffect(
        ctx,
        active,
        preset,
        PREVIEW_W,
        PREVIEW_H,
        null,
        timeForStep(request.step),
      );
    }

    try {
      const bitmap = await createImageBitmap(target as HTMLCanvasElement);
      if (disposed) {
        bitmap.close();
        return;
      }
      cache.set(request.key, bitmap);
      notifyReady();
    } catch {
      failed.add(request.key);
    }
  }

  async function pump(): Promise<void> {
    if (working || disposed) {
      return;
    }
    working = true;
    try {
      while (pending.length > 0 && !disposed) {
        const request = pending.shift()!;
        queued.delete(request.key);
        if (cache.has(request.key)) {
          continue;
        }
        await render(request);
      }
    } finally {
      working = false;
    }
  }

  return {
    get(key) {
      return cache.get(key);
    },

    request(raw) {
      const request = raw as unknown as FxPreviewRequest;
      if (
        disposed ||
        request.key == null ||
        cache.has(request.key) ||
        queued.has(request.key) ||
        failed.has(request.key)
      ) {
        return;
      }
      queued.add(request.key);
      pending.push(request);
      // Drop the *oldest* when the queue is long: the newest requests are for
      // what the user is looking at now.
      while (pending.length > MAX_PENDING) {
        const dropped = pending.shift();
        if (dropped != null) {
          queued.delete(dropped.key);
        }
      }
      void pump();
    },

    onReady(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    dispose() {
      disposed = true;
      if (readyHandle !== 0) {
        cancelAnimationFrame(readyHandle);
        readyHandle = 0;
      }
      listeners.clear();
      pending.length = 0;
      queued.clear();
      cache.clear();
      compositor?.dispose();
      compositor = null;
      gl = null;
      target = null;
    },

    get cachedTiles() {
      return cache.size;
    },
    get pendingTiles() {
      return pending.length;
    },
  };
}
