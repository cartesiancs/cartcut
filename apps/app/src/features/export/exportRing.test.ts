import { describe, expect, it } from "vitest";
import { ringDash } from "./exportRing";

/**
 * The Lit shell is untested, as every other component in this codebase is.
 * The arc arithmetic is not: a `NaN` dashoffset draws nothing at all, which on
 * screen is indistinguishable from an export that never started.
 */
const R = 9.75;
const C = 2 * Math.PI * R;

describe("ringDash", () => {
  it("draws an empty ring at zero", () => {
    const { array, offset } = ringDash(0, R);
    expect(array).toBeCloseTo(C);
    expect(offset).toBeCloseTo(C);
  });

  it("draws a full ring at a hundred", () => {
    expect(ringDash(100, R).offset).toBeCloseTo(0);
  });

  it("draws half a ring at fifty", () => {
    expect(ringDash(50, R).offset).toBeCloseTo(C / 2);
  });

  it("clamps rather than overshooting the circumference", () => {
    expect(ringDash(-40, R).offset).toBeCloseTo(C);
    expect(ringDash(140, R).offset).toBeCloseTo(0);
  });

  it("never produces NaN, whatever it is handed", () => {
    for (const percent of [NaN, Infinity, -Infinity]) {
      const { array, offset } = ringDash(percent, R);
      expect(Number.isFinite(array)).toBe(true);
      expect(Number.isFinite(offset)).toBe(true);
    }
  });

  it("advances monotonically across the run", () => {
    let previous = Infinity;
    for (let percent = 0; percent <= 100; percent += 5) {
      const { offset } = ringDash(percent, R);
      expect(offset).toBeLessThanOrEqual(previous);
      previous = offset;
    }
  });
});
