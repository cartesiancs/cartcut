import { describe, it, expect } from "vitest";
import {
  easingNames,
  projectEasing,
  resolveEasing,
  type CubicPoints,
} from "./easing";

describe("resolveEasing", () => {
  it("resolves every name it advertises", () => {
    for (const name of easingNames()) {
      expect(resolveEasing(name)).not.toBeNull();
    }
  });

  it("gives linear the control points of a straight line", () => {
    expect(resolveEasing("linear")).toEqual([0, 0, 1, 1]);
  });

  it("lets overshoot pass the target, which is the whole point", () => {
    const [, y1] = resolveEasing("overshoot") as CubicPoints;
    expect(y1).toBeGreaterThan(1);
  });

  it("lets anticipate pull back before it goes", () => {
    const [, y1] = resolveEasing("anticipate") as CubicPoints;
    expect(y1).toBeLessThan(0);
  });

  it("takes a raw curve as an escape hatch", () => {
    expect(resolveEasing([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("clamps a raw curve on the time axis only", () => {
    // x outside the segment is not a curve — the baker would clamp it anyway,
    // and silently. y is left free so overshoot survives.
    expect(resolveEasing([-1, -3, 2, 4])).toEqual([0, -3, 1, 4]);
  });

  it("refuses a name it does not know", () => {
    expect(resolveEasing("bounce")).toBeNull();
    expect(resolveEasing("easeInOutQuint")).toBeNull();
  });

  it("refuses a malformed raw curve rather than guessing", () => {
    expect(resolveEasing([0.1, 0.2, 0.3])).toBeNull();
    expect(resolveEasing([0.1, 0.2, 0.3, "x"])).toBeNull();
    expect(resolveEasing([0.1, 0.2, 0.3, NaN])).toBeNull();
    expect(resolveEasing(null)).toBeNull();
    expect(resolveEasing(undefined)).toBeNull();
    expect(resolveEasing(0.5)).toBeNull();
  });
});

describe("projectEasing", () => {
  const from = { atMs: 1_000, value: 0 };
  const to = { atMs: 2_000, value: 100 };

  it("puts a linear curve's handles on the straight line between anchors", () => {
    const { ce, cs } = projectEasing([0, 0, 1, 1], from, to);
    expect(ce).toEqual([1_000, 0]);
    expect(cs).toEqual([2_000, 100]);
  });

  it("scales the normalised curve onto the segment's own span", () => {
    const { ce, cs } = projectEasing([0.25, 0.5, 0.75, 0.5], from, to);
    expect(ce).toEqual([1_250, 50]);
    expect(cs).toEqual([1_750, 50]);
  });

  it("carries overshoot past the target value", () => {
    const { ce } = projectEasing([0.34, 1.56, 0.64, 1], from, to);
    // 156% of the way from 0 to 100.
    expect(ce[1]).toBeCloseTo(156, 5);
  });

  it("carries anticipation below the starting value", () => {
    const { ce } = projectEasing([0.36, -0.56, 0.66, 1], from, to);
    expect(ce[1]).toBeCloseTo(-56, 5);
  });

  it("collapses the value term when the anchors hold the same value", () => {
    // Nothing to ease between, so both handles sit at that value and only the
    // times differ.
    const flat = { atMs: 2_000, value: 0 };
    const { ce, cs } = projectEasing([0.34, 1.56, 0.64, 1], from, flat);
    expect(ce[1]).toBe(0);
    expect(cs[1]).toBe(0);
  });

  it("works on a descending segment", () => {
    const { ce } = projectEasing([0.5, 0.5, 0.5, 0.5], { atMs: 0, value: 100 }, { atMs: 500, value: 0 });
    expect(ce).toEqual([250, 50]);
  });

  it("keeps handle times inside the segment for every named curve", () => {
    for (const name of easingNames()) {
      const curve = resolveEasing(name) as CubicPoints;
      const { ce, cs } = projectEasing(curve, from, to);
      for (const handle of [ce, cs]) {
        expect(handle[0]).toBeGreaterThanOrEqual(from.atMs);
        expect(handle[0]).toBeLessThanOrEqual(to.atMs);
      }
    }
  });
});
