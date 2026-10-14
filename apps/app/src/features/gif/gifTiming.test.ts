import { describe, expect, it } from "vitest";

import {
  defaultGifLengthMs,
  frameDelayMs,
  frameIndexAt,
  gifTiming,
  GIF_DEFAULT_MIN_MS,
  probedGifLengthMs,
} from "./gifTiming";

describe("frameDelayMs", () => {
  it("shows a delay of 10ms or less, or none, for 100ms, as browsers do", () => {
    for (const raw of [0, 10, -5, undefined, NaN, Infinity]) {
      expect(frameDelayMs(raw)).toBe(100);
    }
    expect(frameDelayMs(20)).toBe(20);
    expect(frameDelayMs(30)).toBe(30);
  });
});

describe("frameIndexAt", () => {
  const timing = gifTiming([100, 300, 50]);

  it("finds the frame by each frame's own delay", () => {
    expect(timing.starts).toEqual([0, 100, 400]);
    expect(timing.loopMs).toBe(450);
    expect(frameIndexAt(timing, 0)).toBe(0);
    expect(frameIndexAt(timing, 99.9)).toBe(0);
    expect(frameIndexAt(timing, 100)).toBe(1);
    expect(frameIndexAt(timing, 399)).toBe(1);
    expect(frameIndexAt(timing, 400)).toBe(2);
  });

  it("loops, and takes a time before the start from the end of the loop", () => {
    expect(frameIndexAt(timing, 450)).toBe(0);
    expect(frameIndexAt(timing, 900 + 120)).toBe(1);
    expect(frameIndexAt(timing, -10)).toBe(2);
    expect(frameIndexAt(timing, -450)).toBe(0);
  });

  it("answers the first frame for a time it cannot use, and -1 for no frames", () => {
    expect(frameIndexAt(timing, NaN)).toBe(0);
    expect(frameIndexAt(timing, Infinity)).toBe(0);
    expect(frameIndexAt(gifTiming([]), 0)).toBe(-1);
  });
});

describe("defaultGifLengthMs", () => {
  it("is whole loops lasting at least the minimum", () => {
    expect(defaultGifLengthMs(1800, 1000)).toBe(3600);
    expect(defaultGifLengthMs(GIF_DEFAULT_MIN_MS, 1000)).toBe(GIF_DEFAULT_MIN_MS);
    expect(defaultGifLengthMs(4500, 1000)).toBe(4500);
    expect(defaultGifLengthMs(990, 1000)).toBe(3960);
  });

  it("falls back to a still's length for an unknown or single-frame GIF", () => {
    for (const loop of [0, -1, NaN, Infinity]) {
      expect(defaultGifLengthMs(loop, 1000)).toBe(1000);
    }
    expect(probedGifLengthMs(gifTiming([500]))).toBe(0);
    expect(probedGifLengthMs(gifTiming([500, 500]))).toBe(1000);
  });
});
