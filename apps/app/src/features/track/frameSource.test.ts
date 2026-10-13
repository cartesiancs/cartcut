import { describe, expect, it } from "vitest";
import { nextFrameGap, seekedFrameMs } from "./frameSource";

/** Fold a list of arrivals the way the panel does. */
function fold(arrivals: number[]): number | null {
  let estimate: number | null = null;
  let previous: number | null = null;
  for (const ms of arrivals) {
    estimate = nextFrameGap(estimate, previous, ms);
    previous = ms;
  }
  return estimate;
}

describe("nextFrameGap", () => {
  it("measures one frame from steady arrivals", () => {
    const thirty = Array.from({ length: 20 }, (_, i) => (i * 1000) / 30);
    expect(fold(thirty)).toBeCloseTo(1000 / 30, 9);
  });

  it("is not lengthened by a dropped arrival", () => {
    const withDrop = [0, 1, 2, 4, 5, 7].map((i) => (i * 1000) / 60);
    expect(fold(withDrop)).toBeCloseTo(1000 / 60, 9);
  });

  it("ignores a frame presented twice", () => {
    expect(fold([0, 0, 1000 / 24, 1000 / 24, 2000 / 24])).toBeCloseTo(1000 / 24, 9);
  });

  it("has no answer from one arrival", () => {
    expect(fold([500])).toBeNull();
    expect(fold([])).toBeNull();
  });
});

describe("seekedFrameMs", () => {
  const frame = 1000 / 24;

  it("is the seed frame when it is presented again", () => {
    expect(seekedFrameMs(700, [16 * frame, 17 * frame, 18 * frame], frame)).toBe(16 * frame);
  });

  it("walks the grid back from the first frame when it is not", () => {
    expect(seekedFrameMs(700, [17 * frame, 18 * frame], frame)).toBeCloseTo(16 * frame, 9);
  });

  it("counts a frame starting a hair after the seek as the one it showed", () => {
    expect(seekedFrameMs(700, [700.3, 700.3 + frame], frame)).toBe(700.3);
  });

  it("keeps the seek when there is nothing to measure against", () => {
    expect(seekedFrameMs(700, [], null)).toBe(700);
    expect(seekedFrameMs(700, [17 * frame], null)).toBe(700);
  });
});
