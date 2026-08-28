/**
 * Deciding whether two frames are the same frame.
 *
 * Every threshold here is calibrated against a measured floor rather than
 * guessed, because the floor is not zero: the export writes full-range RGBA
 * into a 4:2:0 H.264 and the decode comes back through the same conversion, and
 * that round trip alone costs a mean absolute error of about 1.07 with a p99 of
 * 4 and a *maximum* of 115. A threshold that ignores that is either permanently
 * red or blind.
 *
 * Metrics are computed per region, never over a whole frame. The instrument
 * bands are deliberately pathological — pure black and white patches, a
 * high-frequency scrolling pattern — and folding them into a fidelity average
 * would swamp the content they sit beside.
 */

import type { CodeRegion, Region, SwatchRegion } from "./paths";
// The canary colours live with the generator's geometry so the values checked
// here and the values drawn into the fixture are the same list.
import { SWATCH_COLORS } from "../scenario/carriers";

export type Rgba = { r: number; g: number; b: number; a: number };

/** A frame as RGBA bytes plus the geometry needed to index into it. */
export type FrameBuffer = {
  data: Buffer | Uint8ClampedArray;
  width: number;
  height: number;
};

function at(frame: FrameBuffer, x: number, y: number): number {
  return (y * frame.width + x) * 4;
}

export function pixel(frame: FrameBuffer, x: number, y: number): Rgba {
  const i = at(frame, x, y);
  return { r: frame.data[i], g: frame.data[i + 1], b: frame.data[i + 2], a: frame.data[i + 3] };
}

// ------------------------------------------------------------------ metrics

export type DiffStats = {
  /** Mean absolute difference over R, G and B. Alpha is excluded. */
  mean: number;
  p50: number;
  p99: number;
  p999: number;
  /** Fraction of channel samples differing by more than 24. */
  fracOver24: number;
  /** Recorded, never asserted — a correct round trip reaches 115. */
  max: number;
  samples: number;
};

/**
 * Per-channel difference statistics over a region.
 *
 * Percentiles come from a 256-bin histogram rather than a sort: the difference
 * of two bytes is already an integer in [0, 255], so the histogram is exact and
 * costs one pass with no allocation. At 1920x736 that is the difference between
 * a few milliseconds and a few hundred.
 */
export function diffStats(a: FrameBuffer, b: FrameBuffer, region: Region): DiffStats {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `diffStats: ${a.width}x${a.height} vs ${b.width}x${b.height} — frames must be the same size`,
    );
  }

  const histogram = new Uint32Array(256);
  let total = 0;
  let samples = 0;
  let max = 0;

  const x1 = Math.min(region.x + region.w, a.width);
  const y1 = Math.min(region.y + region.h, a.height);

  for (let y = region.y; y < y1; y++) {
    for (let x = region.x; x < x1; x++) {
      const i = at(a, x, y);
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        histogram[d]++;
        total += d;
        samples++;
        if (d > max) max = d;
      }
    }
  }

  if (samples === 0) {
    return { mean: 0, p50: 0, p99: 0, p999: 0, fracOver24: 0, max: 0, samples: 0 };
  }

  const percentile = (fraction: number): number => {
    const target = fraction * samples;
    let seen = 0;
    for (let d = 0; d < 256; d++) {
      seen += histogram[d];
      if (seen >= target) return d;
    }
    return 255;
  };

  let over24 = 0;
  for (let d = 25; d < 256; d++) over24 += histogram[d];

  return {
    mean: total / samples,
    p50: percentile(0.5),
    p99: percentile(0.99),
    p999: percentile(0.999),
    fracOver24: over24 / samples,
    max,
    samples,
  };
}

/**
 * Thresholds for comparing an in-page reference render against the decoded file.
 *
 * Measured floors, on an editor-like frame through this repo's own encoder at
 * the `medium` preset:
 *
 *     mean 1.07 | p50 1 | p99 4 | p999 11 | frac>24 0.008% | max 115
 *
 * The multiples below are chosen to clear that floor while still failing a
 * wrong-range decode, which reads mean 9.79.
 */
export const CODEC_THRESHOLDS = {
  mean: 2.0,
  p99: 12,
  p999: 32,
  fracOver24: 0.005,
  // `max` is deliberately absent. A correct round trip reaches 115, so any
  // max-based assertion is a coin flip rather than a measurement.
} as const;

/**
 * Thresholds for two renders that never met an encoder.
 *
 * Both sides are pre-encode RGBA, so the codec floor is gone and anything left
 * is real nondeterminism — an unawaited seek, a GPU readback race.
 */
export const DETERMINISM_THRESHOLDS = {
  mean: 0.5,
  p99: 2,
  p999: 2,
  fracOver24: 0,
} as const;

export type ThresholdSet = { mean: number; p99: number; p999: number; fracOver24: number };

export type Verdict = { pass: boolean; failures: string[]; stats: DiffStats };

export function judge(stats: DiffStats, thresholds: ThresholdSet, label: string): Verdict {
  const failures: string[] = [];
  const check = (name: string, value: number, limit: number, unit = "") => {
    if (value > limit) {
      failures.push(`${label}.${name} ${value.toFixed(4)}${unit} > ${limit}${unit}`);
    }
  };
  check("mean", stats.mean, thresholds.mean);
  check("p99", stats.p99, thresholds.p99);
  check("p999", stats.p999, thresholds.p999);
  check("fracOver24", stats.fracOver24, thresholds.fracOver24);
  return { pass: failures.length === 0, failures, stats };
}

// ------------------------------------------------------------ code decoding

/**
 * The frame index burned into a frame's code band.
 *
 * Sampled at patch centres, which sit at least half a patch from any boundary —
 * far outside the reach of chroma subsampling or a resampling kernel. Patches
 * are authored at 0 and 255 and come back within a code or two of those even at
 * crf 28, so the midpoint threshold has a margin of about 128.
 */
export function decodeFrameIndex(frame: FrameBuffer, code: CodeRegion): { value: number; raw: number[] } {
  const raw: number[] = [];
  let value = 0;
  const y = code.y + (code.h >> 1);
  for (let k = 0; k < code.bits; k++) {
    const x = code.x + k * code.patch + (code.patch >> 1);
    const px = pixel(frame, x, y);
    raw.push(px.r);
    if (px.r > 128) value |= 1 << k;
  }
  return { value, raw };
}

// ------------------------------------------------------- colorimetry canary

export type SwatchReading = {
  name: string;
  authored: [number, number, number];
  measured: [number, number, number];
  error: number;
};

export type CanaryResult = {
  pass: boolean;
  worstError: number;
  readings: SwatchReading[];
  verdict: string;
};

/**
 * Tolerance for the eight known colours, absolute, per channel.
 *
 * Measured worst-case error across the eight patches:
 *
 *     correct decode        4   (255 -> 252 on the primaries)
 *     bt709 forced         42   (green 255 -> 213)
 *     full-range forced    19   (white 255 -> 236)
 *
 * Eight sits at twice the correct floor and less than half the smallest wrong
 * decode, so it separates them without being a close call either way.
 */
export const SWATCH_TOLERANCE = 8;

/**
 * Check the RGB -> YUV -> RGB round trip against known colours.
 *
 * This runs *before* the fidelity metrics and, when it fails, replaces them:
 * a wrong colour matrix moves every pixel in the frame, so reporting five
 * failed thresholds for one root cause buries the cause. Patches are sampled
 * over their inner half, which avoids the subsampling ringing that a hard
 * colour edge produces at a patch border.
 */
export function checkColorCanary(frame: FrameBuffer, swatch: SwatchRegion): CanaryResult {
  const readings: SwatchReading[] = [];
  const insetX = Math.max(1, Math.floor(swatch.patchW / 4));
  const insetY = Math.max(1, Math.floor(swatch.h / 4));

  for (let i = 0; i < Math.min(swatch.count, SWATCH_COLORS.length); i++) {
    const x0 = swatch.x + i * swatch.patchW + insetX;
    const x1 = swatch.x + (i + 1) * swatch.patchW - insetX;
    const y0 = swatch.y + insetY;
    const y1 = swatch.y + swatch.h - insetY;

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = pixel(frame, x, y);
        r += p.r; g += p.g; b += p.b; n++;
      }
    }
    const measured: [number, number, number] = n === 0
      ? [0, 0, 0]
      : [Math.round(r / n), Math.round(g / n), Math.round(b / n)];

    const authored = SWATCH_COLORS[i].rgb as [number, number, number];
    const error = Math.max(...authored.map((v, c) => Math.abs(v - measured[c])));
    readings.push({ name: SWATCH_COLORS[i].name, authored, measured, error });
  }

  const worstError = readings.reduce((worst, reading) => Math.max(worst, reading.error), 0);
  const pass = worstError <= SWATCH_TOLERANCE;

  return {
    pass,
    worstError,
    readings,
    verdict: pass
      ? `colour round trip is honest (worst channel error ${worstError})`
      : `colour round trip is wrong: worst channel error ${worstError} > ${SWATCH_TOLERANCE}. ` +
        `${readings.filter((x) => x.error > SWATCH_TOLERANCE).map((x) => `${x.name} ${x.authored} -> ${x.measured}`).join("; ")}. ` +
        `A bt709 mis-decode reads ~42 and a full-range one ~19; fidelity numbers are meaningless until this is fixed.`,
  };
}

// ---------------------------------------------------------- alignment search

export type AlignmentResult = {
  /** Index whose ticker band best matches the reference. */
  bestIndex: number;
  bestMae: number;
  /** Smallest MAE among the other candidates. */
  runnerUpMae: number;
  /** `runnerUpMae / bestMae` — how decisively the best match wins. */
  margin: number;
  table: Array<{ index: number; mae: number }>;
};

/**
 * Below this the search has found no winner at all and the instrument itself
 * should be suspected rather than the export.
 *
 * Deliberately not the 8x the ticker was designed to clear. That figure came
 * from measuring a 1920x128 band in isolation — aligned 0.00 against ~107 one
 * frame away. In a real export the floor is not zero: the ticker is a
 * high-frequency pattern, which is the worst case for 4:2:0 chroma
 * subsampling, so an aligned pair scores ~2.6 rather than 0. And when the
 * export duplicates frames — as the microsecond-seek defect makes it do for one
 * frame in three — neighbouring output frames are *genuinely* similar, so a low
 * margin there is a true reading of a broken export rather than a broken
 * measurement.
 *
 * The claim worth asserting is therefore `argmin === N`, which the code strip
 * corroborates exactly. The margin is recorded, and only a complete absence of
 * a winner fails.
 */
export const MIN_ALIGNMENT_MARGIN = 1.05;

/** The separation a healthy export should reach; below it is worth reporting. */
export const HEALTHY_ALIGNMENT_MARGIN = 8;

/**
 * Which decoded frame the reference actually looks like.
 *
 * Restricted to the ticker band, whose pattern scrolls 32px per frame and is
 * therefore effectively uncorrelated one frame either side. Measured: a
 * correctly aligned pair scores 0.00 while +/-1 scores about 107, so the winner
 * clears the field by roughly fifty to a hundred times once codec noise is
 * accounted for.
 *
 * The code band already gives an exact integer answer. This adds two things it
 * cannot: a continuous score, and the *direction* of a shift — if the export is
 * one frame late, the reference for N matches decoded N+1 and the table says so.
 */
export function findBestAlignment(
  reference: FrameBuffer,
  candidates: Array<{ index: number; frame: FrameBuffer }>,
  ticker: Region,
): AlignmentResult {
  if (candidates.length === 0) {
    throw new Error("findBestAlignment: no candidate frames");
  }
  const table = candidates.map(({ index, frame }) => ({
    index,
    mae: diffStats(reference, frame, ticker).mean,
  }));

  const sorted = [...table].sort((a, b) => a.mae - b.mae);
  const best = sorted[0];
  const runnerUp = sorted[1];

  return {
    bestIndex: best.index,
    bestMae: best.mae,
    runnerUpMae: runnerUp?.mae ?? Infinity,
    // A perfect match scores 0, and dividing by it would be meaningless rather
    // than infinitely good; floor it at the smallest difference that is not
    // simply "identical".
    margin: (runnerUp?.mae ?? Infinity) / Math.max(best.mae, 0.01),
    table,
  };
}

// ------------------------------------------------------------------- digest

/**
 * FNV-1a over the RGBA bytes — the idiom `renderer/golden.test.ts` already uses.
 *
 * A fast path for "are these two renders identical", not a substitute for the
 * statistical comparison: one GPU rounding difference on an effect frame trips
 * it, so a mismatch means "look closer", not "fail".
 */
export function digest(frame: FrameBuffer): string {
  let hash = 0x811c9dc5;
  const { data } = frame;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Box-downsample to a small grid, for comparisons across a resampled preview. */
export function downsample(frame: FrameBuffer, region: Region, cols: number, rows: number): Float64Array {
  const out = new Float64Array(cols * rows * 3);
  const cellW = region.w / cols;
  const cellH = region.h / rows;

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = region.x + Math.floor(rx * cellW);
      const x1 = region.x + Math.floor((rx + 1) * cellW);
      const y0 = region.y + Math.floor(ry * cellH);
      const y1 = region.y + Math.floor((ry + 1) * cellH);
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = at(frame, x, y);
          r += frame.data[i]; g += frame.data[i + 1]; b += frame.data[i + 2]; n++;
        }
      }
      const o = (ry * cols + rx) * 3;
      out[o] = n ? r / n : 0;
      out[o + 1] = n ? g / n : 0;
      out[o + 2] = n ? b / n : 0;
    }
  }
  return out;
}

export function meanAbs(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Bounding box and count of everything drawn — the `renderer/testing.ts` idiom. */
export function inkBounds(frame: FrameBuffer, region: Region, threshold = 40) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = at(frame, x, y);
      if (frame.data[i] > threshold || frame.data[i + 1] > threshold || frame.data[i + 2] > threshold) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}
