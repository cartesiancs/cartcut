/**
 * The camera path, and the two properties the picture depends on.
 *
 * The one that matters most is that **no background shows once the picture is
 * meant to cover the frame**, at every aspect and every instant, including part
 * way through an ease. That is the bug `safeAimScale` exists for, and it is
 * invisible in any fixture whose capture and frame share an aspect.
 */
import { describe, it, expect } from "vitest";
import { springPosition, criticalDamping } from "../motion/spring";
import {
  DEAD_ZONE,
  decimate,
  followTarget,
  referencePose,
  runCamera,
  coverCrossing,
  easedTime,
  SMOOTHSTEP_EASING,
  splitSmoothstep,
  springStep,
  type CameraInstant,
} from "./zoomCamera";
import { recordBox, recordFit, type Size } from "./recordFit";
import { planZoom, smoothstep, type CursorSample, type PointerMark } from "./zoomPlan";

const FRAME: Size = { width: 1920, height: 1080 };
const LAPTOP: Size = { width: 3024, height: 1964 };
const ULTRAWIDE: Size = { width: 3440, height: 1440 };
const MATCHING: Size = { width: 3840, height: 2160 };

const CAPTURES = [LAPTOP, ULTRAWIDE, MATCHING];

function still(x: number, y: number, fromMs: number, durationMs: number) {
  const samples: CursorSample[] = [];
  for (let t = fromMs; t <= fromMs + durationMs; t += 33) {
    samples.push({ t, x, y });
  }
  return samples;
}

describe("springStep", () => {
  const stiffness = 26;
  const damping = criticalDamping({ stiffness });

  /** The largest gap between the stepper and the closed form over one second. */
  function stepError(hz: number): number {
    const dt = 1 / hz;
    const state = { x: 0, velocity: 0 };
    let worst = 0;

    for (let index = 1; index <= hz; index += 1) {
      springStep(state, 1, dt);
      worst = Math.max(
        worst,
        Math.abs(state.x - springPosition({ stiffness, damping }, index * dt)),
      );
    }

    return worst;
  }

  // Checked against something that shares no code with it: `spring.ts` answers the
  // step response in closed form from the characteristic equation, and this walks
  // it forward one dt at a time. Exact, not approximate, because the per-step
  // solution for a constant target is itself closed form.
  it("reproduces the closed-form step response exactly", () => {
    expect(stepError(120)).toBeLessThan(1e-9);
  });

  it("is independent of the rate it is stepped at", () => {
    // What says it is a solution rather than an integration: a coarser step must
    // land in the same place, which is false of any Euler scheme.
    expect(stepError(15)).toBeLessThan(1e-9);
    expect(stepError(960)).toBeLessThan(1e-9);
  });

  it("would notice if the two disagreed", () => {
    // Proving the harness measures something: against a different spring the
    // comparison above has to fail, or the tolerance is doing the asserting.
    const state = { x: 0, velocity: 0 };
    for (let index = 1; index <= 60; index += 1) {
      springStep(state, 1, 1 / 120);
    }
    const wrong = springPosition({ stiffness: 200, damping }, 60 / 120);
    expect(Math.abs(state.x - wrong)).toBeGreaterThan(0.01);
  });

  it("settles on a target it is given and stays there", () => {
    const state = { x: 0.2, velocity: 0 };
    for (let index = 0; index < 600; index += 1) {
      springStep(state, 0.7, 1 / 120);
    }
    expect(state.x).toBeCloseTo(0.7, 6);
    expect(state.velocity).toBeCloseTo(0, 6);
  });

  it("never overshoots, being critically damped", () => {
    const state = { x: 0, velocity: 0 };
    for (let index = 0; index < 600; index += 1) {
      springStep(state, 1, 1 / 120);
      expect(state.x).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe("followTarget", () => {
  const fit = recordFit(LAPTOP, FRAME);

  it("does not move while the cursor is inside the dead zone", () => {
    const aim = { u: 0.5, v: 0.5 };
    // Well inside: the cursor a few percent off centre must produce no motion at
    // all, which is what stops the picture swimming on a hand tremor.
    const target = followTarget(aim, { u: 0.52, v: 0.51 }, fit, FRAME, 1.5);
    expect(target).toEqual(aim);
  });

  it("moves just enough to put the cursor back on the dead-zone edge", () => {
    const aim = { u: 0.5, v: 0.5 };
    const cursor = { u: 0.9, v: 0.5 };
    const target = followTarget(aim, cursor, fit, FRAME, 1.5);

    const half = FRAME.width / (2 * fit.cover.width * 1.5);
    expect(target.u).toBeCloseTo(cursor.u - half * DEAD_ZONE, 9);
    expect(target.u).toBeLessThan(cursor.u);
    expect(target.u).toBeGreaterThan(aim.u);
  });

  it("follows in both directions", () => {
    const aim = { u: 0.5, v: 0.5 };
    expect(followTarget(aim, { u: 0.1, v: 0.5 }, fit, FRAME, 1.5).u).toBeLessThan(0.5);
    expect(followTarget(aim, { u: 0.9, v: 0.5 }, fit, FRAME, 1.5).u).toBeGreaterThan(0.5);
  });
});

describe("coverCrossing", () => {
  it("is where the zoom reaches cover, in eased units", () => {
    // A quarter of the way in eased terms for a base of 0.8 and a zoom of 1.6.
    expect(coverCrossing(0.8, 1.6)).toBeCloseTo(0.25, 9);
    // Deeper zoom, earlier crossing.
    expect(coverCrossing(0.8, 2.4)!).toBeLessThan(coverCrossing(0.8, 1.6)!);
  });

  it("is nothing when the picture already covers at rest", () => {
    // A capture matching the frame with no padding: there is no crossing and no
    // extra instant to insert.
    expect(coverCrossing(1, 1.9)).toBeNull();
    expect(coverCrossing(1.2, 1.9)).toBeNull();
  });

  it("is nothing when there is no zoom to cross with", () => {
    expect(coverCrossing(0.8, 1)).toBeNull();
  });
});

describe("easedTime", () => {
  it("inverts smoothstep", () => {
    for (const p of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      expect(easedTime(smoothstep(p))).toBeCloseTo(p, 9);
    }
  });

  it("pins both ends", () => {
    expect(easedTime(0)).toBe(0);
    expect(easedTime(1)).toBe(1);
    expect(easedTime(-1)).toBe(0);
    expect(easedTime(2)).toBe(1);
  });
});

describe("runCamera", () => {
  it("starts and ends at the resting pose", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const cursor = still(600, 600, 1000, 3000);
    const segments = planZoom({ cursor, pointer: [] }, LAPTOP, "on", 9000);

    const path = runCamera(segments, cursor, LAPTOP, fit, FRAME, 9000);

    expect(path[0]).toMatchObject({ t: 0, z: fit.base, u: 0.5, v: 0.5 });
    const last = path[path.length - 1];
    expect(last.t).toBe(9000);
    expect(last.z).toBe(fit.base);
    expect(last.u).toBe(0.5);
    expect(last.v).toBe(0.5);
  });

  it("rests for the whole clip when there is nothing to zoom at", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const path = runCamera([], [], LAPTOP, fit, FRAME, 5000);
    expect(path.length).toBe(2);
    expect(path.every((instant) => instant.z === fit.base)).toBe(true);
  });

  it("stays zoomed between two moves that touch", () => {
    // The pulsing this exists to stop: back-to-back moves would otherwise release
    // fully to the resting pose and start straight back in, once per click.
    const fit = recordFit(LAPTOP, FRAME);
    const pointer: PointerMark[] = [
      { t: 2000, x: 500, y: 500, kind: "down" },
      { t: 4200, x: 2500, y: 1500, kind: "down" },
    ];
    const segments = planZoom({ cursor: [], pointer }, LAPTOP, "on", 14_000);
    expect(segments.length).toBe(2);
    expect(segments[1].inStart - segments[0].outEnd).toBeLessThanOrEqual(250);

    const path = runCamera(segments, [], LAPTOP, fit, FRAME, 14_000);

    // Between the first move's hold and the second's, nothing returns to rest.
    const inside = path.filter(
      (i) => i.t > segments[0].inEnd && i.t < segments[1].outStart,
    );
    expect(inside.length).toBeGreaterThan(0);
    for (const instant of inside) {
      expect(instant.z).toBeGreaterThanOrEqual(1);
    }

    // ...and the aim really does travel between the two framings.
    const us = inside.map((i) => i.u);
    expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(0.1);
  });

  it("puts a flush crossing instant in both eases", () => {
    // The instant the argument in the header turns on: exactly as wide as the frame,
    // exactly centred, so every leg after it covers and every leg before it is
    // legitimately inset.
    const fit = recordFit(LAPTOP, FRAME);
    const cursor = still(600, 600, 1000, 3000);
    const segments = planZoom({ cursor, pointer: [] }, LAPTOP, "on", 9000);
    const path = runCamera(segments, cursor, LAPTOP, fit, FRAME, 9000);

    const flush = path.filter((instant) => instant.z === 1);
    expect(flush.length).toBe(segments.length * 2);
    for (const instant of flush) {
      expect(instant.u).toBe(0.5);
      expect(instant.v).toBe(0.5);
      const box = recordBox(fit, FRAME, instant.z, instant.u, instant.v);
      expect(box.x).toBeCloseTo(0, 6);
      expect(box.width).toBeCloseTo(FRAME.width, 6);
    }
  });

  it("carries a curve, not a straight line, out of the resting pose", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const cursor = still(600, 600, 1000, 3000);
    const segments = planZoom({ cursor, pointer: [] }, LAPTOP, "on", 9000);
    const path = runCamera(segments, cursor, LAPTOP, fit, FRAME, 9000);

    for (const segment of segments) {
      const easeIn = path.find((instant) => instant.t === segment.inStart);
      expect(Array.isArray(easeIn?.easing)).toBe(true);
    }
  });

  it("subdivides smoothstep without changing it", () => {
    // De Casteljau, so the two pieces trace the curve they were cut from. Checked
    // against `smoothstep` itself, which the subdivision does not use.
    for (const at of [0.15, 0.4, 0.62, 0.88]) {
      const { before, after } = splitSmoothstep(at);
      expect(Array.isArray(before)).toBe(true);
      expect(Array.isArray(after)).toBe(true);

      const value = smoothstep(at);

      // A cubic bezier easing with `x(u) = u` for its abscissae evaluates as its own
      // y-polynomial; for a general one, solve x then read y.
      const evaluate = (easing: number[], t: number) => {
        const [x1, y1, x2, y2] = easing;
        let u = t;
        for (let index = 0; index < 40; index += 1) {
          const x =
            3 * u * (1 - u) * (1 - u) * x1 + 3 * u * u * (1 - u) * x2 + u * u * u;
          const dx =
            3 * (1 - u) * (1 - u) * x1 +
            6 * u * (1 - u) * (x2 - x1) +
            3 * u * u * (1 - x2);
          if (Math.abs(dx) < 1e-12) break;
          u = Math.min(1, Math.max(0, u - (x - t) / dx));
        }
        return 3 * u * (1 - u) * (1 - u) * y1 + 3 * u * u * (1 - u) * y2 + u * u * u;
      };

      for (const p of [0.2, 0.5, 0.8]) {
        expect(evaluate(before as number[], p) * value).toBeCloseTo(
          smoothstep(at * p),
          4,
        );
        expect(value + evaluate(after as number[], p) * (1 - value)).toBeCloseTo(
          smoothstep(at + (1 - at) * p),
          4,
        );
      }
    }
  });

  // THE property. Every aspect, every instant of every ease, every hold.
  it("never shows background once the picture should cover the frame", () => {
    for (const capture of CAPTURES) {
      const fit = recordFit(capture, FRAME);

      for (const strength of ["on"] as const) {
        // A click in a corner is the worst case: the deepest zoom aimed at the
        // least reachable point.
        for (const [cx, cy] of [
          [capture.width * 0.05, capture.height * 0.05],
          [capture.width * 0.95, capture.height * 0.95],
          [capture.width * 0.5, capture.height * 0.05],
          [capture.width * 0.5, capture.height * 0.5],
        ]) {
          const pointer: PointerMark[] = [{ t: 2000, x: cx, y: cy, kind: "down" }];
          const segments = planZoom({ cursor: [], pointer }, capture, strength, 9000);
          expect(segments.length).toBeGreaterThan(0);

          // Reconstructed the way the renderer will: linearly between instants for
          // a linear easing, and on smoothstep for the eases.
          const path = runCamera(segments, [], capture, fit, FRAME, 9000);

          for (let index = 1; index < path.length; index += 1) {
            const a = path[index - 1];
            const b = path[index];
            const shape = a.easing === "linear" ? (p: number) => p : smoothstep;

            for (let step = 0; step <= 24; step += 1) {
              const p = shape(step / 24);
              const z = a.z + (b.z - a.z) * p;
              if (z < 1) {
                continue;
              }
              const box = recordBox(
                fit,
                FRAME,
                z,
                a.u + (b.u - a.u) * p,
                a.v + (b.v - a.v) * p,
              );

              expect(box.x).toBeLessThanOrEqual(0.5);
              expect(box.y).toBeLessThanOrEqual(0.5);
              expect(box.x + box.width).toBeGreaterThanOrEqual(FRAME.width - 0.5);
              expect(box.y + box.height).toBeGreaterThanOrEqual(FRAME.height - 0.5);
            }
          }
        }
      }
    }
  });

  it("stays sparse enough to be keyframes a person could edit", () => {
    // Three minutes with a click every four seconds, which is busier than any real
    // demo. The write path is O(instants^2) in document copies, so this is a
    // performance assertion as much as a taste one.
    const fit = recordFit(LAPTOP, FRAME);
    const pointer: PointerMark[] = [];
    const cursor: CursorSample[] = [];
    for (let index = 0; index < 45; index += 1) {
      const t = index * 4000 + 500;
      const x = 300 + (index % 7) * 350;
      const y = 300 + (index % 5) * 300;
      pointer.push({ t, x, y, kind: "down" });
      cursor.push(...still(x, y, t, 1500));
    }

    const segments = planZoom({ cursor, pointer }, LAPTOP, "on", 180_000);
    const path = runCamera(segments, cursor, LAPTOP, fit, FRAME, 180_000);

    expect(segments.length).toBeGreaterThan(10);
    // Per segment is the quantity that matters: four instants of structure plus a
    // decimated follow. Thousands would make the write path quadratic and the
    // result unreadable in the curve editor.
    expect(path.length / segments.length).toBeLessThan(20);
  });

  it("follows a cursor that leaves the framing during a hold", () => {
    const fit = recordFit(LAPTOP, FRAME);
    // Settle in one place, earn a zoom, then drag right across the screen.
    const cursor = [
      ...still(600, 900, 0, 1500),
      ...still(2600, 900, 2000, 3000),
    ];
    const segments = planZoom({ cursor, pointer: [] }, LAPTOP, "on", 12_000);
    expect(segments.length).toBeGreaterThan(0);

    const followed = runCamera(segments, cursor, LAPTOP, fit, FRAME, 12_000);
    const held = runCamera(segments, cursor, LAPTOP, fit, FRAME, 12_000, {
      tolerancePx: 1e9,
    });

    const spread = (path: CameraInstant[]) =>
      Math.max(...path.map((i) => i.u)) - Math.min(...path.map((i) => i.u));

    // The followed path visits more of the capture than the crudely decimated one,
    // which is the whole observable difference the follow makes.
    expect(spread(followed)).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(followed.length);
  });
});

describe("decimate", () => {
  const fit = recordFit(LAPTOP, FRAME);

  it("keeps the ends and drops a straight run between them", () => {
    const samples: CameraInstant[] = [];
    for (let index = 0; index <= 100; index += 1) {
      samples.push({
        t: index * 10,
        z: 1.5,
        u: 0.3 + (index / 100) * 0.2,
        v: 0.5,
        easing: "linear",
      });
    }

    const kept = decimate(samples, fit, FRAME);
    expect(kept[0]).toEqual(samples[0]);
    expect(kept[kept.length - 1]).toEqual(samples[samples.length - 1]);
    expect(kept.length).toBeLessThan(6);
  });

  it("holds the error inside the tolerance it was given", () => {
    const samples: CameraInstant[] = [];
    for (let index = 0; index <= 200; index += 1) {
      const p = index / 200;
      samples.push({
        t: index * 5,
        z: 1.5,
        u: 0.5 + 0.15 * Math.sin(p * Math.PI * 3),
        v: 0.5 + 0.05 * Math.cos(p * Math.PI * 5),
        easing: "linear",
      });
    }

    const tolerance = 1;
    const kept = decimate(samples, fit, FRAME, tolerance);
    expect(kept.length).toBeLessThan(samples.length);

    // Every original sample is within tolerance of the kept polyline.
    for (const sample of samples) {
      let index = 0;
      while (index + 1 < kept.length && kept[index + 1].t < sample.t) index += 1;
      const a = kept[index];
      const b = kept[Math.min(index + 1, kept.length - 1)];
      const span = b.t - a.t;
      const p = span > 0 ? (sample.t - a.t) / span : 0;

      const guessed = recordBox(fit, FRAME, a.z, a.u + (b.u - a.u) * p, a.v + (b.v - a.v) * p);
      const actual = recordBox(fit, FRAME, sample.z, sample.u, sample.v);

      expect(Math.abs(guessed.x - actual.x)).toBeLessThanOrEqual(tolerance + 1e-6);
      expect(Math.abs(guessed.y - actual.y)).toBeLessThanOrEqual(tolerance + 1e-6);
    }
  });
});

describe("referencePose", () => {
  it("rests outside every segment and reaches full zoom inside one", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const pointer: PointerMark[] = [{ t: 2000, x: 1500, y: 1000, kind: "down" }];
    const segments = planZoom({ cursor: [], pointer }, LAPTOP, "on", 9000);
    const [segment] = segments;

    expect(referencePose(segments, fit, FRAME, 0).z).toBeCloseTo(fit.base, 9);
    expect(referencePose(segments, fit, FRAME, 8900).z).toBeCloseTo(fit.base, 9);
    expect(
      referencePose(segments, fit, FRAME, (segment.inEnd + segment.outStart) / 2).z,
    ).toBeCloseTo(segment.zoom, 9);
  });
});
