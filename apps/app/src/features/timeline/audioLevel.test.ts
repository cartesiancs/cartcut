import { describe, expect, it } from "vitest";
import {
  METER_FLOOR_DB,
  amplitudeToDb,
  audiblePathsAt,
  bucketPeakAt,
  compositeLevel,
  meterFractionOf,
  type PeakLookup,
} from "./audioLevel";
import type { PeakData } from "./strip/peaks";
import type { Timeline } from "../../@types/timeline";
import { audioElement, videoElement } from "../renderer/testing";

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

/** Every path answers with the same table. */
const always =
  (data: PeakData | null): PeakLookup =>
  () =>
    data;

/** A lookup keyed by path, so two clips can carry different material. */
const byPath =
  (table: Record<string, PeakData>): PeakLookup =>
  (path) =>
    table[path] ?? null;

function doc(...elements: any[]): Timeline {
  const out: Record<string, any> = {};
  elements.forEach((element, i) => {
    out[`el-${i}`] = element;
  });
  return out as Timeline;
}

describe("amplitudeToDb", () => {
  it("puts unity at 0 dBFS and silence on the floor", () => {
    expect(amplitudeToDb(1)).toBe(0);
    expect(amplitudeToDb(0)).toBe(METER_FLOOR_DB);
  });

  it("floors rather than running to -Infinity", () => {
    // 10 ** (-80/20) is well under the floor, and log10(0) is -Infinity.
    expect(amplitudeToDb(0.0001)).toBe(METER_FLOOR_DB);
    expect(Number.isFinite(amplitudeToDb(0))).toBe(true);
  });

  it("is the usual 20 * log10", () => {
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(amplitudeToDb(10 ** (-20 / 20))).toBeCloseTo(-20, 6);
  });

  it("does not report above unity", () => {
    expect(amplitudeToDb(2)).toBe(0);
  });
});

describe("meterFractionOf", () => {
  it("spans the floor to unity", () => {
    expect(meterFractionOf(METER_FLOOR_DB)).toBe(0);
    expect(meterFractionOf(0)).toBe(1);
    expect(meterFractionOf(-30)).toBeCloseTo(0.5, 6);
  });

  it("clamps outside the scale rather than running off the bar", () => {
    expect(meterFractionOf(-120)).toBe(0);
    expect(meterFractionOf(6)).toBe(1);
    expect(meterFractionOf(NaN)).toBe(0);
  });
});

describe("bucketPeakAt", () => {
  const data = peaks(3, (i) => [[-0.2, -0.9, -0.1][i], [0.5, 0.3, 0.05][i]]);

  it("takes the wider excursion of the two, either sign", () => {
    expect(bucketPeakAt(data, 0)).toBeCloseTo(0.5, 6);
    // Bucket 1's minimum is louder than its maximum.
    expect(bucketPeakAt(data, 100)).toBeCloseTo(0.9, 6);
  });

  it("picks the bucket the source time falls in", () => {
    expect(bucketPeakAt(data, 99.9)).toBeCloseTo(0.5, 6);
    expect(bucketPeakAt(data, 100)).toBeCloseTo(0.9, 6);
    expect(bucketPeakAt(data, 200)).toBeCloseTo(0.1, 6);
  });

  /**
   * The rule `planWaveform` already states: clamping past the end would pin the
   * cursor onto the final bucket and report a level where there is no sound.
   */
  it("answers 0 past the end rather than repeating the last bucket", () => {
    expect(bucketPeakAt(data, 300)).toBe(0);
    expect(bucketPeakAt(data, 9999)).toBe(0);
  });

  it("answers 0 before the start and on a degenerate table", () => {
    expect(bucketPeakAt(data, -1)).toBe(0);
    expect(bucketPeakAt(peaks(0, () => [0, 0]), 0)).toBe(0);
    expect(bucketPeakAt({ ...data, bucketMs: 0 }, 0)).toBe(0);
  });
});

describe("compositeLevel", () => {
  const loud = peaks(10, () => [-0.5, 0.5]);

  it("reads the level under the cursor", () => {
    const level = compositeLevel(
      doc(audioElement({ startTime: 0, duration: 1000 })),
      500,
      always(loud),
    );
    expect(level).toBeCloseTo(0.5, 6);
  });

  it("is silent outside the clip's span", () => {
    const elements = doc(audioElement({ startTime: 1000, duration: 1000 }));
    expect(compositeLevel(elements, 500, always(loud))).toBe(0);
    expect(compositeLevel(elements, 1500, always(loud))).toBeCloseTo(0.5, 6);
    expect(compositeLevel(elements, 2500, always(loud))).toBe(0);
  });

  /**
   * The point of asking `isAudibleElement` rather than re-deriving audibility:
   * these are exactly the clips `intentFor` mutes, so the meter and the sound
   * cannot disagree about who is contributing.
   */
  it("excludes what the preview mutes", () => {
    const detached = doc(
      videoElement({ isExistAudio: true, audioDetached: true }),
    );
    expect(compositeLevel(detached, 500, always(loud))).toBe(0);

    const silentFile = doc(videoElement({ isExistAudio: false }));
    expect(compositeLevel(silentFile, 500, always(loud))).toBe(0);

    const heard = doc(videoElement({ isExistAudio: true }));
    expect(compositeLevel(heard, 500, always(loud))).toBeCloseTo(0.5, 6);
  });

  it("scales by the clip's fader", () => {
    const half = doc(audioElement({ volumeDb: -6.020599913279624 }));
    expect(compositeLevel(half, 500, always(loud))).toBeCloseTo(0.25, 3);
  });

  it("is exactly silent at the bottom of the fader", () => {
    expect(compositeLevel(doc(audioElement({ volumeDb: -60 })), 500, always(loud)))
      .toBe(0);
  });

  /**
   * Independent sources add as power, not as amplitude — 0.6 and 0.8 make 1.0,
   * not 1.4. Amplitude summing would put the meter in the red on any two clips
   * that happen to overlap.
   */
  it("sums overlapping clips by power", () => {
    const elements = doc(
      audioElement({ localpath: "file:///a.wav" }),
      audioElement({ localpath: "file:///b.wav" }),
    );
    const level = compositeLevel(
      elements,
      500,
      byPath({
        "file:///a.wav": peaks(10, () => [-0.6, 0.6]),
        "file:///b.wav": peaks(10, () => [-0.8, 0.8]),
      }),
    );
    expect(level).toBeCloseTo(1, 6);
  });

  it("clamps at unity rather than reporting headroom that does not exist", () => {
    const elements = doc(
      audioElement({ localpath: "file:///a.wav" }),
      audioElement({ localpath: "file:///b.wav" }),
      audioElement({ localpath: "file:///c.wav" }),
    );
    const level = compositeLevel(elements, 500, always(peaks(10, () => [-1, 1])));
    expect(level).toBe(1);
  });

  it("follows trim and speed through sourceTimeAt", () => {
    // Bucket 3 (300..400ms of source) is the only loud one.
    const table = peaks(10, (i) => (i === 3 ? [-0.9, 0.9] : [-0.1, 0.1]));

    // speed 2: 150ms into the clip is 300ms into the source.
    const fast = doc(
      audioElement({ startTime: 0, duration: 1000, speed: 2 }),
    );
    expect(compositeLevel(fast, 150, always(table))).toBeCloseTo(0.9, 6);
    expect(compositeLevel(fast, 50, always(table))).toBeCloseTo(0.1, 6);

    // trim.startTime 300: the clip opens on the loud bucket.
    const trimmed = doc(
      audioElement({
        startTime: 0,
        duration: 100,
        trim: { startTime: 300, endTime: 400 },
      }),
    );
    expect(compositeLevel(trimmed, 10, always(table))).toBeCloseTo(0.9, 6);
  });

  it("treats a file with no decoded peaks as silence", () => {
    expect(compositeLevel(doc(audioElement()), 500, always(null))).toBe(0);
  });

  it("survives a null element and an empty document", () => {
    expect(compositeLevel({} as Timeline, 500, always(loud))).toBe(0);
    expect(compositeLevel(doc(null), 500, always(loud))).toBe(0);
  });
});

describe("audiblePathsAt", () => {
  it("names only what is sounding at the cursor", () => {
    const elements = doc(
      audioElement({ localpath: "file:///now.wav", startTime: 0, duration: 1000 }),
      audioElement({
        localpath: "file:///later.wav",
        startTime: 5000,
        duration: 1000,
      }),
    );
    expect(audiblePathsAt(elements, 500)).toEqual(["file:///now.wav"]);
  });

  /** A video and its detached twin share a path; asking twice is a wasted decode. */
  it("deduplicates a shared source", () => {
    const elements = doc(
      audioElement({ localpath: "file:///same.mp4" }),
      audioElement({ localpath: "file:///same.mp4" }),
    );
    expect(audiblePathsAt(elements, 500)).toEqual(["file:///same.mp4"]);
  });

  it("skips the clips the preview mutes", () => {
    const elements = doc(
      videoElement({ localpath: "file:///v.mp4", audioDetached: true }),
    );
    expect(audiblePathsAt(elements, 500)).toEqual([]);
  });
});
