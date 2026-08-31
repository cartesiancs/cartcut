/**
 * The colour operations the shipped LUTs are built out of.
 *
 * Every built-in table is a *formula*, not a magic grid of numbers: a short
 * list of these steps, evaluated at each of a cube's 4,913 nodes by
 * `scripts/generateLuts.ts`. That matters for three reasons.
 *
 *  - **The catalogue is reviewable.** A diff that changes "Nordic Noir" is four
 *    lines of recipe rather than 4,913 lines of floats, and a reviewer can see
 *    what the change *means*.
 *  - **It is regenerable.** `lutCatalogue.test.ts` rebuilds three tables and
 *    compares them to the checked-in files byte for byte, so the files and the
 *    recipes cannot drift apart.
 *  - **It is honest.** Nothing here is traced from someone else's LUT.
 *
 * ## Where each operation happens
 *
 * Some of these belong in **linear light** and some in the **display-referred**
 * signal, and using the wrong space is the difference between a grade that
 * looks like film and one that looks like a filter. Exposure and white balance
 * are physical — they scale light — so they run through `inLinear`. Contrast,
 * curves, lift/gamma/gain and split toning are perceptual and are defined on
 * the coded signal, which is where a colourist's controls act. Each step below
 * says which it is.
 *
 * ## Monotonicity
 *
 * `makeCurve` is a **monotone** cubic (Fritsch–Carlson), not a Catmull-Rom.
 * An ordinary spline overshoots between control points, and an overshoot in a
 * tone curve is a region where increasing the input *decreases* the output —
 * which shows up as a bright ring around highlights and is exactly the artefact
 * people blame LUTs for. `colorMath.test.ts` pins that no shipped curve ever
 * does it.
 *
 * DOM-free and dependency-free, so it runs under `environment: "node"` and from
 * a build script alike.
 */

export type Rgb = [number, number, number];
export type ColorStep = (c: Rgb) => Rgb;

/** Rec.709 luminance weights. */
export const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

export function luma(c: Rgb): number {
  return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed power, so a step never turns a small negative into a NaN. */
function spow(v: number, e: number): number {
  return v <= 0 ? 0 : Math.pow(v, e);
}

// --------------------------------------------------------------- transfer

/** sRGB EOTF. Mirrored below zero so intermediate negatives survive a round trip. */
export function toLinear(v: number): number {
  const a = Math.abs(v);
  const l = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -l : l;
}

/** sRGB inverse EOTF. */
export function toSrgb(v: number): number {
  const a = Math.abs(v);
  const s = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return v < 0 ? -s : s;
}

/**
 * Run a step in linear light.
 *
 * Exposure and white balance are multiplications of *light*, and doing them on
 * the coded signal instead is the classic mistake: a one-stop lift applied to
 * sRGB values brightens the shadows far more than the highlights and looks like
 * a haze rather than like more light.
 */
export function inLinear(step: ColorStep): ColorStep {
  return (c) => {
    const linear = step([toLinear(c[0]), toLinear(c[1]), toLinear(c[2])]);
    return [toSrgb(linear[0]), toSrgb(linear[1]), toSrgb(linear[2])];
  };
}

// ------------------------------------------------------------------- curves

/**
 * A monotone cubic through the given control points.
 *
 * Fritsch–Carlson: tangents are chosen so that the interpolant cannot overshoot
 * between points. Points must be sorted by `x`, and the curve is clamped to the
 * end values outside their range.
 */
export function makeCurve(points: Array<[number, number]>): (x: number) => number {
  const n = points.length;
  if (n < 2) {
    throw new Error("a curve needs at least two points");
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);

  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  const tangents: number[] = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangents[i] =
      slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  }
  // The Fritsch–Carlson limiter: this loop is the whole reason the curve
  // cannot overshoot, and removing it produces a spline that inverts near a
  // sharp control point.
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      tangents[i] = t * a * slopes[i];
      tangents[i + 1] = t * b * slopes[i];
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = n - 2;
    for (let j = 0; j < n - 1; j++) {
      if (x <= xs[j + 1]) {
        i = j;
        break;
      }
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * tangents[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * tangents[i + 1]
    );
  };
}

/** The same tone curve on all three channels. Display-referred. */
export function rgbCurve(points: Array<[number, number]>): ColorStep {
  const f = makeCurve(points);
  return (c) => [f(c[0]), f(c[1]), f(c[2])];
}

/** A separate curve per channel. Display-referred. The cross-process workhorse. */
export function channelCurve(spec: {
  r?: Array<[number, number]>;
  g?: Array<[number, number]>;
  b?: Array<[number, number]>;
}): ColorStep {
  const identity = (x: number) => x;
  const fr = spec.r ? makeCurve(spec.r) : identity;
  const fg = spec.g ? makeCurve(spec.g) : identity;
  const fb = spec.b ? makeCurve(spec.b) : identity;
  return (c) => [fr(c[0]), fg(c[1]), fb(c[2])];
}

// -------------------------------------------------------------------- steps

/** Scale light. Linear. */
export function exposure(stops: number): ColorStep {
  const k = Math.pow(2, stops);
  return inLinear((c) => [c[0] * k, c[1] * k, c[2] * k]);
}

/** Straight-line contrast about a pivot. Display-referred. */
export function contrast(amount: number, pivot = 0.435): ColorStep {
  return (c) => [
    (c[0] - pivot) * amount + pivot,
    (c[1] - pivot) * amount + pivot,
    (c[2] - pivot) * amount + pivot,
  ];
}

/**
 * A symmetric filmic S, blended with identity by `strength`.
 *
 * `x^a / (x^a + (1-x)^a)` — fixed at 0, 1 and 0.5, monotone for every `a >= 1`,
 * and it steepens the midtones while rolling both ends off, which is what a
 * print stock does and what plain `contrast` cannot do without clipping.
 */
export function filmS(strength: number): ColorStep {
  const a = 1 + strength * 1.6;
  const s = (x: number): number => {
    const t = clamp01(x);
    const p = Math.pow(t, a);
    const q = Math.pow(1 - t, a);
    return p + q === 0 ? t : p / (p + q);
  };
  return (c) => [s(c[0]), s(c[1]), s(c[2])];
}

/** Scale distance from luminance. Display-referred. */
export function saturation(s: number): ColorStep {
  return (c) => {
    const l = luma(c);
    return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s];
  };
}

/**
 * How far a colour is from neutral, smoothly.
 *
 * `max - min` is the obvious answer and the wrong one here. It is piecewise
 * linear with creases along the three planes where two channels are equal, and
 * a crease *inside* a LUT cell is error that no amount of grid resolution
 * removes cheaply — measured at four to six 8-bit steps on a 17³ cube, which is
 * enough to contour a gradient. This is the RMS distance from the neutral axis
 * instead: the same quantity for practical purposes, smooth everywhere except
 * at neutral itself, where it is zero and every caller multiplies it away.
 */
export function chroma(c: Rgb): number {
  const dr = c[0] - c[1];
  const dg = c[1] - c[2];
  const db = c[2] - c[0];
  return Math.sqrt((dr * dr + dg * dg + db * db) / 2);
}

/**
 * Saturation that backs off where the pixel is already saturated.
 *
 * The reason "vivid" presets do not turn skin orange: a face sits at a low
 * chroma and gets most of the boost, a red sign is already at the edge of the
 * gamut and gets almost none.
 */
export function vibrance(amount: number): ColorStep {
  return (c) => {
    const l = luma(c);
    const s = 1 + amount * (1 - clamp01(chroma(c)));
    return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s];
  };
}

/** Warm (+) or cool (−). Linear, because white balance is a gain on light. */
export function temperature(t: number): ColorStep {
  return inLinear((c) => [
    c[0] * (1 + 0.34 * t),
    c[1] * (1 + 0.02 * t),
    c[2] * (1 - 0.3 * t),
  ]);
}

/** Magenta (+) or green (−). Linear. */
export function tint(t: number): ColorStep {
  return inLinear((c) => [
    c[0] * (1 + 0.13 * t),
    c[1] * (1 - 0.2 * t),
    c[2] * (1 + 0.13 * t),
  ]);
}

/**
 * Lift, gamma and gain, the three colour wheels.
 *
 * Lift raises the black point without moving white, gain scales white without
 * moving black, gamma bends between them — which is why they are the controls
 * every grading panel has and why they are worth having as one step rather than
 * three.
 */
export function liftGammaGain(lift: Rgb, gamma: Rgb, gain: Rgb): ColorStep {
  return (c) =>
    [0, 1, 2].map((i) => {
      const lifted = lift[i] + c[i] * (1 - lift[i]);
      return spow(lifted * gain[i], 1 / gamma[i]);
    }) as Rgb;
}

/** ASC CDL: `(x * slope + offset) ^ power`. The interchange standard. */
export function asc(slope: Rgb, offset: Rgb, power: Rgb): ColorStep {
  return (c) =>
    [0, 1, 2].map((i) => spow(c[i] * slope[i] + offset[i], power[i])) as Rgb;
}

/** A 3×3, row-major. Linear unless a recipe says otherwise. */
export function matrix3(m: number[]): ColorStep {
  return (c) => [
    m[0] * c[0] + m[1] * c[1] + m[2] * c[2],
    m[3] * c[0] + m[4] * c[1] + m[5] * c[2],
    m[6] * c[0] + m[7] * c[1] + m[8] * c[2],
  ];
}

/** Rotate hue about the neutral axis, in degrees. */
export function hueRotate(degrees: number): ColorStep {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const k = 1 / 3;
  const s = Math.sqrt(1 / 3);
  return matrix3([
    cos + (1 - cos) * k,
    k * (1 - cos) - s * sin,
    k * (1 - cos) + s * sin,
    k * (1 - cos) + s * sin,
    cos + k * (1 - cos),
    k * (1 - cos) - s * sin,
    k * (1 - cos) - s * sin,
    k * (1 - cos) + s * sin,
    cos + k * (1 - cos),
  ]);
}

/**
 * Tint the shadows one way and the highlights the other.
 *
 * The single most recognisable move in colour grading — teal shadows and warm
 * highlights is most of what people mean by "cinematic" — and it keys on
 * *brightness*, which is what distinguishes it from a hue rotation.
 */
export function splitTone(
  shadow: Rgb,
  highlight: Rgb,
  strength: number,
  balance = 0.5,
): ColorStep {
  return (c) => {
    const l = luma(c);
    const low = 1 - smoothstep(0, balance + 0.15, l);
    const high = smoothstep(balance - 0.15, 1, l);
    return [0, 1, 2].map(
      (i) =>
        c[i] +
        strength * (low * (shadow[i] - 0.5) + high * (highlight[i] - 0.5)),
    ) as Rgb;
  };
}

/** Raise the black point toward a colour — the matte / faded-film look. */
export function matte(amount: number, color: Rgb = [0.5, 0.5, 0.5]): ColorStep {
  return (c) =>
    [0, 1, 2].map((i) => {
      const black = amount * color[i];
      return black + c[i] * (1 - black);
    }) as Rgb;
}

/** Pull the white point down, so nothing reaches full brightness. */
export function softWhites(amount: number): ColorStep {
  return (c) => [c[0] * (1 - amount), c[1] * (1 - amount), c[2] * (1 - amount)];
}

/**
 * Monochrome by weighted mix, optionally toned.
 *
 * The weights are the black-and-white photographer's colour filter: heavy on
 * red darkens a blue sky, heavy on green lightens foliage. `tone` multiplies
 * the result and is normalised against its own luminance so it colours the
 * image without also changing its brightness.
 */
export function monoMix(weights: Rgb, tone?: Rgb): ColorStep {
  const total = weights[0] + weights[1] + weights[2];
  const w: Rgb = [weights[0] / total, weights[1] / total, weights[2] / total];
  let tint: Rgb = [1, 1, 1];
  if (tone != null) {
    const t = luma(tone);
    tint = t === 0 ? [1, 1, 1] : [tone[0] / t, tone[1] / t, tone[2] / t];
  }
  return (c) => {
    const l = c[0] * w[0] + c[1] * w[1] + c[2] * w[2];
    return [l * tint[0], l * tint[1], l * tint[2]];
  };
}

function overlayChannel(base: number, blend: number): number {
  return base < 0.5 ? 2 * base * blend : 1 - 2 * (1 - base) * (1 - blend);
}

/**
 * Bleach bypass: the print's own luminance, overlaid on itself.
 *
 * Silver retained in the print raises contrast and drops saturation together,
 * which no combination of a contrast control and a saturation control
 * reproduces — the two are coupled.
 */
export function bleachBypass(amount: number): ColorStep {
  return (c) => {
    const l = luma(c);
    return [0, 1, 2].map(
      (i) => c[i] * (1 - amount) + overlayChannel(c[i], l) * amount,
    ) as Rgb;
  };
}

// ------------------------------------------------------------------- HSL

export function rgbToHsl(c: Rgb): Rgb {
  const max = Math.max(...c);
  const min = Math.min(...c);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === c[0]) {
    h = ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) / 6;
  } else if (max === c[1]) {
    h = ((c[2] - c[0]) / d + 2) / 6;
  } else {
    h = ((c[0] - c[1]) / d + 4) / 6;
  }
  return [h, s, l];
}

function hueChannel(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

export function hslToRgb(hsl: Rgb): Rgb {
  const [h, s, l] = hsl;
  if (s === 0) {
    return [l, l, l];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueChannel(p, q, h + 1 / 3),
    hueChannel(p, q, h),
    hueChannel(p, q, h - 1 / 3),
  ];
}

/**
 * Adjust one band of hues and leave the rest alone.
 *
 * The hue-vs-hue and hue-vs-sat curves, as one step. What "protect skin" means
 * in practice: name the orange band and scale it back while everything else
 * takes the grade.
 *
 * `center` and `width` are in degrees, and the weight falls smoothly from one
 * at the centre to zero at `width` — with **no plateau**. A band that held full
 * strength across its middle and then ramped would be a much stronger effect
 * for the same numbers, and it would also be a much rougher function: a 17-node
 * cube cannot follow a ramp that steep, so the shipped table would reconstruct
 * it with an error of several 8-bit steps and gradients through the band would
 * show contours. `lutCatalogue.test.ts` measures exactly that, which is how the
 * plateau came to be removed.
 */
export function hueBand(options: {
  center: number;
  width: number;
  satScale?: number;
  hueShift?: number;
  lumScale?: number;
}): ColorStep {
  const { center, width, satScale = 1, hueShift = 0, lumScale = 1 } = options;
  return (c) => {
    const ch = chroma(c);
    if (ch <= 1e-6) {
      // Neutral has no hue to be in a band. Returning early also keeps the
      // function continuous through the achromatic axis, where `rgbToHsl`'s
      // hue is undefined and would otherwise snap to zero.
      return c;
    }
    const hue = rgbToHsl([clamp01(c[0]), clamp01(c[1]), clamp01(c[2])])[0] * 360;
    let delta = Math.abs(hue - center);
    if (delta > 180) {
      delta = 360 - delta;
    }
    // Falls from one at the centre to zero at `width`, with no plateau. A band
    // that held full strength across its middle and then ramped would be a much
    // rougher function, and a 17-node cube cannot follow a ramp that steep —
    // the shipped table would reconstruct it several 8-bit steps out and
    // gradients through the band would contour.
    let weight = 1 - smoothstep(0, width, delta);
    // Fade the band out as the colour approaches neutral, so the hue's own
    // discontinuity at the achromatic axis is multiplied by nothing.
    weight *= smoothstep(0, 0.08, ch);
    if (weight <= 0) {
      return c;
    }

    const l = luma(c);
    // The adjustments are applied to RGB directly rather than by writing back
    // through HSL. An HSL round trip re-derives saturation and lightness from
    // `max` and `min`, which puts creases into the result along the planes
    // where two channels are equal — the very thing `chroma` above exists to
    // avoid.
    const s = 1 + (satScale - 1) * weight;
    let out: Rgb = [
      l + (c[0] - l) * s,
      l + (c[1] - l) * s,
      l + (c[2] - l) * s,
    ];
    if (hueShift !== 0) {
      out = hueRotate(hueShift * weight)(out);
    }
    if (lumScale !== 1) {
      const k = 1 + (lumScale - 1) * weight;
      out = [out[0] * k, out[1] * k, out[2] * k];
    }
    return out;
  };
}

// ------------------------------------------------------- camera log decodes

/**
 * Camera log curves, as published by their manufacturers.
 *
 * Each returns **scene linear** from the coded log signal. These are the
 * transfer functions only; see `recipes.ts` for what the `log-convert` presets
 * do and do not claim.
 */
export const logDecode = {
  /** Sony S-Log3. */
  slog3: (x: number): number =>
    x >= 171.2102946929 / 1023
      ? (Math.pow(10, (x * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01)
      : ((x * 1023 - 95) * 0.01125) / (171.2102946929 - 95),

  /** ARRI LogC3, EI 800. */
  logc3: (x: number): number => {
    const cut = 0.010591;
    const a = 5.555556;
    const b = 0.052272;
    const c = 0.24719;
    const d = 0.385537;
    const e = 5.367655;
    const f = 0.092809;
    return x > e * cut + f
      ? (Math.pow(10, (x - d) / c) - b) / a
      : (x - f) / e;
  },

  /** Panasonic V-Log. */
  vlog: (x: number): number => {
    const cut = 0.181;
    const b = 0.00873;
    const c = 0.241514;
    const d = 0.598206;
    return x < cut ? (x - 0.125) / 5.6 : Math.pow(10, (x - d) / c) - b;
  },

  /**
   * Canon C-Log3.
   *
   * The inverse of Canon's published three-part encoding. Worth writing out,
   * because the three branches share constants in a way that makes them easy to
   * transpose — and a transposed constant produces a curve that *drops* at one
   * of the joins, which reads as crushed shadows rather than as an error:
   *
   *     x <= -0.014 : y = -0.36726845 * log10(1 - 14.98325x) + 0.12783901
   *     |x| < 0.014 : y = 1.9754798x + 0.12512219
   *     x >  0.014  : y = 0.36726845 * log10(14.98325x + 1) + 0.12240537
   *
   * The joins land at y = 0.09746547 and y = 0.15277891, and
   * `colorMath.test.ts` checks the curve is monotone straight through both.
   */
  clog3: (x: number): number => {
    if (x < 0.09746547) {
      return (1 - Math.pow(10, (0.12783901 - x) / 0.36726845)) / 14.98325;
    }
    if (x <= 0.15277891) {
      return (x - 0.12512219) / 1.9754798;
    }
    return (Math.pow(10, (x - 0.12240537) / 0.36726845) - 1) / 14.98325;
  },

  /** DJI D-Log. */
  dlog: (x: number): number =>
    x <= 0.14
      ? (x - 0.0929) / 6.025
      : (Math.pow(10, 3.89616 * x - 2.27752) - 0.0108) / 0.9892,

  /** BT.2100 HLG, to scene linear normalised so 1.0 is peak. */
  hlg: (x: number): number => {
    const a = 0.17883277;
    const b = 1 - 4 * a;
    const c = 0.5 - a * Math.log(4 * a);
    return x <= 0.5
      ? (x * x) / 3
      : (Math.exp((x - c) / a) + b) / 12;
  },
} as const;

/** BT.709 opto-electronic transfer function: scene linear to a coded signal. */
export function rec709Oetf(v: number): number {
  const a = Math.max(0, v);
  return a < 0.018 ? 4.5 * a : 1.099 * Math.pow(a, 0.45) - 0.099;
}

/**
 * A camera log signal to a viewable Rec.709 picture.
 *
 * Decode to scene linear, normalise so that 18% grey lands where Rec.709
 * expects it, and encode. `exposureStops` is the one dial: log formats disagree
 * about how much headroom they keep above grey, and this is what lines them up.
 */
export function logToRec709(
  decode: (x: number) => number,
  exposureStops = 0,
): ColorStep {
  const gain = Math.pow(2, exposureStops);
  const f = (x: number): number => rec709Oetf(decode(clamp01(x)) * gain);
  return (c) => [f(c[0]), f(c[1]), f(c[2])];
}

// ------------------------------------------------------------------ running

/** Apply every step in order and clamp once, at the end. */
export function runSteps(steps: readonly ColorStep[], input: Rgb): Rgb {
  let c = input;
  for (const step of steps) {
    c = step(c);
  }
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}
