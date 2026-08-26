/**
 * The step ladder, which is what makes the preview cache work at all.
 *
 * Rendering at a continuous progress means a new cache key every frame, so a
 * hovered tile would re-render sixty times a second and the cache would never
 * hit. Everything here is about the quantisation being stable and covering the
 * ends of the range.
 */

import { describe, it, expect } from "vitest";
import {
  PREVIEW_STEPS,
  RESTING_STEP,
  previewKey,
  progressForStep,
  timeForStep,
} from "./fxPreviewProvider";

describe("previewKey", () => {
  it("separates presets and steps", () => {
    expect(previewKey("a", 1)).not.toBe(previewKey("a", 2));
    expect(previewKey("a", 1)).not.toBe(previewKey("b", 1));
  });

  it("is stable for the same request", () => {
    expect(previewKey("com.cartcut.wipe", 7)).toBe(
      previewKey("com.cartcut.wipe", 7),
    );
  });
});

describe("progressForStep", () => {
  it("covers the full range, ends included", () => {
    // A transition that never reached 0 or 1 would preview as a permanent
    // half-mix and never show either clip whole.
    expect(progressForStep(0)).toBe(0);
    expect(progressForStep(PREVIEW_STEPS - 1)).toBe(1);
  });

  it("increases with the step", () => {
    for (let step = 1; step < PREVIEW_STEPS; step++) {
      expect(progressForStep(step)).toBeGreaterThan(progressForStep(step - 1));
    }
  });

  it("stays inside 0..1", () => {
    for (let step = 0; step < PREVIEW_STEPS; step++) {
      const p = progressForStep(step);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe("RESTING_STEP", () => {
  it("is mid-transition", () => {
    // The only place a dissolve, a wipe and a slide look different from one
    // another — at either end every transition is just one of the two frames.
    const p = progressForStep(RESTING_STEP);
    expect(p).toBeGreaterThan(0.35);
    expect(p).toBeLessThan(0.65);
  });

  it("is a real step", () => {
    expect(RESTING_STEP).toBeGreaterThanOrEqual(0);
    expect(RESTING_STEP).toBeLessThan(PREVIEW_STEPS);
  });
});

describe("timeForStep", () => {
  it("advances so an animated effect reads as motion", () => {
    expect(timeForStep(0)).toBe(0);
    expect(timeForStep(PREVIEW_STEPS - 1)).toBeGreaterThan(1);
  });

  it("wraps without repeating the first frame", () => {
    // The loop is `step % PREVIEW_STEPS`, so the last step must not land back
    // on the first one's time or the animation visibly stalls once a cycle.
    expect(timeForStep(PREVIEW_STEPS)).not.toBe(timeForStep(PREVIEW_STEPS - 1));
    expect(timeForStep(PREVIEW_STEPS)).toBeGreaterThan(
      timeForStep(PREVIEW_STEPS - 1),
    );
  });
});
