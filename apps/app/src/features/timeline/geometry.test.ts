import { describe, it, expect } from "vitest";
import {
  MIN_SOURCE_MS,
  assertTrimInvariant,
  ffmpegWindow,
  hasValidTrim,
  isDynamicElement,
  msToPxSigned,
  pxToMsSigned,
  sourceDurationOf,
  sourceTimeAt,
  spanEnd,
  spanLength,
  spanOf,
  spanStart,
  speedOf,
  timelineTimeAt,
} from "./geometry";
import {
  audioElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";

describe("isDynamicElement", () => {
  it("separates source-backed elements from placed ones", () => {
    expect(isDynamicElement(videoElement({}))).toBe(true);
    expect(isDynamicElement(audioElement({}))).toBe(true);
    expect(isDynamicElement(imageElement({}))).toBe(false);
    expect(isDynamicElement(textElement({}))).toBe(false);
  });
});

describe("speedOf", () => {
  it("reads the rate off a dynamic element", () => {
    expect(speedOf(videoElement({ speed: 2 }))).toBe(2);
    expect(speedOf(videoElement({ speed: 0.5 }))).toBe(0.5);
  });

  it("is 1 for static elements, which have no rate", () => {
    expect(speedOf(imageElement({}))).toBe(1);
  });

  it("falls back to real time rather than producing an infinite span", () => {
    // A zero here used to divide through into Infinity and take the whole
    // timeline with it.
    expect(speedOf(videoElement({ speed: 0 }))).toBe(1);
    expect(speedOf(videoElement({ speed: -1 }))).toBe(1);
    expect(speedOf(videoElement({ speed: undefined as any }))).toBe(1);
  });
});

describe("spanStart / spanLength / spanEnd", () => {
  it("covers [startTime, startTime + duration) for a static element", () => {
    const el = imageElement({ startTime: 1000, duration: 2000 });
    expect(spanStart(el)).toBe(1000);
    expect(spanLength(el)).toBe(2000);
    expect(spanEnd(el)).toBe(3000);
  });

  it("divides a dynamic element's source duration by its speed", () => {
    expect(spanLength(videoElement({ duration: 2000, speed: 1 }))).toBe(2000);
    expect(spanLength(videoElement({ duration: 2000, speed: 2 }))).toBe(1000);
    expect(spanLength(videoElement({ duration: 2000, speed: 0.5 }))).toBe(4000);
  });

  it("ignores trim, which addresses the source file", () => {
    // The clip is on screen from 43s for 38s of source at 1x, wherever in the
    // file those 38 seconds happen to live.
    const el = videoElement({
      startTime: 43_000,
      duration: 38_000,
      speed: 1,
      trim: { startTime: 71_300, endTime: 109_300 },
      sourceDuration: 200_000,
    });
    expect(spanStart(el)).toBe(43_000);
    expect(spanEnd(el)).toBe(81_000);
  });

  it("reports the three values consistently", () => {
    const el = videoElement({ startTime: 500, duration: 4000, speed: 2 });
    expect(spanOf(el)).toEqual({ start: 500, end: 2500, length: 2000 });
  });
});

describe("sourceDurationOf", () => {
  it("uses the declared source length", () => {
    const el = videoElement({ duration: 1000, sourceDuration: 60_000 });
    expect(sourceDurationOf(el)).toBe(60_000);
  });

  it("falls back to the widest evidence available when it is missing", () => {
    // Without this an element authored before the field existed could never
    // have its trim-end dragged back outwards.
    const el = videoElement({
      duration: 4000,
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: undefined as any,
    });
    expect(sourceDurationOf(el)).toBe(4000);
  });
});

describe("sourceTimeAt", () => {
  it("starts at the trim point, not at zero", () => {
    const el = videoElement({
      startTime: 1000,
      duration: 3000,
      speed: 1,
      trim: { startTime: 5000, endTime: 8000 },
      sourceDuration: 20_000,
    });
    expect(sourceTimeAt(el, 1000)).toBe(5000);
    expect(sourceTimeAt(el, 2500)).toBe(6500);
    expect(sourceTimeAt(el, 4000)).toBe(8000);
  });

  it("advances through the source faster than the timeline when sped up", () => {
    const el = videoElement({
      startTime: 0,
      duration: 4000,
      speed: 2,
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: 10_000,
    });
    // The 4s of source plays out over 2s of timeline.
    expect(sourceTimeAt(el, 0)).toBe(0);
    expect(sourceTimeAt(el, 1000)).toBe(2000);
    expect(sourceTimeAt(el, 2000)).toBe(4000);
  });

  it("combines a trim offset with a speed change", () => {
    const el = videoElement({
      startTime: 10_000,
      duration: 4000,
      speed: 2,
      trim: { startTime: 30_000, endTime: 34_000 },
      sourceDuration: 90_000,
    });
    expect(sourceTimeAt(el, 10_000)).toBe(30_000);
    expect(sourceTimeAt(el, 11_000)).toBe(32_000);
  });
});

describe("timelineTimeAt", () => {
  it("inverts sourceTimeAt", () => {
    const el = videoElement({
      startTime: 4000,
      duration: 3000,
      speed: 1.5,
      trim: { startTime: 9000, endTime: 12_000 },
      sourceDuration: 40_000,
    });
    for (const t of [4000, 4500, 5200, 6000]) {
      expect(timelineTimeAt(el, sourceTimeAt(el, t))).toBeCloseTo(t);
    }
  });

  it("maps the trim point to the clip's left edge", () => {
    const el = videoElement({
      startTime: 4000,
      duration: 3000,
      speed: 1,
      trim: { startTime: 9000, endTime: 12_000 },
      sourceDuration: 40_000,
    });
    expect(timelineTimeAt(el, 9000)).toBe(4000);
    expect(timelineTimeAt(el, 12_000)).toBe(7000);
  });

  it("compresses source time when the clip is sped up", () => {
    // A transcript timestamped against the file has to be squeezed to match.
    const el = videoElement({
      startTime: 0,
      duration: 4000,
      speed: 2,
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: 4000,
    });
    expect(timelineTimeAt(el, 2000)).toBe(1000);
  });
});

describe("ffmpegWindow", () => {
  it("seeks to the trim point and takes the source-domain length", () => {
    const el = videoElement({
      startTime: 2500,
      duration: 4000,
      speed: 2,
      trim: { startTime: 30_000, endTime: 34_000 },
      sourceDuration: 90_000,
    });
    // -t is source seconds because -ss is a source seek; the timeline only
    // enters through the delay.
    expect(ffmpegWindow(el)).toEqual({
      ssSec: 30,
      tSec: 4,
      delayMs: 2500,
    });
  });

  it("delays by the clip's timeline position, not by its trim", () => {
    const el = audioElement({
      startTime: 7000,
      duration: 1000,
      speed: 1,
      trim: { startTime: 4000, endTime: 5000 },
      sourceDuration: 20_000,
    });
    // The old graph added trim.startTime here, pushing exported audio late.
    expect(ffmpegWindow(el).delayMs).toBe(7000);
  });
});

describe("msToPxSigned / pxToMsSigned", () => {
  it("round-trips through the timeline scale", () => {
    for (const range of [0.9, 1, 4, 9]) {
      expect(pxToMsSigned(msToPxSigned(5000, range), range)).toBeCloseTo(5000);
    }
  });

  it("keeps negatives negative", () => {
    // utils/time.millisecondsToPx clamps these to 0, which pins a clip scrolled
    // off the left edge to x=0 and draws it at the wrong width.
    expect(msToPxSigned(-1000, 4)).toBeLessThan(0);
    expect(pxToMsSigned(msToPxSigned(-1000, 4), 4)).toBeCloseTo(-1000);
  });

  it("puts one second at 45px at the default zoom", () => {
    expect(msToPxSigned(1000, 0.9)).toBeCloseTo(45);
  });

  it("scales linearly with the range", () => {
    expect(msToPxSigned(1000, 8)).toBeCloseTo(msToPxSigned(1000, 4) * 2);
  });

  it("does not round, so repeated conversions do not drift", () => {
    // The old .toFixed(0) inside every conversion cost a pixel per mousemove.
    let ms = 1234.5;
    for (let i = 0; i < 50; i++) {
      ms = pxToMsSigned(msToPxSigned(ms, 0.9), 0.9);
    }
    expect(ms).toBeCloseTo(1234.5);
  });
});

describe("assertTrimInvariant", () => {
  it("accepts an element whose duration matches its source window", () => {
    const el = videoElement({
      duration: 3000,
      trim: { startTime: 1000, endTime: 4000 },
      sourceDuration: 10_000,
    });
    expect(() => assertTrimInvariant(el)).not.toThrow();
    expect(hasValidTrim(el)).toBe(true);
  });

  it("rejects the shape the old trim handles produced", () => {
    // Dragging a trim handle used to move `trim` alone and leave `duration` at
    // the full source length, so the export ignored the trim entirely.
    const el = videoElement({
      duration: 10_000,
      trim: { startTime: 2000, endTime: 6000 },
      sourceDuration: 10_000,
    });
    expect(() => assertTrimInvariant(el, "clip")).toThrow(/clip/);
    expect(hasValidTrim(el)).toBe(false);
  });

  it("has nothing to say about static elements", () => {
    expect(() => assertTrimInvariant(imageElement({}))).not.toThrow();
    expect(hasValidTrim(textElement({}))).toBe(true);
  });

  it("tolerates sub-millisecond float error", () => {
    const el = videoElement({
      duration: 3000.0001,
      trim: { startTime: 0, endTime: 3000 },
      sourceDuration: 10_000,
    });
    expect(() => assertTrimInvariant(el)).not.toThrow();
  });
});

describe("MIN_SOURCE_MS", () => {
  it("is small enough to be invisible but non-zero", () => {
    // A zero-length window would make the clip permanently invisible, since
    // isTimeInRange is half-open.
    expect(MIN_SOURCE_MS).toBeGreaterThan(0);
  });
});
