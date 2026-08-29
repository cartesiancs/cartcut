import { describe, it, expect } from "vitest";
import { MAX_FRAMES, sampleTimes } from "./contactSheet";

describe("sampleTimes", () => {
  it("spreads the requested count across the range", () => {
    expect(sampleTimes(0, 1_000, 4)).toEqual([125, 375, 625, 875]);
  });

  it("starts half a step in rather than on the boundary", () => {
    // A cut boundary is the usual reason to ask for a sheet, and a frame taken
    // exactly on one belongs to either side depending on rounding — which is
    // the very thing the caller is trying to find out.
    const [first] = sampleTimes(1_000, 2_000, 2);
    expect(first).toBeGreaterThan(1_000);
  });

  it("stays inside the range at both ends", () => {
    const times = sampleTimes(500, 1_500, 8);
    expect(Math.min(...times)).toBeGreaterThan(500);
    expect(Math.max(...times)).toBeLessThan(1_500);
  });

  it("gives one time for a zero-width range", () => {
    expect(sampleTimes(400, 400, 6)).toEqual([400]);
  });

  it("treats a reversed range as empty rather than counting backwards", () => {
    expect(sampleTimes(900, 100, 4)).toEqual([900]);
  });

  it("clamps a negative start to zero", () => {
    expect(sampleTimes(-500, 0, 3)).toEqual([0]);
  });

  it("never exceeds the frame cap, however many are asked for", () => {
    expect(sampleTimes(0, 10_000, 500)).toHaveLength(MAX_FRAMES);
  });

  it("returns at least one time for a count of zero", () => {
    expect(sampleTimes(0, 1_000, 0)).toHaveLength(1);
  });

  it("is strictly increasing", () => {
    const times = sampleTimes(0, 9_000, 9);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });
});
