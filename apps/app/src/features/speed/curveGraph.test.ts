/**
 * The graph's rules, with no canvas and no Lit anywhere near them.
 *
 * The properties that matter are the two the drag depends on: a point never
 * passes a neighbour, and every edit is an absolute answer that can be applied
 * twice without moving anything the second time.
 */

import { describe, expect, it } from "vitest";
import {
  HIT_RADIUS_PX,
  MARGIN_FRACTION,
  SPEED_CURVE_PRESETS,
  fractionToSpeed,
  hitTest,
  insertPoint,
  isRampArmed,
  movePoint,
  removePoint,
  seedCurveFor,
  speedToFraction,
  toCurve,
  toScreen,
  viewportFor,
  type GraphViewport,
} from "./curveGraph";
import {
  coerceSpeedCurve,
  MAX_SPEED,
  MIN_CURVE_GAP_MS,
  MIN_SPEED,
  type SpeedPoint,
} from "../timeline/speedCurve";

const RECT = { x: 10, y: 20, w: 300, h: 120 };

function view(from = 0, to = 10_000): GraphViewport {
  return viewportFor(from, to, RECT)!;
}

describe("viewportFor", () => {
  it("shows a margin either side of the clip's window", () => {
    const v = view(2000, 12_000);
    expect(v.fromMs).toBe(2000 - 10_000 * MARGIN_FRACTION);
    expect(v.toMs).toBe(12_000 + 10_000 * MARGIN_FRACTION);
  });

  it("declines a degenerate window rather than dividing by it", () => {
    expect(viewportFor(1000, 1000, RECT)).toBeNull();
    expect(viewportFor(0, 1000, { ...RECT, w: 0 })).toBeNull();
    expect(viewportFor(Number.NaN, 1000, RECT)).toBeNull();
  });
});

describe("the vertical axis", () => {
  it("puts 1x exactly halfway, which is the whole reason it is logarithmic", () => {
    expect(speedToFraction(1)).toBeCloseTo(0.5, 12);
  });

  it("gives a halving and a doubling the same distance", () => {
    const up = speedToFraction(1) - speedToFraction(2);
    const down = speedToFraction(0.5) - speedToFraction(1);
    expect(up).toBeCloseTo(down, 12);
  });

  it("puts the two limits at the two edges", () => {
    expect(speedToFraction(MAX_SPEED)).toBeCloseTo(0, 12);
    expect(speedToFraction(MIN_SPEED)).toBeCloseTo(1, 12);
  });

  it("inverts itself", () => {
    for (const speed of [0.25, 0.4, 1, 1.7, 2, 4]) {
      expect(fractionToSpeed(speedToFraction(speed))).toBeCloseTo(speed, 9);
    }
  });

  it("clamps rather than running off the graph", () => {
    expect(speedToFraction(99)).toBe(speedToFraction(MAX_SPEED));
    expect(fractionToSpeed(-5)).toBeCloseTo(MAX_SPEED, 9);
    expect(fractionToSpeed(5)).toBeCloseTo(MIN_SPEED, 9);
  });
});

describe("toScreen and toCurve", () => {
  it("round trip", () => {
    const v = view();
    for (const point of [
      { t: 0, v: 1 },
      { t: 5000, v: 0.3 },
      { t: 9999, v: 3.9 },
    ]) {
      const at = toScreen(v, point);
      const back = toCurve(v, at.x, at.y);
      expect(back.t).toBeCloseTo(point.t, 6);
      expect(back.v).toBeCloseTo(point.v, 9);
    }
  });

  it("clamps the rate but not the instant, so a point outside the window stays reachable", () => {
    const v = view(0, 10_000);
    const outside = toCurve(v, RECT.x, RECT.y - 500);
    expect(outside.t).toBeLessThan(0);
    expect(outside.v).toBe(MAX_SPEED);
  });
});

describe("hitTest", () => {
  const points: SpeedPoint[] = [
    { t: 0, v: 1 },
    { t: 5000, v: 2 },
    { t: 10_000, v: 0.5 },
  ];

  it("finds the point under the pointer", () => {
    const v = view();
    const at = toScreen(v, points[1]);
    expect(hitTest(v, points, at.x + 2, at.y - 2)).toBe(1);
  });

  it("answers null past the radius", () => {
    const v = view();
    const at = toScreen(v, points[1]);
    expect(hitTest(v, points, at.x + HIT_RADIUS_PX + 3, at.y)).toBeNull();
  });

  it("prefers the nearer of two", () => {
    const v = view();
    const first = toScreen(v, points[0]);
    expect(hitTest(v, points, first.x + 1, first.y + 1)).toBe(0);
  });
});

describe("movePoint", () => {
  const points: SpeedPoint[] = [
    { t: 0, v: 1 },
    { t: 5000, v: 2 },
    { t: 10_000, v: 0.5 },
  ];

  it("stops against the left neighbour rather than swapping past it", () => {
    const moved = movePoint(points, 1, { t: -9999, v: 3 });
    expect(moved[1].t).toBe(MIN_CURVE_GAP_MS);
    expect(moved[0].t).toBeLessThan(moved[1].t);
  });

  it("stops against the right neighbour", () => {
    const moved = movePoint(points, 1, { t: 99_999, v: 3 });
    expect(moved[1].t).toBe(10_000 - MIN_CURVE_GAP_MS);
    expect(moved[2].t).toBeGreaterThan(moved[1].t);
  });

  it("lets the outermost points travel outside the window", () => {
    expect(movePoint(points, 0, { t: -4000, v: 1 })[0].t).toBe(-4000);
    expect(movePoint(points, 2, { t: 40_000, v: 1 })[2].t).toBe(40_000);
  });

  it("clamps the rate to the range", () => {
    expect(movePoint(points, 1, { t: 5000, v: 99 })[1].v).toBe(MAX_SPEED);
    expect(movePoint(points, 1, { t: 5000, v: -1 })[1].v).toBe(MIN_SPEED);
  });

  it("stays inside both neighbours when they are already at the minimum gap", () => {
    // `clamp(value, low, high)` with `low > high` answers `low`, which here is
    // past the right neighbour. The midpoint is the only position inside both.
    const tight: SpeedPoint[] = [
      { t: 0, v: 1 },
      { t: 5, v: 2 },
      { t: 10, v: 3 },
    ];
    const moved = movePoint(tight, 1, { t: 99_999, v: 2 });
    expect(moved[1].t).toBeGreaterThan(moved[0].t);
    expect(moved[1].t).toBeLessThan(moved[2].t);
  });

  it("is idempotent, which is what lets a drag be one undo step", () => {
    const once = movePoint(points, 1, { t: 7000, v: 3 });
    const twice = movePoint(once, 1, { t: 7000, v: 3 });
    expect(twice).toEqual(once);
  });

  it("never returns the caller's array", () => {
    expect(movePoint(points, 1, { t: 5000, v: 2 })).not.toBe(points);
    expect(movePoint(points, 9, { t: 0, v: 1 })).not.toBe(points);
  });
});

describe("insertPoint and removePoint", () => {
  const points: SpeedPoint[] = [
    { t: 0, v: 1 },
    { t: 10_000, v: 2 },
  ];

  it("inserts in sorted position", () => {
    expect(insertPoint(points, { t: 4000, v: 0.5 })?.map((p) => p.t)).toEqual([
      0, 4000, 10_000,
    ]);
  });

  it("declines a click with no room for a point", () => {
    expect(insertPoint(points, { t: MIN_CURVE_GAP_MS / 2, v: 2 })).toBeNull();
  });

  it("removes down to two points", () => {
    const three = insertPoint(points, { t: 4000, v: 3 })!;
    expect(removePoint(three, 1)?.length).toBe(2);
  });

  it("answers null when the ramp would be left with one point", () => {
    // Which the caller passes to `setClipSpeedCurve` and which flattens.
    expect(removePoint(points, 0)).toBeNull();
  });
});

describe("the presets", () => {
  it("all survive the write validator, or are the flatten", () => {
    for (const preset of SPEED_CURVE_PRESETS) {
      const built = preset.build(2000, 12_000);
      if (preset.id === "constant") {
        expect(built).toBeNull();
        continue;
      }
      expect(built).not.toBeNull();
      // The gap rule, the range and the flat test all apply to what the panel
      // writes, so a preset that would be silently altered on the way in is a
      // preset whose graph does not match what it drew.
      expect(coerceSpeedCurve(built)).toEqual(built);
    }
  });

  it("lands inside the clip's own window", () => {
    for (const preset of SPEED_CURVE_PRESETS) {
      const built = preset.build(2000, 12_000);
      for (const point of built ?? []) {
        expect(point.t).toBeGreaterThanOrEqual(2000);
        expect(point.t).toBeLessThanOrEqual(12_000);
      }
    }
  });

  it("works on a clip short enough to squeeze the gap rule", () => {
    // A 100ms clip puts the ease presets' five points 25ms apart, which is over
    // `MIN_CURVE_GAP_MS`; anything shorter is below the minimum a clip can be
    // trimmed to twice over.
    for (const preset of SPEED_CURVE_PRESETS) {
      const built = preset.build(0, 100);
      expect(coerceSpeedCurve(built)).toEqual(built);
    }
  });
});

describe("seedCurveFor", () => {
  it("is a flat pair at the clip's own rate, across its window", () => {
    expect(seedCurveFor(2000, 12_000, 1.5)).toEqual([
      { t: 2000, v: 1.5 },
      { t: 12_000, v: 1.5 },
    ]);
  });

  it("is rejected by the write validator, which is what makes arming free", () => {
    // The whole contract of the toggle: flipping it on shows a line and writes
    // nothing, so the clip does not resize and the lane does not ripple until
    // the user moves a point.
    for (const speed of [0.25, 1, 1.7, 4]) {
      expect(coerceSpeedCurve(seedCurveFor(0, 10_000, speed))).toBeNull();
    }
  });

  it("becomes a real ramp the moment one point moves", () => {
    const seed = seedCurveFor(0, 10_000, 1)!;
    const moved = movePoint(seed, 1, { t: 10_000, v: 2 });
    expect(coerceSpeedCurve(moved)).toEqual([
      { t: 0, v: 1 },
      { t: 10_000, v: 2 },
    ]);
  });

  it("clamps a rate outside the range rather than seeding an illegal curve", () => {
    expect(seedCurveFor(0, 1000, 99)?.[0].v).toBe(MAX_SPEED);
    expect(seedCurveFor(0, 1000, 0)?.[0].v).toBe(1);
    expect(seedCurveFor(0, 1000, Number.NaN)?.[0].v).toBe(1);
  });

  it("declines a window with no room for two points", () => {
    expect(seedCurveFor(0, 0, 1)).toBeNull();
    expect(seedCurveFor(0, MIN_CURVE_GAP_MS - 1, 1)).toBeNull();
    expect(seedCurveFor(Number.NaN, 1000, 1)).toBeNull();
  });
});

describe("isRampArmed", () => {
  it("is on for a clip that carries a ramp, whatever the panel thinks", () => {
    expect(isRampArmed(true, false)).toBe(true);
  });

  it("is on while the panel holds it open, so a drag to flat does not close it", () => {
    // Dragging a ramp back to flat deletes the curve. Without the local flag
    // the section would close under the pointer mid-gesture.
    expect(isRampArmed(false, true)).toBe(true);
  });

  it("is off for an untouched clip", () => {
    expect(isRampArmed(false, false)).toBe(false);
  });
});
