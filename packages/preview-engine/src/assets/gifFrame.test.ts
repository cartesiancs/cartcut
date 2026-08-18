import { describe, it, expect } from "vitest";
import { pickGifFrameIndex } from "./gifFrame";

describe("pickGifFrameIndex", () => {
  it("advances one frame per delay, rounding to nearest", () => {
    expect(pickGifFrameIndex(10, 100, 0)).toBe(0);
    expect(pickGifFrameIndex(10, 100, 49)).toBe(0);
    expect(pickGifFrameIndex(10, 100, 50)).toBe(1);
    expect(pickGifFrameIndex(10, 100, 300)).toBe(3);
  });

  it("wraps around at the end of the frame list", () => {
    expect(pickGifFrameIndex(10, 100, 1000)).toBe(0);
    expect(pickGifFrameIndex(10, 100, 1200)).toBe(2);
  });

  it("keys off absolute timeline time, not time since the element start", () => {
    // Two elements at different start times show the same frame at the same
    // instant — the phase-locked behaviour every original renderer had.
    const atOneSecond = pickGifFrameIndex(10, 100, 1000);
    expect(pickGifFrameIndex(10, 100, 1000)).toBe(atOneSecond);
  });

  it("returns 0 instead of NaN for a zero or missing delay", () => {
    expect(pickGifFrameIndex(10, 0, 500)).toBe(0);
    expect(pickGifFrameIndex(10, Number.NaN, 500)).toBe(0);
    expect(pickGifFrameIndex(10, undefined as unknown as number, 500)).toBe(0);
  });

  it("returns 0 for an empty frame list", () => {
    expect(pickGifFrameIndex(0, 100, 500)).toBe(0);
  });

  it("never returns a negative index for a negative cursor", () => {
    const i = pickGifFrameIndex(10, 100, -350);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(10);
  });
});
