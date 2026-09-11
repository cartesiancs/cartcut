/**
 * The colour and lightness adjustments, as one pure function of a pixel.
 *
 * Every control here depends on nothing but the pixel's own colour, which is
 * what lets `bake.ts` evaluate the whole chain at the nodes of a cube and hand
 * the result to the clip-LUT applier. Nothing in this file knows it is being
 * baked: it is the definition, and the baked table is a sampling of it that
 * `bake.test.ts` holds to within one 8-bit step.
 *
 * ## Order is the definition
 *
 *   1. **Light** — temperature, tint and exposure, as gains on light. Applying
 *      them to the coded signal directly tints the shadows far more than the
 *      highlights. They go through a pure 2.2 power (`spec.ts#DISPLAY_GAMMA`
 *      says why not piecewise sRGB), under which all three fold into a single
 *      per-channel multiplication.
 *   2. **Contrast** about mid grey. Positive is a filmic S that rolls both ends
 *      off rather than clipping them; negative flattens toward grey.
 *   3. **The tone curve** — highlights, shadows, whites, blacks and brilliance
 *      are five handles on *one* monotone curve, never five curves in a row.
 *      Composing five curves lets two of them fight; one curve with a minimum
 *      rise between its points cannot invert however they are combined.
 *   4. **Saturation**, then brilliance's small vibrance.
 *
 * That is the Lightroom and Lumetri order: fix the white point and the
 * exposure first, shape the tones, then set how much colour there is.
 *
 * The highlight and shadow controls are *global* — a curve, not the
 * edge-aware local tone mapping Lightroom uses. That is a deliberate trade: a
 * global curve is exactly bakeable, so the preview and the export are
 * structurally the same picture, and a local operator would have to be
 * restated on the GPU and the CPU and kept in agreement by hand.
 *
 * Built from `lut/colorMath.ts`'s steps where they fit, which are **reused,
 * never edited** — the shipped LUTs are generated from them and
 * `lutCatalogue.test.ts` compares those files byte for byte.
 */

import type { ColorAdjustmentKey, ColorAdjustments } from "../../@types/timeline";
import {
  type ColorStep,
  type Rgb,
  contrast,
  filmS,
  makeCurve,
  runSteps,
  saturation,
  vibrance,
} from "../lut/colorMath";
import {
  BRILLIANCE_VIBRANCE,
  CONTRAST_FLATTEN,
  CONTRAST_PIVOT,
  CONTRAST_S_STRENGTH,
  DISPLAY_GAMMA,
  EXPOSURE_STOPS,
  SATURATION_SCALE,
  TEMPERATURE_GAINS,
  TINT_GAINS,
  TONE_CURVE_MIN_RISE,
  TONE_CURVE_WEIGHTS,
  TONE_CURVE_X,
  TONE_KEYS,
  WHITE_BALANCE_SCALE,
} from "./spec";

function unit(values: ColorAdjustments, key: ColorAdjustmentKey): number {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v / 100 : 0;
}

/** Whether none of the tone controls would change anything. */
export function isToneNeutral(values: ColorAdjustments): boolean {
  return TONE_KEYS.every((key) => unit(values, key) === 0);
}

/**
 * The gain on light each channel receives from temperature, tint and exposure
 * together, or `null` when all three are at zero.
 *
 * Exported so the tests can state white balance and exposure in terms of
 * light rather than of the coded signal.
 */
export function lightGains(values: ColorAdjustments): Rgb | null {
  const t = unit(values, "temperature") * WHITE_BALANCE_SCALE;
  const g = unit(values, "tint") * WHITE_BALANCE_SCALE;
  const e = unit(values, "exposure");
  if (t === 0 && g === 0 && e === 0) {
    return null;
  }
  const exposureGain = Math.pow(2, e * EXPOSURE_STOPS);
  return [0, 1, 2].map(
    // A floor well above zero: at −100 temperature blue is 0.7, and no
    // combination on these ranges reaches it, but a gain of zero or below
    // would be a channel erased rather than a white balance.
    (i) =>
      Math.max(0.05, 1 + TEMPERATURE_GAINS[i] * t) *
      Math.max(0.05, 1 + TINT_GAINS[i] * g) *
      exposureGain,
  ) as Rgb;
}

/**
 * The tone curve's control points, or `null` when every handle is at zero.
 *
 * Exported so the tests can check the minimum-rise rule directly rather than
 * only through its consequences.
 */
export function toneCurvePoints(
  values: ColorAdjustments,
): Array<[number, number]> | null {
  const handles = Object.keys(TONE_CURVE_WEIGHTS) as Array<
    keyof typeof TONE_CURVE_WEIGHTS
  >;
  if (handles.every((key) => unit(values, key) === 0)) {
    return null;
  }

  const ys = TONE_CURVE_X.map((x, i) => {
    let y: number = x;
    for (const key of handles) {
      y += TONE_CURVE_WEIGHTS[key][i] * unit(values, key);
    }
    return y;
  });
  // A falling segment is a tonal inversion. Force every point above the last.
  for (let i = 1; i < ys.length; i++) {
    ys[i] = Math.max(ys[i], ys[i - 1] + TONE_CURVE_MIN_RISE);
  }
  return TONE_CURVE_X.map((x, i) => [x, ys[i]]);
}

/**
 * The steps, in order. Controls at zero contribute no step at all.
 *
 * Omitting a neutral step rather than running it as an identity is what makes
 * "every slider at zero" *exactly* the identity — `runSteps` over an empty list
 * is a clamp and nothing else — instead of an identity up to floating-point
 * noise.
 */
export function toneSteps(values: ColorAdjustments): ColorStep[] {
  const steps: ColorStep[] = [];

  const gains = lightGains(values);
  if (gains != null) {
    // A gain `g` on light, through a pure power law, is a gain of `g^(1/γ)`
    // on the signal: `((x^γ)·g)^(1/γ) = x·g^(1/γ)`. Written in that closed
    // form, so the step is exactly linear and bakes without error.
    const k = gains.map((g) => Math.pow(g, 1 / DISPLAY_GAMMA)) as Rgb;
    steps.push((c) => [c[0] * k[0], c[1] * k[1], c[2] * k[2]]);
  }

  const c = unit(values, "contrast");
  if (c > 0) {
    steps.push(filmS(c * CONTRAST_S_STRENGTH));
  } else if (c < 0) {
    steps.push(contrast(1 + c * CONTRAST_FLATTEN, CONTRAST_PIVOT));
  }

  const points = toneCurvePoints(values);
  if (points != null) {
    const curve = extrapolatingCurve(points);
    steps.push((rgb) => [curve(rgb[0]), curve(rgb[1]), curve(rgb[2])]);
  }

  const s = unit(values, "saturation");
  if (s !== 0) steps.push(saturation(1 + s * SATURATION_SCALE));

  const b = unit(values, "brilliance");
  if (b !== 0) steps.push(vibrance(b * BRILLIANCE_VIBRANCE));

  return steps;
}

/** The whole tone adjustment as one function, clamped to 0-1 on the way out. */
export function toneStep(values: ColorAdjustments): (c: Rgb) => Rgb {
  const steps = toneSteps(values);
  return (c) => runSteps(steps, c);
}

/**
 * The same chain **without** the final clamp — what `bake.ts` samples.
 *
 * The clamp is a crease: exposure pushing a channel through 1.0, saturation
 * pushing one below 0. A crease inside a cube cell is error no interpolation
 * can remove, and it does not shrink usefully with the table. Baking the
 * unclamped function moves the clamp to *after* the lookup, which is where
 * both appliers already put it (`lutApplyStraight` and the CPU applier's
 * `toByte`) and where `toneStep` puts it. `LutData` stores out-of-range values
 * on purpose, for HDR tables, so nothing new is being asked of the atlas.
 */
export function toneStepUnclamped(values: ColorAdjustments): (c: Rgb) => Rgb {
  const steps = toneSteps(values);
  return (c) => {
    let out = c;
    for (const step of steps) {
      out = step(out);
    }
    return out;
  };
}

/**
 * `makeCurve`, continued as a straight line past both ends.
 *
 * `makeCurve` holds its end values outside its range, which is a flat line
 * meeting the curve at an angle — the same crease the final clamp was, now
 * *inside* the chain where no later clamp can hide it, for any input exposure
 * or white balance has pushed past 0-1. Continuing along the end slope keeps
 * the curve's value and its slope at the ends, so a bright channel entering
 * the curve at 1.1 leaves it just above where 1.0 did, and the clamp that
 * matters happens once, last.
 */
function extrapolatingCurve(points: Array<[number, number]>): (x: number) => number {
  const curve = makeCurve(points);
  const [x0, y0] = points[0];
  const [x1, y1] = points[points.length - 1];
  const h = 1e-4;
  const startSlope = (curve(x0 + h) - y0) / h;
  const endSlope = (y1 - curve(x1 - h)) / h;
  return (x) => {
    if (x < x0) return y0 + (x - x0) * startSlope;
    if (x > x1) return y1 + (x - x1) * endSlope;
    return curve(x);
  };
}
