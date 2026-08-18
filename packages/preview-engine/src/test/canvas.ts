/**
 * Shared helpers for the headless-canvas drawer tests.
 *
 * `@napi-rs/canvas` gives a real Skia 2D context in Node, so the drawers can be
 * exercised exactly as the browser runs them and asserted on actual pixels
 * rather than on recorded call sequences. Not exported from the package barrel —
 * this is test-only.
 */

import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { CanvasCtx, AssetResolver } from "../render/types";

export type Rgba = { r: number; g: number; b: number; a: number };

/** A canvas plus its 2D context, typed as the engine expects. */
export function scene(w: number, h: number, background?: string) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as CanvasCtx;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  return { canvas, ctx };
}

/** A solid-colour canvas usable as a `drawImage` source. */
export function solid(w: number, h: number, color: string): Canvas {
  const c = createCanvas(w, h);
  const cx = c.getContext("2d");
  cx.fillStyle = color;
  cx.fillRect(0, 0, w, h);
  return c;
}

export function pixel(canvas: Canvas, x: number, y: number): Rgba {
  const d = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/** An AssetResolver that returns nothing; override just what a test needs. */
export const noAssets: AssetResolver = {
  getImage: () => null,
  getGifFrame: () => null,
  getVideo: () => null,
};

/** Baked `[ms, value]` keyframe pairs, the form `findNearestY` samples. */
export function track(...pairs: Array<[number, number]>): number[][] {
  return pairs.map(([x, y]) => [x, y]);
}
