/**
 * Waveform geometry: which slice of a decoded audio file each pixel column
 * shows.
 *
 * The filmstrip's problem in a different shape. Decoding audio is expensive and
 * happens once per file; what changes constantly is how much source time a
 * single pixel covers. So the decode produces a fixed bucket array — min and
 * max amplitude over a small slice of source — and drawing folds however many
 * buckets a column spans into one min/max pair.
 *
 * Min *and* max rather than a single magnitude: a waveform drawn from
 * magnitude alone loses the asymmetry that makes speech and music legible.
 *
 * Pure and DOM-free.
 */

import { pxToMsSigned } from "../geometry";

export type PeakData = {
  /**
   * Interleaved `[min, max, min, max, ...]` per bucket, each in -1..1.
   *
   * A flat array rather than pairs: one allocation for a file that can run to
   * tens of thousands of buckets.
   */
  peaks: Float32Array;
  /** Source ms covered by one bucket. */
  bucketMs: number;
  /** Length of the source, in ms. */
  durationMs: number;
};

export type WaveformColumn = {
  x: number;
  /** Both in -1..1. */
  min: number;
  max: number;
};

/** How much source one bucket covers. Finer than any realistic pixel column. */
export const DEFAULT_BUCKET_MS = 20;

export type WaveformInput = {
  data: PeakData;
  clipX: number;
  clipW: number;
  /** Where the clip begins on the timeline. */
  spanStartMs: number;
  /** Source ms shown at the clip's left edge. */
  sourceInMs: number;
  speed: number;
  range: number;
  viewportX0: number;
  viewportX1: number;
};

/**
 * One column per visible pixel of the clip.
 *
 * Columns outside the viewport are skipped rather than computed and discarded —
 * a ten-minute clip zoomed in is mostly off-screen.
 */
export function planWaveform(input: WaveformInput): WaveformColumn[] {
  const {
    data,
    clipX,
    clipW,
    spanStartMs,
    sourceInMs,
    speed,
    range,
    viewportX0,
    viewportX1,
  } = input;

  const bucketCount = Math.floor(data.peaks.length / 2);
  if (bucketCount === 0 || data.bucketMs <= 0 || clipW <= 0) {
    return [];
  }

  const from = Math.max(Math.floor(clipX), Math.floor(viewportX0));
  const to = Math.min(Math.ceil(clipX + clipW), Math.ceil(viewportX1));
  if (to <= from) {
    return [];
  }

  // Source time one pixel covers. Constant across the clip.
  const perPixelSourceMs = Math.abs(pxToMsSigned(1, range) * speed);
  const columns: WaveformColumn[] = [];

  for (let x = from; x < to; x++) {
    const timelineMs = spanStartMs + pxToMsSigned(x - clipX, range);
    const startSource = sourceInMs + (timelineMs - spanStartMs) * speed;
    const endSource = startSource + perPixelSourceMs;

    const first = Math.floor(startSource / data.bucketMs);
    let last = Math.ceil(endSource / data.bucketMs);

    // A column narrower than a bucket still has to read one.
    if (last <= first) {
      last = first + 1;
    }

    // Intersect with the file rather than clamping into it: clamping would pin
    // a column past the end onto the final bucket and repeat that sample
    // forever, drawing audio where there is none.
    const from = Math.max(0, first);
    const until = Math.min(bucketCount, last);

    let min = 0;
    let max = 0;
    for (let bucket = from; bucket < until; bucket++) {
      const lo = data.peaks[bucket * 2];
      const hi = data.peaks[bucket * 2 + 1];
      if (lo < min) {
        min = lo;
      }
      if (hi > max) {
        max = hi;
      }
    }

    columns.push({ x, min, max });
  }

  return columns;
}

/**
 * Fold raw samples into buckets.
 *
 * Channels are merged by taking the widest excursion of either, which keeps a
 * hard-panned transient visible instead of averaging it away.
 */
export function computePeaks(
  channels: Float32Array[],
  sampleRate: number,
  durationMs: number,
  bucketMs: number = DEFAULT_BUCKET_MS,
): PeakData {
  const bucketSamples = Math.max(1, Math.round((sampleRate * bucketMs) / 1000));
  const length = channels[0]?.length ?? 0;
  const bucketCount = Math.max(1, Math.ceil(length / bucketSamples));
  const peaks = new Float32Array(bucketCount * 2);

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * bucketSamples;
    const end = Math.min(start + bucketSamples, length);

    let min = 0;
    let max = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const sample = channel[i];
        if (sample < min) {
          min = sample;
        }
        if (sample > max) {
          max = sample;
        }
      }
    }

    peaks[bucket * 2] = min;
    peaks[bucket * 2 + 1] = max;
  }

  return { peaks, bucketMs, durationMs };
}
