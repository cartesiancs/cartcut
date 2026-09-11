/**
 * The finishing adjustments — clarity, sharpen, fade, vignette and particles —
 * as plain arithmetic.
 *
 * This is the **oracle**. The CPU applier (`renderer/adjust/cpu.ts`) is built
 * from these functions, and the GLSL (`renderer/adjust/glsl.ts`) is generated
 * from the constants exported here and restates the same formulas, so a
 * constant cannot drift between the two. The end-to-end suite compares the
 * shipped shader with this file on real pixels.
 *
 * Every function takes and returns **straight** colour in 0-1 and never
 * touches alpha. Coverage is not a colour property, and the layer these run
 * on holds straight colour on both paths (`lut/glsl.ts` explains why).
 *
 * DOM-free, so it runs under `environment: "node"`.
 */

import { LUMA, type Rgb } from "../lut/colorMath";
import {
  CLARITY_RADIUS_FRACTION,
  FADE_BLACK,
  FADE_DESATURATE,
  FADE_WHITE,
  VIGNETTE_INNER,
  VIGNETTE_OUTER,
  VIGNETTE_STRENGTH,
} from "./spec";

export function luma(c: Rgb): number {
  return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function fract(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------- weights

/**
 * How much a tone is "midtone", 0 at black and white and 1 at mid grey.
 *
 * Clarity is local contrast *in the midtones*. Pushed at the ends it clips —
 * a black edge made blacker is still black, and the overshoot shows as a halo.
 */
export function midtoneWeight(l: number): number {
  const d = 2 * clamp01(l) - 1;
  return 1 - d * d;
}

/**
 * Where grain lives: none in clipped white or solid black, most at mid grey.
 * The `film-grain` effect preset's rule, restated.
 */
export function grainWeight(l: number): number {
  return 1 - Math.abs(2 * clamp01(l) - 1);
}

// ------------------------------------------------------------------ kernels

/** One tap of a separable blur: an offset in tap units and its weight. */
export type Tap = { offset: number; weight: number };

/**
 * Nine taps of a Gaussian, σ = 2 taps, normalised to sum to one.
 *
 * Clarity's blur. The tap *spacing* is what scales with the clip, so the
 * number of texture reads stays fixed however big the radius gets.
 */
export const BLUR_TAPS: readonly Tap[] = (() => {
  const sigma = 2;
  const raw = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((offset) => ({
    offset,
    weight: Math.exp(-(offset * offset) / (2 * sigma * sigma)),
  }));
  const total = raw.reduce((sum, tap) => sum + tap.weight, 0);
  return raw.map((tap) => ({ offset: tap.offset, weight: tap.weight / total }));
})();

/**
 * A 3×3 tent, the smallest kernel with no directional bias. Sharpen's blur,
 * the same one the Sharpen effect preset uses. Row-major, dx then dy.
 */
export const TENT_3X3: readonly { dx: number; dy: number; weight: number }[] = [
  { dx: -1, dy: -1, weight: 0.0625 },
  { dx: 0, dy: -1, weight: 0.125 },
  { dx: 1, dy: -1, weight: 0.0625 },
  { dx: -1, dy: 0, weight: 0.125 },
  { dx: 0, dy: 0, weight: 0.25 },
  { dx: 1, dy: 0, weight: 0.125 },
  { dx: -1, dy: 1, weight: 0.0625 },
  { dx: 0, dy: 1, weight: 0.125 },
  { dx: 1, dy: 1, weight: 0.0625 },
];

/**
 * Clarity's blur radius in device pixels.
 *
 * A fraction of the clip's *shorter side*, measured in device pixels — so it
 * is the same share of the picture at any zoom, in the preview and in the
 * export alike. A radius in layer pixels would make clarity stronger the
 * further the user zoomed out.
 */
export function clarityRadiusDevice(
  boxWidth: number,
  boxHeight: number,
  scale: number,
): number {
  return Math.max(0, Math.min(boxWidth, boxHeight) * scale * CLARITY_RADIUS_FRACTION);
}

/** Tap spacing for a blur of that radius: the outermost tap sits on it. */
export function blurStepFor(radiusDevice: number): number {
  return radiusDevice / 4;
}

// ------------------------------------------------------------------- stages

/**
 * Add local contrast: push each pixel away from its neighbourhood's luma.
 *
 * One delta added to all three channels, so clarity changes contrast and not
 * hue. `amount` is 0-1 of `CLARITY_STRENGTH`, pre-multiplied by the caller.
 */
export function clarityPixel(c: Rgb, blurredLuma: number, strength: number): Rgb {
  const l = luma(c);
  const delta = (l - blurredLuma) * strength * midtoneWeight(l);
  return [c[0] + delta, c[1] + delta, c[2] + delta];
}

/** An unsharp mask: the colour plus its difference from its blurred self. */
export function sharpenPixel(c: Rgb, blurred: Rgb, strength: number): Rgb {
  return [
    c[0] + (c[0] - blurred[0]) * strength,
    c[1] + (c[1] - blurred[1]) * strength,
    c[2] + (c[2] - blurred[2]) * strength,
  ];
}

/**
 * The faded-film look: lift black, pull white down, take some colour out.
 *
 * Monotone for every amount in 0-1, because the scale `1 - black - white` is
 * always positive; `finishMath.test.ts` pins that.
 */
export function fadePixel(c: Rgb, amount: number): Rgb {
  if (amount <= 0) {
    return c;
  }
  const black = FADE_BLACK * amount;
  const scale = 1 - black - FADE_WHITE * amount;
  const lifted: Rgb = [
    black + c[0] * scale,
    black + c[1] * scale,
    black + c[2] * scale,
  ];
  const l = luma(lifted);
  const keep = 1 - FADE_DESATURATE * amount;
  return [
    l + (lifted[0] - l) * keep,
    l + (lifted[1] - l) * keep,
    l + (lifted[2] - l) * keep,
  ];
}

/**
 * How much of the vignette reaches a point, 0 in the middle and 1 at the
 * corners.
 *
 * `u`, `v` are the point's position *in the clip*, 0-1 across its box. Each
 * axis is normalised by its own side, so the falloff is an ellipse with the
 * clip's aspect — the look of a lens vignette on that frame, and the one
 * Lightroom and CapCut draw. A corner sits at radius 1.
 */
export function vignetteWeight(u: number, v: number): number {
  const x = (u - 0.5) * 2;
  const y = (v - 0.5) * 2;
  const r = Math.sqrt((x * x + y * y) / 2);
  return smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, r);
}

/**
 * Darken (positive `amount`) or lighten (negative) by the vignette's weight.
 *
 * Darkening scales toward black and lightening mixes toward white, so both are
 * monotone in the colour and neither can overshoot.
 */
export function vignettePixel(c: Rgb, weight: number, amount: number): Rgb {
  const k = weight * Math.abs(amount) * VIGNETTE_STRENGTH;
  if (k === 0) {
    return c;
  }
  if (amount > 0) {
    return [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)];
  }
  return [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];
}

/**
 * Dave Hoskins' "hash without sine", 0 ≤ h < 1.
 *
 * Chosen over the usual `fract(sin(x) * 43758.5)` because GPUs disagree about
 * `sin` at large arguments — the classic hash differs between vendors, so the
 * grain pattern in the preview would not be the one in the render. This one is
 * multiplies, adds and `fract` only. Inputs are kept small (cell indices plus
 * an offset under 512) so float32 on the GPU has the precision to follow.
 */
export function hash12(x: number, y: number): number {
  let p0 = fract(x * 0.1031);
  let p1 = fract(y * 0.1031);
  let p2 = fract(x * 0.1031);
  const d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
  p0 += d;
  p1 += d;
  p2 += d;
  return fract((p0 + p1) * p2);
}

/**
 * The per-frame offset that re-rolls the grain.
 *
 * Derived from the cursor *on the CPU* and handed to both appliers as a
 * uniform, so the two start from the same two numbers. The cursor is rounded
 * to a millisecond: the preview and the export reach a frame from different
 * directions but land on the same instant, and adjacent frames at 240fps are
 * still four milliseconds apart.
 */
export function grainOffsetFor(timelineCursor: number): [number, number] {
  const n = Math.round(timelineCursor);
  return [fract(n * 0.6180339887) * 512, fract(n * 0.3819660113 + 0.5) * 512];
}

/** Monochrome grain, added to all three channels, weighted to the midtones. */
export function grainPixel(c: Rgb, noise: number, strength: number): Rgb {
  const delta = (noise - 0.5) * strength * grainWeight(luma(c));
  return [c[0] + delta, c[1] + delta, c[2] + delta];
}

// -------------------------------------------------------------- the sequence

/** Each stage's strength, already scaled from its slider. Zero skips the stage. */
export type FinishAmounts = {
  /** `CLARITY_STRENGTH × v/100`. */
  clarity: number;
  /** `SHARPEN_STRENGTH × v/100`. */
  sharpen: number;
  /** `PARTICLES_STRENGTH × v/100`. */
  particles: number;
  /** 0-1. */
  fade: number;
  /** −1..1; positive darkens the edges. */
  vignette: number;
};

/** What a pixel's neighbourhood and position contribute, gathered by the caller. */
export type FinishInputs = {
  /** Clarity's alpha-weighted blurred luma. Read only when `clarity > 0`. */
  blurredLuma: number;
  /** Sharpen's alpha-weighted blurred colour. Read only when `sharpen > 0`. */
  blurredRgb: Rgb;
  /** The pixel's position in the clip, 0-1 across its box. */
  u: number;
  v: number;
  /** `hash12` of the pixel's grain cell. Read only when `particles > 0`. */
  noise: number;
};

/**
 * The whole finish, in order: clarity, sharpen, fade, vignette, particles.
 *
 * **The order is part of the definition**, and the GLSL states it in the same
 * order. Local contrast and sharpening first, on the picture as graded; then
 * fade, which is a look and must see the sharpened tones; then the vignette,
 * which a lens puts on top of everything; then grain, last, because real grain
 * sits over the vignette rather than being darkened by it.
 *
 * Sharpen's delta is measured on the *source* — the clip as it arrived — and
 * added after clarity, so the two do not compound into a halo twice as wide.
 * The clamp happens once, at the end.
 */
export function finishPixel(
  src: Rgb,
  inputs: FinishInputs,
  amounts: FinishAmounts,
): Rgb {
  let c: Rgb = src;
  if (amounts.clarity > 0) {
    c = clarityPixel(c, inputs.blurredLuma, amounts.clarity);
  }
  if (amounts.sharpen > 0) {
    const b = inputs.blurredRgb;
    c = [
      c[0] + (src[0] - b[0]) * amounts.sharpen,
      c[1] + (src[1] - b[1]) * amounts.sharpen,
      c[2] + (src[2] - b[2]) * amounts.sharpen,
    ];
  }
  if (amounts.fade > 0) {
    c = fadePixel(c, amounts.fade);
  }
  if (amounts.vignette !== 0) {
    c = vignettePixel(c, vignetteWeight(inputs.u, inputs.v), amounts.vignette);
  }
  if (amounts.particles > 0) {
    c = grainPixel(c, inputs.noise, amounts.particles);
  }
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}
