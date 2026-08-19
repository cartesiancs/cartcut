import { describe, it, expect } from "vitest";
import { interpolate } from "./interpolation";
import { points } from "../renderer/testing";

/**
 * `interpolate` is the single sampler behind every animated property, so its
 * quirks are visible in every rendered frame. Despite the name it does not
 * interpolate — it snaps to the nearest baked keyframe.
 */
describe("interpolate", () => {
  const track = points([0, 0], [1000, 100], [2000, 50]);

  it("returns the value of the nearest keyframe, not a blend of neighbours", () => {
    expect(interpolate(-1, track, 0, 0)).toBe(0);
    expect(interpolate(-1, track, 0, 1000)).toBe(100);
    expect(interpolate(-1, track, 0, 2000)).toBe(50);
    // 600ms is nearer to the 1000ms point than the 0ms one; a real
    // interpolation would give 60.
    expect(interpolate(-1, track, 0, 600)).toBe(100);
  });

  it("samples relative to the element's own start time", () => {
    // The same cursor lands on a different keyframe once the element is moved
    // later on the timeline.
    expect(interpolate(-1, track, 0, 1000)).toBe(100);
    expect(interpolate(-1, track, 1000, 1000)).toBe(0);
    expect(interpolate(-1, track, 1000, 2000)).toBe(100);
  });

  it("breaks ties toward the earlier keyframe", () => {
    // 500ms is equidistant from 0 and 1000; the scan keeps the first match.
    expect(interpolate(-1, points([0, 10], [1000, 20]), 0, 500)).toBe(10);
  });

  it("falls back to the initial value before the element starts", () => {
    expect(interpolate(42, track, 5000, 0)).toBe(42);
  });

  it("falls back anywhere before the start, not just far before it", () => {
    // The old guard rounded the cursor onto a 16ms frame and then remapped it
    // onto a 20ms grid — a unit mismatch that stretched the cursor by 25%. A
    // cursor within the last fifth before an element fell through it and
    // snapped to that element's first keyframe; this case returned 0.
    expect(interpolate(42, track, 5000, 4000)).toBe(42);
    expect(interpolate(42, track, 5000, 4999)).toBe(42);
  });

  it("starts sampling exactly at the element's start time", () => {
    expect(interpolate(42, track, 5000, 5000)).toBe(0);
  });

  it("falls back on a non-finite cursor or start time", () => {
    expect(interpolate(42, track, 0, NaN)).toBe(42);
    expect(interpolate(42, track, NaN, 1000)).toBe(42);
  });

  it("falls back to the initial value when there are no keyframes", () => {
    expect(interpolate(42, [], 0, 1000)).toBe(42);
  });

  it("holds the last keyframe past the end of the track", () => {
    expect(interpolate(-1, track, 0, 999_999)).toBe(50);
  });

  it("holds the first keyframe for a cursor between the start and the first point", () => {
    expect(interpolate(-1, points([500, 7], [1500, 9]), 0, 0)).toBe(7);
  });
});
