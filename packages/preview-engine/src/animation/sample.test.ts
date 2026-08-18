import { describe, it, expect } from "vitest";
import {
  findNearestY,
  zeroIfNegative,
  isBeforeElementStart,
  sampleScale,
  sampleRotation,
  samplePosition,
  sampleOpacityAlpha,
} from "./sample";
import type { RenderElement } from "../model/timeline.types";

describe("findNearestY", () => {
  const pairs = [
    [0, 10],
    [100, 20],
    [200, 30],
  ];

  it("returns the y of the pair with x closest to a", () => {
    expect(findNearestY(pairs, 0)).toBe(10);
    expect(findNearestY(pairs, 90)).toBe(20);
    expect(findNearestY(pairs, 199)).toBe(30);
  });

  it("keeps the earlier pair on ties (strict <)", () => {
    // a=50 is equidistant to x=0 and x=100 -> first (10) wins
    expect(findNearestY(pairs, 50)).toBe(10);
  });

  it("returns null for empty or missing input", () => {
    expect(findNearestY([], 5)).toBeNull();
    expect(findNearestY(undefined, 5)).toBeNull();
  });
});

describe("zeroIfNegative", () => {
  it("passes through positives, floors non-positives to 0", () => {
    expect(zeroIfNegative(0.5)).toBe(0.5);
    expect(zeroIfNegative(0)).toBe(0);
    expect(zeroIfNegative(-3)).toBe(0);
  });
});

describe("isBeforeElementStart", () => {
  it("is true when the rounded grid point precedes startTime", () => {
    expect(isBeforeElementStart(0, 1000)).toBe(true);
  });
  it("is false at/after the element start", () => {
    expect(isBeforeElementStart(1000, 1000)).toBe(false);
    expect(isBeforeElementStart(2000, 1000)).toBe(false);
  });
});

const withTrack = (
  track: "scale" | "rotation" | "position" | "opacity",
  data: Record<string, unknown>,
  startTime = 0,
): RenderElement => ({
  startTime,
  animation: { [track]: { isActivate: true, ...data } } as never,
});

describe("sampleScale", () => {
  it("returns null when the track is inactive", () => {
    expect(sampleScale({ startTime: 0, animation: {} }, 100)).toBeNull();
  });
  it("returns false before the element start", () => {
    const el = withTrack("scale", { ax: [[0, 20]] }, 1000);
    expect(sampleScale(el, 0)).toBe(false);
  });
  it("returns sampled ax/10", () => {
    const el = withTrack("scale", {
      ax: [
        [0, 10],
        [500, 20],
      ],
    });
    expect(sampleScale(el, 500)).toBe(2); // 20/10
    expect(sampleScale(el, 0)).toBe(1); // 10/10
  });
});

describe("sampleRotation", () => {
  it("returns null when inactive", () => {
    expect(sampleRotation({ startTime: 0, animation: {} }, 100)).toBeNull();
  });
  it("converts sampled degrees to radians", () => {
    const el = withTrack("rotation", { ax: [[0, 180]] });
    const out = sampleRotation(el, 0);
    expect(out).not.toBe(false);
    expect((out as { ax: number }).ax).toBeCloseTo(Math.PI, 10);
  });
});

describe("samplePosition", () => {
  it("returns null when inactive", () => {
    expect(samplePosition({ startTime: 0, animation: {} }, 100)).toBeNull();
  });
  it("samples ax and ay independently", () => {
    const el = withTrack("position", {
      ax: [
        [0, 5],
        [100, 15],
      ],
      ay: [
        [0, 50],
        [100, 150],
      ],
    });
    expect(samplePosition(el, 100)).toEqual({ ax: 15, ay: 150 });
  });
});

describe("sampleOpacityAlpha", () => {
  it("returns null when inactive", () => {
    expect(sampleOpacityAlpha({ startTime: 0, animation: {} }, 100)).toBeNull();
  });
  it("returns a clamped 0..1 alpha", () => {
    const el = withTrack("opacity", {
      ax: [
        [0, 100],
        [100, 50],
      ],
    });
    expect(sampleOpacityAlpha(el, 100)).toBe(0.5);
    expect(sampleOpacityAlpha(el, 0)).toBe(1);
  });
  it("floors negative sampled opacity to 0", () => {
    const el = withTrack("opacity", { ax: [[0, -20]] });
    expect(sampleOpacityAlpha(el, 0)).toBe(0);
  });
});
