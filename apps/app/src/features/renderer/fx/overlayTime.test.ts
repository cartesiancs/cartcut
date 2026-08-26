import { describe, it, expect } from "vitest";
import { overlayDriftMs, overlaySourceTimeAt } from "./overlayTime";
import type { EffectElementType } from "../../../@types/timeline";

function effect(startTime: number): EffectElementType {
  return { startTime } as EffectElementType;
}

describe("overlaySourceTimeAt", () => {
  it("counts from the effect's own start", () => {
    expect(overlaySourceTimeAt(effect(1000), 1500, 2000)).toBe(500);
  });

  it("wraps, so a short loop covers a long effect", () => {
    // A two-second rain loop under a thirty-second effect.
    const rain = effect(0);
    expect(overlaySourceTimeAt(rain, 2000, 2000)).toBe(0);
    expect(overlaySourceTimeAt(rain, 2500, 2000)).toBe(500);
    expect(overlaySourceTimeAt(rain, 30_500, 2000)).toBe(500);
  });

  it("is zero before the effect begins", () => {
    expect(overlaySourceTimeAt(effect(1000), 500, 2000)).toBe(0);
    expect(overlaySourceTimeAt(effect(1000), 1000, 2000)).toBe(0);
  });

  it("returns zero rather than NaN before the media reports a duration", () => {
    // `<video>.duration` is NaN until metadata arrives, and `NaN % n` is NaN —
    // which would seek the handle to an invalid position and leave it there.
    expect(overlaySourceTimeAt(effect(0), 1000, NaN)).toBe(0);
    expect(overlaySourceTimeAt(effect(0), 1000, 0)).toBe(0);
    expect(overlaySourceTimeAt(effect(0), 1000, Infinity)).toBe(0);
  });
});

describe("overlayDriftMs", () => {
  it("measures the ordinary distance", () => {
    expect(overlayDriftMs(500, 700, 2000)).toBe(200);
  });

  it("measures across the wrap, not the long way round", () => {
    // At the end of a loop the handle is at 1990 and the target is 10. That is
    // 20ms apart. Measuring it as 1980 would seek on every wrap and stutter the
    // loop once per cycle.
    expect(overlayDriftMs(1990, 10, 2000)).toBe(20);
    expect(overlayDriftMs(10, 1990, 2000)).toBe(20);
  });

  it("is zero when the handle is where it should be", () => {
    expect(overlayDriftMs(1234, 1234, 2000)).toBe(0);
  });

  it("falls back to a plain difference with no usable duration", () => {
    expect(overlayDriftMs(500, 700, NaN)).toBe(200);
    expect(overlayDriftMs(500, 700, 0)).toBe(200);
  });
});
