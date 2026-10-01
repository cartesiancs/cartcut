import { describe, expect, it } from "vitest";
import { LIFT, LIFT_DURATION_MS, liftInsetAt, liftScale } from "./liftPulse";
import { springOvershoot } from "../motion/spring";
import { TRACK_HEIGHT } from "./layout";

/** The inset every `step` ms across the whole pulse, and a little past it. */
function trace(step = 1) {
  const out: Array<{ t: number; inset: number | null }> = [];
  for (let t = 0; t <= LIFT_DURATION_MS + 20; t += step) {
    out.push({ t, inset: liftInsetAt(t) });
  }
  return out;
}

describe("liftInsetAt", () => {
  it("starts at the clip's own size", () => {
    expect(liftInsetAt(0)).toBe(0);
    expect(liftInsetAt(-5)).toBe(0);
    expect(liftInsetAt(NaN)).toBe(0);
  });

  it("sinks steadily to its deepest at the end of the press", () => {
    let previous = 0;
    for (let t = 1; t < LIFT.PRESS_MS; t++) {
      const inset = liftInsetAt(t)!;
      expect(inset).toBeGreaterThan(previous);
      previous = inset;
    }
    expect(liftInsetAt(LIFT.PRESS_MS)).toBeCloseTo(LIFT.PEAK_PX, 6);
  });

  it("never sinks further than the peak", () => {
    for (const { inset } of trace()) {
      if (inset != null) expect(inset).toBeLessThanOrEqual(LIFT.PEAK_PX + 1e-9);
    }
  });

  it("springs back past its size by a fraction of a pixel, not a jump", () => {
    const deepest = Math.min(...trace().map((p) => p.inset ?? 0));
    expect(deepest).toBeLessThan(0);
    expect(deepest).toBeGreaterThan(-0.5);
    // Stated against the spring too, so a retune that loses the bounce fails.
    expect(springOvershoot(LIFT.SPRING)).toBeGreaterThan(0.05);
  });

  it("ends close enough to zero that stopping is not a visible jump", () => {
    const points = trace();
    const lastLive = [...points].reverse().find((p) => p.inset != null)!;
    expect(Math.abs(lastLive.inset!)).toBeLessThan(0.05);
  });

  it("reports the end, so the caller stops asking for frames", () => {
    expect(liftInsetAt(LIFT_DURATION_MS)).toBeNull();
    expect(liftInsetAt(LIFT_DURATION_MS + 1000)).toBeNull();
  });

  it("is over in about a third of a second", () => {
    expect(LIFT_DURATION_MS).toBeGreaterThan(200);
    expect(LIFT_DURATION_MS).toBeLessThan(450);
  });

  it("is animated across frames, never a jump to the bottom in one", () => {
    for (let t = 0; t < LIFT_DURATION_MS; t += 1) {
      const a = liftInsetAt(t) ?? 0;
      const b = liftInsetAt(t + 1000 / 60) ?? 0;
      expect(Math.abs(b - a)).toBeLessThan(LIFT.PEAK_PX / 2);
    }
  });
});

describe("liftScale", () => {
  const H = TRACK_HEIGHT;

  it("draws the clip the given pixels in from every edge", () => {
    const { sx, sy } = liftScale(400, H, 2);
    expect(400 * sx).toBeCloseTo(396, 9);
    expect(H * sy).toBeCloseTo(H - 4, 9);
  });

  it("gives a long clip the same pixels as a short one, not the same fraction", () => {
    const long = liftScale(20_000, H, 2);
    expect(20_000 * (1 - long.sx)).toBeCloseTo(4, 6);
  });

  it("is uniform on a clip narrower than it is tall", () => {
    const { sx, sy } = liftScale(10, H, 2);
    expect(sx).toBeCloseTo(sy, 12);
  });

  it("grows the same way during the overshoot", () => {
    const { sx, sy } = liftScale(400, H, -0.5);
    expect(400 * sx).toBeCloseTo(401, 9);
    expect(H * sy).toBeCloseTo(H + 1, 9);
  });

  it("is the identity at zero and on degenerate input", () => {
    expect(liftScale(400, H, 0)).toEqual({ sx: 1, sy: 1 });
    expect(liftScale(0, H, 2)).toEqual({ sx: 1, sy: 1 });
    expect(liftScale(400, 0, 2)).toEqual({ sx: 1, sy: 1 });
    expect(liftScale(400, H, NaN)).toEqual({ sx: 1, sy: 1 });
  });

  it("never turns a clip inside out", () => {
    const { sx, sy } = liftScale(2, 2, 5);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
  });
});
