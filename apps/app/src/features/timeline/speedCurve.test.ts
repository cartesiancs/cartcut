/**
 * The ramp's arithmetic, checked against something that shares no code with it.
 *
 * `speedCurve.ts` integrates `1/s(t)` in closed form. The suite integrates it by
 * brute force, with a midpoint Riemann sum that knows nothing about segments,
 * logarithms or prefix sums, and requires the two to agree. That is the only way
 * to catch a ramp that is plausibly wrong rather than broken: a sign error in
 * the slope, or a segment measured from the wrong end, produces a curve that
 * still looks like a ramp and plays the wrong footage.
 */

import { describe, expect, it } from "vitest";
import {
  coerceSpeedCurve,
  curveSourceAt,
  curveSpanLength,
  derivedSpeedOf,
  mirrorSpeedCurve,
  MAX_CURVE_POINTS,
  MAX_SPEED,
  MIN_CURVE_GAP_MS,
  MIN_SPEED,
  prepareSpeedCurve,
  sameSpeedCurve,
  speedAtSource,
  speedCurveOf,
  type SpeedCurve,
  type SpeedPoint,
} from "./speedCurve";
import { seededRandom } from "./testing";

/** A clip carrying a curve, which is all `speedCurveOf` reads. */
function clip(points: SpeedPoint[]): { speedCurve: SpeedPoint[] } {
  return { speedCurve: points };
}

function curve(points: SpeedPoint[]): SpeedCurve {
  const prepared = speedCurveOf(clip(points));
  if (prepared == null) {
    throw new Error("fixture curve was rejected");
  }
  return prepared;
}

/**
 * The independent integrator: how much timeline `[from, to]` of source takes.
 *
 * Samples the speed with `speedAtSource` and never asks the module how long
 * anything is, so it shares the evaluator and nothing else. The evaluator is
 * separately pinned below against hand arithmetic.
 */
function brute(c: SpeedCurve, from: number, to: number, steps = 200_000): number {
  const h = (to - from) / steps;
  let total = 0;
  for (let i = 0; i < steps; i++) {
    total += h / speedAtSource(c, from + (i + 0.5) * h);
  }
  return total;
}

/** A random legal curve, and the window it should be measured over. */
function randomCurve(rand: () => number): {
  points: SpeedPoint[];
  from: number;
  to: number;
} {
  const count = 2 + Math.floor(rand() * 5);
  const points: SpeedPoint[] = [];
  let t = rand() * 2000;
  for (let i = 0; i < count; i++) {
    t += MIN_CURVE_GAP_MS + rand() * 3000;
    points.push({ t, v: MIN_SPEED + rand() * (MAX_SPEED - MIN_SPEED) });
  }
  // Deliberately reaches outside the points at both ends, which is where the
  // hold rule lives and where a transition actually asks.
  const from = points[0].t - rand() * 1000;
  const to = points[count - 1].t + rand() * 1000;
  return { points, from, to };
}

describe("speedAtSource", () => {
  it("interpolates linearly between two points", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 3 },
    ]);
    expect(speedAtSource(c, 0)).toBeCloseTo(1, 12);
    expect(speedAtSource(c, 500)).toBeCloseTo(2, 12);
    expect(speedAtSource(c, 1000)).toBeCloseTo(3, 12);
  });

  it("holds its end values outside the outermost points", () => {
    const c = curve([
      { t: 1000, v: 0.5 },
      { t: 2000, v: 2 },
    ]);
    expect(speedAtSource(c, -5000)).toBe(0.5);
    expect(speedAtSource(c, 0)).toBe(0.5);
    expect(speedAtSource(c, 99_999)).toBe(2);
  });

  it("finds the right segment with more than two points", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 4 },
      { t: 2000, v: 1 },
      { t: 3000, v: 0.25 },
    ]);
    expect(speedAtSource(c, 500)).toBeCloseTo(2.5, 12);
    expect(speedAtSource(c, 1500)).toBeCloseTo(2.5, 12);
    expect(speedAtSource(c, 2500)).toBeCloseTo(0.625, 12);
  });
});

describe("curveSpanLength", () => {
  it("matches the analytic answer for one linear segment", () => {
    // s(t) = 1 + t/10000 over [0, 10000] integrates to 10000 * ln(2).
    const c = curve([
      { t: 0, v: 1 },
      { t: 10_000, v: 2 },
    ]);
    expect(curveSpanLength(c, 0, 10_000)).toBeCloseTo(10_000 * Math.LN2, 6);
  });

  it("is plain division on a flat stretch, which is where a 1x clip lives", () => {
    const c = curve([
      { t: 0, v: 2 },
      { t: 1000, v: 2.5 },
    ]);
    // Entirely before the first point, so the held 2x governs.
    expect(curveSpanLength(c, -3000, 0)).toBeCloseTo(1500, 9);
  });

  it("agrees with a brute-force integral over random curves", () => {
    const rand = seededRandom(0x5eed);
    for (let i = 0; i < 40; i++) {
      const { points, from, to } = randomCurve(rand);
      const c = curve(points);
      const closed = curveSpanLength(c, from, to);
      const numeric = brute(c, from, to);
      expect(Math.abs(closed - numeric) / numeric).toBeLessThan(1e-6);
    }
  });

  it("is additive, which is what makes a split reconstruct", () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 200; i++) {
      const { points, from, to } = randomCurve(rand);
      const c = curve(points);
      const mid = from + (to - from) * rand();
      const whole = curveSpanLength(c, from, to);
      const parts = curveSpanLength(c, from, mid) + curveSpanLength(c, mid, to);
      expect(Math.abs(whole - parts)).toBeLessThan(1e-9 * Math.abs(whole) + 1e-9);
    }
  });

  it("is signed, so walking backwards is the negative of walking forwards", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 4000, v: 4 },
    ]);
    expect(curveSpanLength(c, 3000, 500)).toBeCloseTo(
      -curveSpanLength(c, 500, 3000),
      9,
    );
  });

  it("stays exact for a spread just above the flat threshold", () => {
    // Anything narrower is read as a constant rate, so this is the narrowest
    // ramp the evaluator is ever handed.
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 1 + 2e-9 },
    ]);
    expect(Math.abs(curveSpanLength(c, 0, 1000) - 1000)).toBeLessThan(1e-5);
  });

  it("stays exact for a width that is a sliver of a steep segment", () => {
    // Where `log1p` earns its place. On this segment `Math.log((s0 + m*w)/s0)/m`
    // is out by 6.5e-8 relative at a width of one nanosecond, because `1 + x`
    // has already thrown away the digits that carry the answer.
    const c = curve([
      { t: 0, v: MIN_SPEED },
      { t: MIN_CURVE_GAP_MS, v: MAX_SPEED },
    ]);
    for (const w of [1e-6, 1e-9, 1e-12]) {
      const exact = (w / MIN_SPEED) * (1 - (((MAX_SPEED - MIN_SPEED) / MIN_CURVE_GAP_MS) * w) / MIN_SPEED / 2);
      const measured = curveSpanLength(c, 0, w);
      expect(Math.abs(measured - exact) / exact).toBeLessThan(1e-10);
    }
  });

  it("handles the steepest segment the format allows", () => {
    const c = curve([
      { t: 0, v: MIN_SPEED },
      { t: MIN_CURVE_GAP_MS, v: MAX_SPEED },
    ]);
    const closed = curveSpanLength(c, 0, MIN_CURVE_GAP_MS);
    expect(Math.abs(closed - brute(c, 0, MIN_CURVE_GAP_MS)) / closed).toBeLessThan(1e-6);
  });
});

describe("curveSourceAt", () => {
  it("inverts curveSpanLength", () => {
    const rand = seededRandom(0xc0ffee);
    for (let i = 0; i < 300; i++) {
      const { points, from, to } = randomCurve(rand);
      const c = curve(points);
      const u = curveSpanLength(c, from, to);
      const back = curveSourceAt(c, from, u);
      expect(Math.abs(back - to)).toBeLessThan(1e-6);
    }
  });

  it("round trips backwards too, which is what a transition asks for", () => {
    const rand = seededRandom(11);
    for (let i = 0; i < 200; i++) {
      const { points, from, to } = randomCurve(rand);
      const c = curve(points);
      const u = curveSpanLength(c, to, from);
      expect(Math.abs(curveSourceAt(c, to, u) - from)).toBeLessThan(1e-6);
    }
  });

  it("extrapolates past both ends at the held rate", () => {
    const c = curve([
      { t: 1000, v: 2 },
      { t: 2000, v: 0.5 },
    ]);
    expect(curveSourceAt(c, 1000, -500)).toBeCloseTo(0, 9);
    expect(curveSourceAt(c, 2000, 1000)).toBeCloseTo(2500, 9);
  });

  it("stays exact for a sliver of timeline on a steep segment", () => {
    // The `expm1` twin of the `log1p` case above: the naive form is out by
    // 8.9e-5 relative at a timeline width of one picosecond.
    const c = curve([
      { t: 0, v: MIN_SPEED },
      { t: MIN_CURVE_GAP_MS, v: MAX_SPEED },
    ]);
    const m = (MAX_SPEED - MIN_SPEED) / MIN_CURVE_GAP_MS;
    for (const u of [1e-9, 1e-12]) {
      const exact = MIN_SPEED * u * (1 + (m * u) / 2);
      expect(Math.abs(curveSourceAt(c, 0, u) - exact) / exact).toBeLessThan(1e-12);
    }
  });

  it("is the identity at zero", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 3 },
    ]);
    expect(curveSourceAt(c, 456, 0)).toBeCloseTo(456, 12);
  });
});

describe("derivedSpeedOf", () => {
  it("is the rate that gives the clip the length the curve asks for", () => {
    const points = [
      { t: 0, v: 1 },
      { t: 10_000, v: 2 },
    ];
    const c = curve(points);
    const speed = derivedSpeedOf(c, 0, 10_000, 10_000);
    expect(speed).not.toBeNull();
    // `duration / speed` has to be the integral, which is the whole point.
    expect(10_000 / (speed as number)).toBeCloseTo(10_000 * Math.LN2, 6);
  });

  it("stays inside the range every rate in the project lives in", () => {
    const rand = seededRandom(99);
    for (let i = 0; i < 300; i++) {
      const { points } = randomCurve(rand);
      const c = curve(points);
      const from = points[0].t;
      const to = points[points.length - 1].t;
      const speed = derivedSpeedOf(c, from, to, to - from);
      expect(speed).not.toBeNull();
      expect(speed as number).toBeGreaterThanOrEqual(MIN_SPEED);
      expect(speed as number).toBeLessThanOrEqual(MAX_SPEED);
    }
  });

  it("declines rather than writing a NaN into every span in the document", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    expect(derivedSpeedOf(c, 500, 500, 0)).toBeNull();
    expect(derivedSpeedOf(c, 500, 400, 100)).toBeNull();
    expect(derivedSpeedOf(c, 0, 1000, Number.NaN)).toBeNull();
  });
});

describe("speedCurveOf", () => {
  it("answers null for a clip with no curve", () => {
    expect(speedCurveOf({})).toBeNull();
    expect(speedCurveOf(null)).toBeNull();
    expect(speedCurveOf({ speedCurve: undefined })).toBeNull();
    expect(speedCurveOf({ speedCurve: "2x please" })).toBeNull();
  });

  it("drops entries that could not be evaluated", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: 0, v: 1 },
        { t: Number.NaN, v: 2 },
        { t: 500, v: Number.POSITIVE_INFINITY },
        { t: 1000, v: 2 },
        null,
        "nope",
      ],
    });
    expect(c?.points.map((p) => p.t)).toEqual([0, 1000]);
  });

  it("clamps an out-of-range rate rather than dropping the point", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: 0, v: 8 },
        { t: 1000, v: 0.01 },
      ],
    });
    expect(c?.points.map((p) => p.v)).toEqual([MAX_SPEED, MIN_SPEED]);
  });

  it("sorts a list somebody wrote out of order", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: 1000, v: 2 },
        { t: 0, v: 1 },
      ],
    });
    expect(c?.points.map((p) => p.t)).toEqual([0, 1000]);
  });

  it("keeps the first of a duplicated instant, which has no slope", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: 0, v: 1 },
        { t: 0, v: 3 },
        { t: 1000, v: 2 },
      ],
    });
    expect(c?.points).toEqual([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    expect(Number.isFinite(curveSpanLength(c as SpeedCurve, 0, 1000))).toBe(true);
  });

  it("keeps points closer than the write gap, because a read must not move them", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: 0, v: 1 },
        { t: 1, v: 2 },
      ],
    });
    expect(c?.points.length).toBe(2);
  });

  it("reads a flat curve as no curve at all", () => {
    expect(
      speedCurveOf({
        speedCurve: [
          { t: 0, v: 2 },
          { t: 1000, v: 2 },
        ],
      }),
    ).toBeNull();
  });

  it("answers null when fewer than two points survive", () => {
    expect(speedCurveOf({ speedCurve: [{ t: 0, v: 2 }] })).toBeNull();
    expect(
      speedCurveOf({ speedCurve: [{ t: 0, v: 2 }, { t: Number.NaN, v: 1 }] }),
    ).toBeNull();
  });

  it("keeps points outside the trim window, which is what makes a trim reversible", () => {
    const c = speedCurveOf({
      speedCurve: [
        { t: -5000, v: 1 },
        { t: 50_000, v: 4 },
      ],
    });
    expect(c?.points.map((p) => p.t)).toEqual([-5000, 50_000]);
  });

  it("builds prefix integrals that start at zero and increase", () => {
    const c = curve([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
      { t: 2000, v: 0.5 },
    ]);
    expect(c.cum[0]).toBe(0);
    expect(c.cum[1]).toBeGreaterThan(0);
    expect(c.cum[2]).toBeGreaterThan(c.cum[1]);
    expect(c.cum[2]).toBeCloseTo(curveSpanLength(c, 0, 2000), 9);
  });
});

describe("coerceSpeedCurve", () => {
  it("enforces the minimum gap a read guard leaves alone", () => {
    const points = coerceSpeedCurve([
      { t: 0, v: 1 },
      { t: 1, v: 3 },
      { t: 1000, v: 2 },
    ]);
    expect(points?.map((p) => p.t)).toEqual([0, 1000]);
  });

  it("caps the point count", () => {
    const many = Array.from({ length: MAX_CURVE_POINTS + 20 }, (_, i) => ({
      t: i * 100,
      v: 1 + (i % 2),
    }));
    expect(coerceSpeedCurve(many)?.length).toBe(MAX_CURVE_POINTS);
  });

  it("clamps rather than rejecting, so a drag off the graph stops at the limit", () => {
    expect(
      coerceSpeedCurve([
        { t: 0, v: 99 },
        { t: 1000, v: -4 },
      ]),
    ).toEqual([
      { t: 0, v: MAX_SPEED },
      { t: 1000, v: MIN_SPEED },
    ]);
  });

  it("answers null for a flat curve, which is how the key gets deleted", () => {
    expect(
      coerceSpeedCurve([
        { t: 0, v: 1 },
        { t: 1000, v: 1 },
      ]),
    ).toBeNull();
    expect(coerceSpeedCurve([])).toBeNull();
    expect(coerceSpeedCurve(null)).toBeNull();
  });

  it("never hands back the caller's own array or its objects", () => {
    const point = { t: 0, v: 1 };
    const input = [point, { t: 1000, v: 2 }];
    const out = coerceSpeedCurve(input);
    expect(out).not.toBe(input);
    expect(out?.[0]).not.toBe(point);
  });

  it("does not round, following coerceSpeed", () => {
    expect(
      coerceSpeedCurve([
        { t: 0.5, v: 1.733333333 },
        { t: 1000.25, v: 2 },
      ]),
    ).toEqual([
      { t: 0.5, v: 1.733333333 },
      { t: 1000.25, v: 2 },
    ]);
  });
});

describe("sameSpeedCurve", () => {
  const a = [
    { t: 0, v: 1 },
    { t: 1000, v: 2 },
  ];

  it("answers true for two clips with no curve", () => {
    expect(sameSpeedCurve(undefined, undefined)).toBe(true);
    expect(sameSpeedCurve(null, [])).toBe(true);
  });

  it("refuses when exactly one side carries a ramp", () => {
    expect(sameSpeedCurve(a, undefined)).toBe(false);
    expect(sameSpeedCurve(undefined, a)).toBe(false);
  });

  it("accepts a copy that has been through JSON", () => {
    expect(sameSpeedCurve(a, JSON.parse(JSON.stringify(a)))).toBe(true);
  });

  it("refuses a different shape", () => {
    expect(sameSpeedCurve(a, [{ t: 0, v: 1 }, { t: 1000, v: 2.5 }])).toBe(false);
    expect(
      sameSpeedCurve(a, [{ t: 0, v: 1 }, { t: 500, v: 1.5 }, { t: 1000, v: 2 }]),
    ).toBe(false);
  });
});

describe("mirrorSpeedCurve", () => {
  it("reflects the times, keeps the rates, and comes back sorted", () => {
    expect(
      mirrorSpeedCurve(
        [
          { t: 1000, v: 1 },
          { t: 3000, v: 4 },
        ],
        4000,
      ),
    ).toEqual([
      { t: 1000, v: 4 },
      { t: 3000, v: 1 },
    ]);
  });

  it("is an involution, which is what makes unreverse need no bookkeeping", () => {
    const rand = seededRandom(4242);
    for (let i = 0; i < 100; i++) {
      const { points } = randomCurve(rand);
      const about = rand() * 20_000;
      const back = mirrorSpeedCurve(mirrorSpeedCurve(points, about), about);
      back.forEach((point, index) => {
        expect(Math.abs(point.t - points[index].t)).toBeLessThan(1e-9);
        expect(point.v).toBe(points[index].v);
      });
    }
  });

  it("leaves the window's length alone, which pins the axis", () => {
    const rand = seededRandom(31337);
    for (let i = 0; i < 100; i++) {
      const { points } = randomCurve(rand);
      const from = points[0].t;
      const to = points[points.length - 1].t;
      const before = curveSpanLength(prepareSpeedCurve(points), from, to);
      const mirrored = mirrorSpeedCurve(points, to);
      const after = curveSpanLength(
        prepareSpeedCurve(mirrored),
        to - to,
        to - from,
      );
      expect(Math.abs(before - after)).toBeLessThan(1e-6);
    }
  });
});

describe("the harness measures something", () => {
  it("the brute-force integrator disagrees when handed a different curve", () => {
    const ramp = curve([
      { t: 0, v: 1 },
      { t: 10_000, v: 2 },
    ]);
    const other = curve([
      { t: 0, v: 1 },
      { t: 10_000, v: 3 },
    ]);
    expect(
      Math.abs(curveSpanLength(ramp, 0, 10_000) - brute(other, 0, 10_000)),
    ).toBeGreaterThan(1);
  });
});
