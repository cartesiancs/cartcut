/**
 * The fit, and the one property that matters about it.
 *
 * Every case runs at more than one aspect on purpose. The clamp bug this suite
 * exists to catch, deriving the visible window from the capture's aspect rather
 * than the frame's, is exactly right when the two agree, which is what a single
 * 16:9-into-16:9 fixture would assert.
 */
import { describe, it, expect } from "vitest";
import {
  clampAim,
  recordBox,
  recordFit,
  Z_COVER,
  type Size,
} from "./recordFit";

const FRAME: Size = { width: 1920, height: 1080 };

/** A MacBook panel: narrower than the frame, so cover overflows vertically. */
const LAPTOP: Size = { width: 3024, height: 1964 };
/** An ultrawide: wider than the frame, so cover overflows horizontally. */
const ULTRAWIDE: Size = { width: 3440, height: 1440 };
/** The same shape as the frame. The only case where contain and cover agree. */
const MATCHING: Size = { width: 3840, height: 2160 };

describe("recordFit", () => {
  it("covers the frame on both axes, whichever way the source leans", () => {
    for (const source of [LAPTOP, ULTRAWIDE, MATCHING]) {
      const { cover } = recordFit(source, FRAME);
      expect(cover.width).toBeGreaterThanOrEqual(FRAME.width - 1e-9);
      expect(cover.height).toBeGreaterThanOrEqual(FRAME.height - 1e-9);
      // ...and touches it on exactly one axis, or it is not a cover.
      const touches =
        Math.abs(cover.width - FRAME.width) < 1e-9 ||
        Math.abs(cover.height - FRAME.height) < 1e-9;
      expect(touches).toBe(true);
    }
  });

  it("keeps the source aspect", () => {
    for (const source of [LAPTOP, ULTRAWIDE, MATCHING]) {
      const { cover } = recordFit(source, FRAME);
      expect(cover.width / cover.height).toBeCloseTo(source.width / source.height, 9);
    }
  });

  it("bases below cover, so the whole screen is visible at rest", () => {
    for (const source of [LAPTOP, ULTRAWIDE]) {
      const fit = recordFit(source, FRAME);
      expect(fit.base).toBeGreaterThan(0);
      expect(fit.base).toBeLessThan(1);

      const box = recordBox(fit, FRAME, fit.base);
      expect(box.width).toBeLessThanOrEqual(FRAME.width);
      expect(box.height).toBeLessThanOrEqual(FRAME.height);
    }
  });

  it("reaches base 1 only at a matching aspect with no padding", () => {
    expect(recordFit(MATCHING, FRAME, 0).base).toBeCloseTo(1, 9);
    expect(recordFit(MATCHING, FRAME, 0.05).base).toBeCloseTo(0.95, 9);
    expect(recordFit(LAPTOP, FRAME, 0).base).toBeLessThan(1);
  });

  it("states the laptop case in full, so a change to it is visible in the diff", () => {
    const fit = recordFit(LAPTOP, FRAME, 0.05);
    expect(fit.cover.width).toBeCloseTo(1920, 6);
    expect(fit.cover.height).toBeCloseTo(1246.98, 1);
    expect(fit.base).toBeCloseTo(0.82279, 4);

    const box = recordBox(fit, FRAME, fit.base);
    expect(box.width).toBeCloseTo(1580, 0);
    expect(box.height).toBeCloseTo(1026, 0);
    // Centred: equal margin on each side.
    expect(box.x).toBeCloseTo((FRAME.width - box.width) / 2, 6);
    expect(box.y).toBeCloseTo((FRAME.height - box.height) / 2, 6);
  });

  it("answers a unit fit for a degenerate probe rather than throwing", () => {
    for (const bad of [
      { width: 0, height: 0 },
      { width: -1, height: 100 },
      { width: NaN, height: NaN },
    ]) {
      const fit = recordFit(bad as Size, FRAME);
      expect(fit.base).toBe(1);
      expect(Number.isFinite(fit.cover.width)).toBe(true);
    }
  });

  it("gives away at most half the frame to padding", () => {
    expect(recordFit(MATCHING, FRAME, 5).base).toBeCloseTo(0.5, 9);
    expect(recordFit(MATCHING, FRAME, -1).base).toBeCloseTo(1, 9);
  });
});

describe("recordBox", () => {
  it("holds the aimed-at point at the centre of the frame", () => {
    const fit = recordFit(LAPTOP, FRAME);

    for (const z of [fit.base, 1, 1.4, 1.9]) {
      for (const [u, v] of [[0.5, 0.5], [0.25, 0.75], [0.9, 0.1]]) {
        const box = recordBox(fit, FRAME, z, u, v);
        // Where the source point (u, v) lands on screen.
        expect(box.x + u * box.width).toBeCloseTo(FRAME.width / 2, 6);
        expect(box.y + v * box.height).toBeCloseTo(FRAME.height / 2, 6);
      }
    }
  });
});

describe("clampAim", () => {
  it("leaves no background visible once the picture covers the frame", () => {
    // The property, at every aspect and every reachable zoom. This is the whole
    // point of the module.
    for (const source of [LAPTOP, ULTRAWIDE, MATCHING]) {
      const fit = recordFit(source, FRAME);

      for (const z of [Z_COVER, 1.2, 1.4, 1.9, 2.4]) {
        for (const u of [0, 0.15, 0.5, 0.85, 1]) {
          for (const v of [0, 0.15, 0.5, 0.85, 1]) {
            const aim = clampAim(fit, FRAME, z, u, v);
            const box = recordBox(fit, FRAME, z, aim.u, aim.v);

            expect(box.x).toBeLessThanOrEqual(1e-6);
            expect(box.y).toBeLessThanOrEqual(1e-6);
            expect(box.x + box.width).toBeGreaterThanOrEqual(FRAME.width - 1e-6);
            expect(box.y + box.height).toBeGreaterThanOrEqual(FRAME.height - 1e-6);
          }
        }
      }
    }
  });

  it("forces the centre on an axis with no room, and frees the other", () => {
    // A 16:10 capture in a 16:9 frame at z = 1: the cover box is exactly as wide
    // as the frame and taller, so there is nowhere to pan horizontally and a
    // little vertically. Asserting both halves, because a clamp that pinned both
    // would also pass the covering property above.
    const fit = recordFit(LAPTOP, FRAME);

    expect(clampAim(fit, FRAME, 1, 0.1, 0.5).u).toBeCloseTo(0.5, 9);
    expect(clampAim(fit, FRAME, 1, 0.9, 0.5).u).toBeCloseTo(0.5, 9);

    expect(clampAim(fit, FRAME, 1, 0.5, 0).v).toBeCloseTo(0.4331, 3);
    expect(clampAim(fit, FRAME, 1, 0.5, 1).v).toBeCloseTo(0.5669, 3);
    expect(clampAim(fit, FRAME, 1, 0.5, 0.5).v).toBeCloseTo(0.5, 9);
  });

  it("frees both axes once the zoom is deep enough", () => {
    // At z = 1.9 the cover box is 3648x2369 in a 1920x1080 frame, so the aim may
    // range over [0.263, 0.737] horizontally and [0.228, 0.772] vertically. A
    // point inside both passes through untouched, which is what says the clamp
    // is a clamp and not a pin to the centre.
    const fit = recordFit(LAPTOP, FRAME);
    const aim = clampAim(fit, FRAME, 1.9, 0.3, 0.3);
    expect(aim.u).toBeCloseTo(0.3, 9);
    expect(aim.v).toBeCloseTo(0.3, 9);

    // ...and a point outside is pulled exactly to the edge, not past it.
    expect(clampAim(fit, FRAME, 1.9, 0.05, 0.5).u).toBeCloseTo(0.26316, 4);
    expect(clampAim(fit, FRAME, 1.9, 0.95, 0.5).u).toBeCloseTo(0.73684, 4);
  });

  it("collapses to the centre below cover, where nothing constrains it", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const aim = clampAim(fit, FRAME, fit.base, 0.1, 0.9);
    expect(aim).toEqual({ u: 0.5, v: 0.5 });
  });
});
