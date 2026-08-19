import { describe, it, expect } from "vitest";
import {
  DEFAULT_BUCKET_MS,
  computePeaks,
  planWaveform,
  type PeakData,
  type WaveformInput,
} from "./peaks";

const RANGE = 0.9; // 45px/s, so one pixel is ~22.2ms

/** Peak data with `count` buckets, filled by `fn(bucketIndex)`. */
function peaks(
  count: number,
  fn: (i: number) => [number, number],
  bucketMs = 100,
): PeakData {
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const [lo, hi] = fn(i);
    data[i * 2] = lo;
    data[i * 2 + 1] = hi;
  }
  return { peaks: data, bucketMs, durationMs: count * bucketMs };
}

function input(over: Partial<WaveformInput> = {}): WaveformInput {
  return {
    data: peaks(100, () => [-0.5, 0.5]),
    clipX: 0,
    clipW: 90,
    spanStartMs: 0,
    sourceInMs: 0,
    speed: 1,
    range: RANGE,
    viewportX0: 0,
    viewportX1: 1000,
    ...over,
  };
}

describe("planWaveform", () => {
  it("produces one column per pixel of the clip", () => {
    expect(planWaveform(input())).toHaveLength(90);
  });

  it("reports the amplitude stored for that stretch of source", () => {
    const columns = planWaveform(input());
    expect(columns[0]).toMatchObject({ x: 0, min: -0.5, max: 0.5 });
  });

  it("keeps min and max apart rather than collapsing to magnitude", () => {
    // An asymmetric waveform is what makes speech legible; averaging loses it.
    const columns = planWaveform(
      input({ data: peaks(100, () => [-0.1, 0.9]) }),
    );
    expect(columns[0].min).toBeCloseTo(-0.1);
    expect(columns[0].max).toBeCloseTo(0.9);
  });

  it("folds several buckets into one column when zoomed out", () => {
    // At this zoom a pixel covers more than one 100ms bucket, so the loudest
    // moment in that span must survive.
    const data = peaks(100, (i) => (i === 1 ? [-1, 1] : [-0.1, 0.1]));
    const columns = planWaveform(input({ data, range: 0.05 }));
    const loudest = columns.reduce((a, b) => (b.max > a.max ? b : a));
    expect(loudest.max).toBe(1);
  });

  it("starts reading at the trim point", () => {
    // The first second is loud, the rest quiet; a clip trimmed past it must
    // show the quiet part.
    const data = peaks(100, (i) => (i < 10 ? [-1, 1] : [-0.1, 0.1]));
    const untrimmed = planWaveform(input({ data }));
    const trimmed = planWaveform(input({ data, sourceInMs: 5000 }));

    expect(untrimmed[0].max).toBe(1);
    expect(trimmed[0].max).toBeCloseTo(0.1);
  });

  it("advances through the source twice as fast when sped up", () => {
    const data = peaks(100, (i) => (i < 20 ? [-1, 1] : [-0.1, 0.1]));
    const normal = planWaveform(input({ data }));
    const fast = planWaveform(input({ data, speed: 2 }));

    const loudRun = (cols: typeof normal) =>
      cols.filter((c) => c.max > 0.5).length;
    expect(loudRun(fast)).toBeLessThan(loudRun(normal));
  });

  it("offsets columns by the clip's position on the timeline", () => {
    const columns = planWaveform(input({ clipX: 200, clipW: 50 }));
    expect(columns[0].x).toBe(200);
    expect(columns[columns.length - 1].x).toBe(249);
  });

  it("skips columns outside the viewport", () => {
    const columns = planWaveform(
      input({ clipX: 0, clipW: 900, viewportX0: 100, viewportX1: 200 }),
    );
    expect(columns[0].x).toBe(100);
    expect(columns[columns.length - 1].x).toBe(199);
  });

  it("returns nothing for a clip entirely off-screen", () => {
    expect(
      planWaveform(input({ clipX: 5000, viewportX0: 0, viewportX1: 500 })),
    ).toEqual([]);
  });

  it("reads the correct source even when scrolled off the left edge", () => {
    const data = peaks(100, (i) => (i < 10 ? [-1, 1] : [-0.1, 0.1]));
    // Clip starts 45px (one second) left of the viewport, so the loud opening
    // is already behind us.
    const columns = planWaveform(
      input({ data, clipX: -45, clipW: 200, viewportX0: 0 }),
    );
    expect(columns[0].x).toBe(0);
    expect(columns[0].max).toBeCloseTo(0.1);
  });

  it("draws a flat line past the end of the file", () => {
    // Ten buckets of 100ms is one second of audio under a much longer clip.
    const columns = planWaveform(
      input({ data: peaks(10, () => [-1, 1]), clipW: 300 }),
    );
    const last = columns[columns.length - 1];
    expect(last.min).toBe(0);
    expect(last.max).toBe(0);
  });

  it("returns nothing for empty or malformed data", () => {
    expect(planWaveform(input({ data: peaks(0, () => [0, 0]) }))).toEqual([]);
    expect(
      planWaveform(input({ data: { ...input().data, bucketMs: 0 } })),
    ).toEqual([]);
    expect(planWaveform(input({ clipW: 0 }))).toEqual([]);
  });

  it("never reads outside the bucket array", () => {
    // Out-of-range indices would read undefined and poison min/max with NaN.
    const columns = planWaveform(
      input({ data: peaks(5, () => [-1, 1]), clipW: 400, sourceInMs: -1000 }),
    );
    for (const column of columns) {
      expect(Number.isFinite(column.min)).toBe(true);
      expect(Number.isFinite(column.max)).toBe(true);
    }
  });
});

describe("computePeaks", () => {
  /** `seconds` of audio at `rate`, shaped by `fn(sampleIndex)`. */
  function tone(seconds: number, rate: number, fn: (i: number) => number) {
    const samples = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = fn(i);
    }
    return samples;
  }

  it("buckets a constant signal to its own level", () => {
    const data = computePeaks([tone(1, 1000, () => 0.5)], 1000, 1000, 100);
    expect(data.bucketMs).toBe(100);
    expect(data.peaks[1]).toBeCloseTo(0.5);
  });

  it("produces one bucket per slice of source", () => {
    const data = computePeaks([tone(1, 1000, () => 0)], 1000, 1000, 100);
    expect(data.peaks.length / 2).toBe(10);
  });

  it("captures the extremes inside a bucket, not the average", () => {
    // A single loud sample in an otherwise silent bucket must show.
    const samples = tone(1, 1000, (i) => (i === 5 ? 1 : 0));
    const data = computePeaks([samples], 1000, 1000, 100);
    expect(data.peaks[1]).toBe(1);
  });

  it("keeps the widest excursion across channels", () => {
    // Hard-panned content would vanish if channels were averaged.
    const left = tone(1, 1000, () => 0.1);
    const right = tone(1, 1000, (i) => (i === 3 ? -0.9 : 0.1));
    const data = computePeaks([left, right], 1000, 1000, 100);
    expect(data.peaks[0]).toBeCloseTo(-0.9);
  });

  it("handles a signal shorter than one bucket", () => {
    const data = computePeaks([tone(0.01, 1000, () => 0.5)], 1000, 10, 100);
    expect(data.peaks.length / 2).toBe(1);
    expect(data.peaks[1]).toBeCloseTo(0.5);
  });

  it("survives an empty buffer", () => {
    const data = computePeaks([new Float32Array(0)], 1000, 0, 100);
    expect(data.peaks.length / 2).toBe(1);
    expect(data.peaks[0]).toBe(0);
  });

  it("defaults to a bucket finer than any realistic pixel column", () => {
    // One pixel is ~22ms at the default zoom, so 20ms buckets never leave a
    // column with nothing to read.
    expect(DEFAULT_BUCKET_MS).toBeLessThanOrEqual(22);
  });

  it("round-trips through planWaveform", () => {
    const samples = tone(2, 8000, (i) => (i < 8000 ? 0.8 : 0.05));
    const data = computePeaks([samples], 8000, 2000);
    const columns = planWaveform(input({ data, clipW: 90 }));

    expect(columns[0].max).toBeCloseTo(0.8, 1);
    expect(columns[columns.length - 1].max).toBeCloseTo(0.05, 1);
  });
});
