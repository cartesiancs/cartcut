/**
 * The colour and lightness adjustments, baked into a 3D LUT.
 *
 * Every tone control is a pure function of the pixel's colour (`tone.ts`), so
 * evaluating that function at the nodes of a cube captures it completely, and
 * the clip-LUT applier already knows how to apply a cube on the GPU and the
 * CPU alike. That buys three things no new shader could:
 *
 *  - **Verification for free.** The LUT shader is pinned to ffmpeg's own
 *    `lut3d` (`lut/ffmpegParity.test.ts`, `tests/e2e/specs/lut.spec.ts`). What
 *    is left to prove is that the baked table matches `toneStep`, which is a
 *    node test (`bake.test.ts`).
 *  - **Preview/export parity by construction** — the same table, the same
 *    applier, the same half-float atlas.
 *  - **A fixed cost** per frame, one lookup per pixel, however many sliders
 *    are moved.
 *
 * Baking happens when a setting changes and not per frame; the result is cached
 * by `toneKey`, which names the settings exactly. Values are static — there are
 * no adjustment keyframes — so playback never re-bakes.
 */

import type { ColorAdjustments } from "../../@types/timeline";
import { BoundedCache } from "../renderer/lut/boundedCache";
import { type Lut3d, identityLut3d, nodeOffset } from "../lut/lutData";
import { TONE_KEYS } from "./spec";
import { isToneNeutral, toneStepUnclamped } from "./tone";

/**
 * Nodes per axis. 33 is the size Resolve and most cameras export, and
 * `bake.test.ts` holds it to within one 8-bit step of the direct evaluation
 * across every slider at both ends of its travel.
 */
export const TONE_LUT_SIZE = 33;

/**
 * A key that names the tone settings exactly, or `null` when they are neutral.
 *
 * Order-independent and blind to the effects group, so moving a sharpen slider
 * does not re-bake the tone table.
 */
export function toneKey(values: ColorAdjustments): string | null {
  if (isToneNeutral(values)) {
    return null;
  }
  const parts: string[] = [];
  for (const key of TONE_KEYS) {
    const v = values[key];
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) {
      parts.push(`${key}=${v}`);
    }
  }
  return `adjust:${parts.join(";")}`;
}

/**
 * Evaluate the tone adjustment at every node of a cube.
 *
 * The **unclamped** chain: node values may sit outside 0-1, and the clamp is
 * left to the applier, after interpolation. `tone.ts#toneStepUnclamped` says
 * why, with the measurements.
 */
export function bakeToneLut(
  values: ColorAdjustments,
  size: number = TONE_LUT_SIZE,
): Lut3d {
  const lut = identityLut3d(size);
  const step = toneStepUnclamped(values);
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const out = step([r / last, g / last, b / last]);
        lut.data[at] = out[0];
        lut.data[at + 1] = out[1];
        lut.data[at + 2] = out[2];
      }
    }
  }
  return lut;
}

/**
 * Baked tables, by key.
 *
 * Sixteen is several clips' worth of distinct settings plus the few a slider
 * drag passes through while the previous one is still on screen.
 */
const TONE_CACHE_SIZE = 16;
const cache = new BoundedCache<string, Lut3d>(TONE_CACHE_SIZE);

/** The baked tone table for these settings, or `null` when they are neutral. */
export function toneLutFor(
  values: ColorAdjustments,
): { key: string; lut: Lut3d } | null {
  const key = toneKey(values);
  if (key == null) {
    return null;
  }
  let lut = cache.get(key);
  if (lut == null) {
    lut = bakeToneLut(values);
    cache.set(key, lut);
  }
  return { key, lut };
}

/** Test-only: forget every baked table. */
export function clearToneLutCache(): void {
  cache.clear();
}
