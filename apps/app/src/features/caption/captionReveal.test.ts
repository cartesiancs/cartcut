import { describe, expect, it } from "vitest";
import {
  REVEAL_MAX_MS,
  REVEAL_MIN_MS,
  REVEAL_STEP_MS,
  revealDone,
  revealDurationMs,
  stepsDueAt,
} from "./captionReveal";

describe("revealDurationMs", () => {
  it("is nothing at all for an empty plan", () => {
    expect(revealDurationMs(0)).toBe(0);
    expect(revealDurationMs(-3)).toBe(0);
  });

  it("holds the floor, so a handful of captions does not crawl", () => {
    expect(revealDurationMs(1)).toBe(REVEAL_MIN_MS);
    expect(revealDurationMs(3)).toBe(REVEAL_MIN_MS);
  });

  it("paces by the step in the middle of the range", () => {
    expect(revealDurationMs(20)).toBe(20 * REVEAL_STEP_MS);
  });

  it("holds the ceiling, so a long transcript stays an animation", () => {
    expect(revealDurationMs(500)).toBe(REVEAL_MAX_MS);
    expect(revealDurationMs(5000)).toBe(REVEAL_MAX_MS);
  });
});

describe("stepsDueAt", () => {
  it("has something due on the very first tick", () => {
    // An empty beat at the front reads as the press having been missed.
    expect(stepsDueAt(0, 10)).toBe(1);
  });

  it("never goes backwards", () => {
    let last = 0;
    for (let t = 0; t <= REVEAL_MAX_MS + 200; t += 7) {
      const now = stepsDueAt(t, 40);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it("ends on exactly the number of steps, and stays there", () => {
    expect(stepsDueAt(revealDurationMs(12), 12)).toBe(12);
    expect(stepsDueAt(revealDurationMs(12) * 10, 12)).toBe(12);
  });

  it("never overshoots part way through", () => {
    for (let t = 0; t < revealDurationMs(9); t += 3) {
      expect(stepsDueAt(t, 9)).toBeLessThanOrEqual(9);
    }
  });

  it("is zero for an empty plan rather than one", () => {
    expect(stepsDueAt(0, 0)).toBe(0);
    expect(stepsDueAt(1000, 0)).toBe(0);
  });

  it("treats a negative elapsed time as the start", () => {
    expect(stepsDueAt(-50, 10)).toBe(1);
  });

  // Past about 26 steps the interval is shorter than a frame, and several
  // landing together is correct: the work is the same, and holding a cadence
  // nobody can see would mean dropping steps the user asked for.
  it("lets several land in one frame once the pace outruns the display", () => {
    const perFrame = stepsDueAt(16, 400) - stepsDueAt(0, 400);
    expect(perFrame).toBeGreaterThan(1);
  });
});

describe("revealDone", () => {
  it("is true at once for an empty plan", () => {
    expect(revealDone(0, 0)).toBe(true);
  });

  it("is false while steps remain and true at the end", () => {
    expect(revealDone(0, 20)).toBe(false);
    expect(revealDone(revealDurationMs(20) / 2, 20)).toBe(false);
    expect(revealDone(revealDurationMs(20), 20)).toBe(true);
  });

  // The last step is due one interval before the nominal end, because the
  // first is due at zero. There is no dead interval at either end, which is
  // what makes a four-caption reveal feel like four beats rather than five.
  it("finishes as the last step falls due, not an interval later", () => {
    const duration = revealDurationMs(20);
    expect(revealDone((duration * 19) / 20, 20)).toBe(true);
    expect(revealDone((duration * 18) / 20, 20)).toBe(false);
  });
});
