import { describe, expect, it } from "vitest";
import {
  criticalDamping,
  springDurationMs,
  springEasing,
  springOvershoot,
  springPosition,
  type Spring,
} from "./spring";

const under: Spring = { stiffness: 240, damping: 18 };
const critical: Spring = { stiffness: 240, damping: criticalDamping({ stiffness: 240 }) };
const over: Spring = { stiffness: 240, damping: 80 };

/** Samples across the whole settle, which is all any of these need. */
const walk = (spring: Spring, steps = 400): number[] => {
  const duration = springDurationMs(spring) / 1000;
  return Array.from({ length: steps + 1 }, (_, i) =>
    springPosition(spring, (i / steps) * duration),
  );
};

describe("spring", () => {
  it("starts at rest and arrives", () => {
    for (const spring of [under, critical, over]) {
      expect(springPosition(spring, 0)).toBe(0);
      expect(springPosition(spring, -1)).toBe(0);
      expect(springPosition(spring, 20)).toBeCloseTo(1, 6);
    }
  });

  it("leaves 0 in the direction of travel", () => {
    for (const spring of [under, critical, over]) {
      expect(springPosition(spring, 0.01)).toBeGreaterThan(0);
    }
  });

  describe("damping decides whether it overshoots", () => {
    it("passes its target when under-damped", () => {
      expect(springOvershoot(under)).toBeGreaterThan(0.05);
      expect(Math.max(...walk(under))).toBeGreaterThan(1);
    });

    // The rule `motion.ts` picks the slide spring by.
    it("never passes its target when critically damped", () => {
      expect(springOvershoot(critical)).toBe(0);
      expect(Math.max(...walk(critical))).toBeLessThanOrEqual(1);
    });

    it("never passes its target when over-damped", () => {
      expect(springOvershoot(over)).toBe(0);
      expect(Math.max(...walk(over))).toBeLessThanOrEqual(1);
    });

    // Straddle the boundary `criticalDamping` names. Not by a hair: just under
    // it the overshoot is around 1e-7 of the travel and peaks a second after
    // the spring has otherwise settled, so it is neither measurable here nor
    // visible on screen. The margin below is the one that matters to a layout.
    it("puts the boundary at criticalDamping", () => {
      const c = criticalDamping({ stiffness: 240 });

      expect(
        springOvershoot({ stiffness: 240, damping: c * 0.85 }),
      ).toBeGreaterThan(0.001);
      expect(springOvershoot({ stiffness: 240, damping: c })).toBe(0);
      expect(springOvershoot({ stiffness: 240, damping: c * 1.2 })).toBe(0);
    });

    it("rises without a dip, whatever the damping", () => {
      // An over-damped spring that went backwards first would mean the two
      // exponential terms had been solved with the wrong constants.
      const values = walk(over);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9);
      }
    });
  });

  describe("duration", () => {
    it("is shorter for a stiffer spring", () => {
      const soft = springDurationMs({ stiffness: 120, damping: 18 });
      const stiff = springDurationMs({ stiffness: 480, damping: 18 });

      expect(stiff).toBeLessThan(soft);
    });

    // The whole point of deriving it: at the duration the spring is *done*,
    // not merely passing through its target on the way to another bounce.
    it("is long enough that the spring has actually settled", () => {
      for (const spring of [under, critical, over]) {
        const seconds = springDurationMs(spring) / 1000;

        expect(Math.abs(springPosition(spring, seconds) - 1)).toBeLessThan(0.01);
        for (let t = seconds; t < seconds + 0.5; t += 0.01) {
          expect(Math.abs(springPosition(spring, t) - 1)).toBeLessThan(0.01);
        }
      }
    });

    it("does not stop at the first crossing of an under-damped spring", () => {
      // The first time it touches 1 is early and is followed by a full
      // overshoot; the duration has to be past that.
      const steps = 2000;
      const seconds = springDurationMs(under) / 1000;
      let firstCrossing = seconds;
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * seconds;
        if (springPosition(under, t) >= 1) {
          firstCrossing = t;
          break;
        }
      }

      expect(firstCrossing).toBeLessThan(seconds * 0.6);
    });
  });

  describe("as CSS", () => {
    it("is a linear() pinned to its endpoints", () => {
      const easing = springEasing(under, 12);

      expect(easing.startsWith("linear(0, ")).toBe(true);
      expect(easing.endsWith(", 1)")).toBe(true);
      expect(easing.slice("linear(".length, -1).split(", ")).toHaveLength(13);
    });

    it("carries the overshoot into the samples, above 1", () => {
      const values = springEasing(under)
        .slice("linear(".length, -1)
        .split(", ")
        .map(Number);

      expect(values.some((v) => v > 1)).toBe(true);
      expect(values.every(Number.isFinite)).toBe(true);
    });

    it("stays at or below 1 for a spring that does not overshoot", () => {
      const values = springEasing(critical)
        .slice("linear(".length, -1)
        .split(", ")
        .map(Number);

      expect(values.every((v) => v <= 1)).toBe(true);
    });

    it("rounds to something CSS will not choke on", () => {
      for (const value of springEasing(under).slice("linear(".length, -1).split(", ")) {
        expect(value).toMatch(/^-?\d+(\.\d{1,4})?$/);
      }
    });
  });
});
