/**
 * The picture on each LUT tile: one fixed sample, graded eighty ways.
 *
 * The sample comes from `sampleImage.ts` and **never changes** — not with the
 * playhead, not with the selection, not with the project. That is a decision
 * about what the panel is for: a grid of eighty tiles is a comparison, and a
 * comparison needs its subject to hold still. An earlier version rendered the
 * timeline at the playhead, which is what Premiere does and which is wrong for
 * a grid: two LUTs looked at a few seconds apart would have been judged
 * against different frames, and nothing on screen would say so.
 *
 * Holding it still also removes most of this file. There is no seek, no FX
 * runtime, no project-resolution render and no need to suppress clip grades
 * while the source is built — the source is a few dozen `fillRect` calls, so it
 * is drawn synchronously, once, and kept.
 *
 * No WebGL context either. A 192×108 still is twenty thousand pixels, which the
 * CPU applier grades in about a millisecond, so this reuses the code the node
 * suites already pin instead of standing up a fourth GL context for thumbnails.
 */

import { createCpuLutApplier } from "../renderer/lut/cpu";
import type { LutData } from "./lutData";
import { SAMPLE_HEIGHT, SAMPLE_WIDTH, drawSampleImage } from "./sampleImage";

export const LUT_PREVIEW_W = SAMPLE_WIDTH;
export const LUT_PREVIEW_H = SAMPLE_HEIGHT;

/**
 * How many graded stills to keep.
 *
 * One per shipped preset with room for a user's own, at 83 KB of `ImageData`
 * each — about 8 MB for the whole panel, which is the price of the grid
 * repainting instantly when it is scrolled or reopened. Nothing evicts in
 * practice; the cap is a bound, not a policy.
 */
const MAX_CACHED = 160;

export type LutPreviewProvider = {
  /** The graded still, or `null` if it has not been made yet. */
  get(presetId: string): ImageData | null;
  /** Make one, if it is not already there. Cheap to call from a paint loop. */
  request(presetId: string, lut: LutData): void;
  /** Called when a still lands and tiles should repaint. */
  onReady(callback: () => void): () => void;
};

export function createLutPreviewProvider(): LutPreviewProvider {
  const graded = new Map<string, ImageData>();
  const listeners = new Set<() => void>();
  const applier = createCpuLutApplier();

  let sample: ImageData | null = null;
  let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null =
    null;

  const surface = () => {
    if (scratch == null) {
      if (typeof document === "undefined") {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = LUT_PREVIEW_W;
      canvas.height = LUT_PREVIEW_H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx == null) {
        return null;
      }
      scratch = { canvas, ctx };
    }
    return scratch;
  };

  /** The ungraded sample, drawn once. */
  const sampleImage = (): ImageData | null => {
    if (sample != null) {
      return sample;
    }
    const target = surface();
    if (target == null) {
      return null;
    }
    drawSampleImage(target.ctx, LUT_PREVIEW_W, LUT_PREVIEW_H);
    sample = target.ctx.getImageData(0, 0, LUT_PREVIEW_W, LUT_PREVIEW_H);
    return sample;
  };

  return {
    get: (presetId) => graded.get(presetId) ?? null,

    request(presetId, lut) {
      if (graded.has(presetId)) {
        return;
      }
      const target = surface();
      const base = sampleImage();
      if (target == null || base == null) {
        return;
      }
      target.ctx.putImageData(base, 0, 0);
      applier.apply(target, presetId, lut, 1);
      if (graded.size >= MAX_CACHED) {
        // `Map` iterates in insertion order, so this is an LRU without a second
        // structure to keep in step.
        const oldest = graded.keys().next();
        if (!oldest.done) {
          graded.delete(oldest.value);
        }
      }
      graded.set(
        presetId,
        target.ctx.getImageData(0, 0, LUT_PREVIEW_W, LUT_PREVIEW_H),
      );
      for (const listener of listeners) {
        listener();
      }
    },

    onReady(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
