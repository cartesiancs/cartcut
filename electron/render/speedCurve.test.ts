/**
 * The two copies of the ramp's arithmetic, held to bit equality.
 *
 * `electron/render/speedCurve.ts` exists because `electron/` may not import
 * `apps/app/src`. A copy that drifts would composite the picture from one time
 * map and stretch the sound with another, and the export would be the only
 * place it showed, on ramped clips only, as sound sliding against picture. So
 * the suite imports both and requires `Object.is` rather than a tolerance:
 * anything short of identical is a divergence that will grow.
 */

import { describe, expect, it } from "vitest";
import * as main from "./speedCurve";
import * as renderer from "../../apps/app/src/features/timeline/speedCurve";
import { seededRandom } from "../../apps/app/src/features/timeline/testing";

function randomPoints(rand: () => number): main.SpeedPoint[] {
  const count = 2 + Math.floor(rand() * 6);
  const points: main.SpeedPoint[] = [];
  let t = rand() * 3000;
  for (let i = 0; i < count; i++) {
    t += 10 + rand() * 4000;
    points.push({
      t,
      v: main.MIN_SPEED + rand() * (main.MAX_SPEED - main.MIN_SPEED),
    });
  }
  return points;
}

describe("the main-process copy of the ramp maths", () => {
  it("states the same limits", () => {
    expect(main.MIN_SPEED).toBe(renderer.MIN_SPEED);
    expect(main.MAX_SPEED).toBe(renderer.MAX_SPEED);
    expect(main.FLAT_SPEED_EPSILON).toBe(renderer.FLAT_SPEED_EPSILON);
    expect(main.MAX_CURVE_POINTS).toBe(renderer.MAX_CURVE_POINTS);
  });

  it("reads the same curve off an element", () => {
    const rand = seededRandom(17);
    for (let i = 0; i < 200; i++) {
      const element = { speedCurve: randomPoints(rand) };
      expect(main.speedCurveOf(element)?.points).toEqual(
        renderer.speedCurveOf(element)?.points,
      );
      expect(main.speedCurveOf(element)?.cum).toEqual(
        renderer.speedCurveOf(element)?.cum,
      );
    }
  });

  it("agrees on what a clip with no ramp is", () => {
    for (const element of [
      {},
      { speedCurve: undefined },
      { speedCurve: [] },
      { speedCurve: [{ t: 0, v: 2 }] },
      { speedCurve: [{ t: 0, v: 2 }, { t: 1000, v: 2 }] },
      { speedCurve: "nope" },
    ]) {
      expect(main.speedCurveOf(element)).toBe(null);
      expect(renderer.speedCurveOf(element)).toBe(null);
    }
  });

  it("answers bit for bit over ten thousand queries", () => {
    const rand = seededRandom(0xbeef);
    let checked = 0;
    for (let i = 0; i < 1000; i++) {
      const points = randomPoints(rand);
      const a = main.prepareSpeedCurve(points);
      const b = renderer.prepareSpeedCurve(points);
      const first = points[0].t;
      const last = points[points.length - 1].t;

      for (let q = 0; q < 10; q++) {
        // Deliberately reaches outside the points at both ends, which is where
        // the hold rule lives and where a transition actually asks.
        const from = first - 2000 + rand() * (last - first + 4000);
        const delta = (rand() - 0.5) * 8000;

        expect(
          Object.is(main.speedAtSource(a, from), renderer.speedAtSource(b, from)),
        ).toBe(true);
        expect(
          Object.is(
            main.curveSpanLength(a, first, from),
            renderer.curveSpanLength(b, first, from),
          ),
        ).toBe(true);
        expect(
          Object.is(
            main.curveSourceAt(a, from, delta),
            renderer.curveSourceAt(b, from, delta),
          ),
        ).toBe(true);
        checked += 3;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});
