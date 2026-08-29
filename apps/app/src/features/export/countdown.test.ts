import { describe, expect, it } from "vitest";

import {
  COUNTDOWN_MAX_RATE,
  COUNTDOWN_TICK_MS,
  countdownSeconds,
  createCountdown,
  tickCountdown,
  type CountdownState,
} from "./countdown";

/** Deterministic noise, so a property test fails the same way twice. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("tickCountdown", () => {
  it("primes on the first real estimate and only then", () => {
    let state = createCountdown(0);
    expect(state.primed).toBe(false);

    state = tickCountdown(state, null, 250);
    expect(state.primed).toBe(false);
    expect(state.displayMs).toBe(0);
    // The clock still advanced, so the next tick measures from here rather
    // than replaying the whole warm-up as one enormous step.
    expect(state.at).toBe(250);

    state = tickCountdown(state, 60_000, 500);
    expect(state.primed).toBe(true);
    expect(state.displayMs).toBe(60_000);
  });

  it("counts down at real time when the estimate agrees", () => {
    let state = tickCountdown(createCountdown(0), 10_000, 0);
    for (let now = COUNTDOWN_TICK_MS; now <= 1_000; now += COUNTDOWN_TICK_MS) {
      state = tickCountdown(state, 10_000 - now, now);
    }
    // A second of clock takes exactly a second off.
    expect(state.displayMs).toBeCloseTo(9_000, 6);
  });

  it("never rises, over thousands of adversarial estimates", () => {
    const random = makeRandom(20260830);
    let state = tickCountdown(createCountdown(0), 300_000, 0);
    let now = 0;
    let previous = state.displayMs;

    for (let i = 0; i < 5_000; i++) {
      now += COUNTDOWN_TICK_MS;
      // Everything the estimator can legally emit, including nothing.
      const roll = random();
      const estimate =
        roll < 0.1
          ? null
          : roll < 0.2
            ? 0
            : roll < 0.6
              ? random() * 600_000
              : Math.max(0, previous + (random() - 0.5) * 40_000);

      state = tickCountdown(state, estimate, now);
      expect(state.displayMs).toBeLessThanOrEqual(previous + 1e-9);
      expect(Number.isFinite(state.displayMs)).toBe(true);
      expect(state.displayMs).toBeGreaterThanOrEqual(0);
      previous = state.displayMs;
    }
  });

  it("keeps display/estimate invariant against a truthful estimate", () => {
    // The property the rate is chosen for: a display that starts 20% low stays
    // 20% low *proportionally*, so it lands on zero at the same moment the
    // estimate does instead of bottoming out early.
    const total = 200_000;
    let state = tickCountdown(createCountdown(0), total * 0.8, 0);

    for (let now = COUNTDOWN_TICK_MS; now < total; now += COUNTDOWN_TICK_MS) {
      const truth = total - now;
      state = tickCountdown(state, truth, now);
      // Exact at every step, right down to the last one — not merely in the
      // continuous limit. This is what pins the `estimateMs + dt` denominator:
      // dividing by the end-of-step estimate instead passes at 100s remaining
      // and drifts to 0.75 by the final second.
      expect(state.displayMs / truth).toBeCloseTo(0.8, 9);
    }
  });

  it("caps how fast it catches up to a large drop", () => {
    let state = tickCountdown(createCountdown(0), 600_000, 0);
    // 590s of over-estimate cannot be paid off faster than the rate cap allows.
    const floor = (600_000 - 10_000) / COUNTDOWN_MAX_RATE;

    let now = 0;
    while (state.displayMs > 10_000 && now < floor * 2) {
      now += COUNTDOWN_TICK_MS;
      state = tickCountdown(state, 10_000, now);
    }
    expect(now).toBeGreaterThanOrEqual(floor - COUNTDOWN_TICK_MS);
  });

  it("slows rather than rising when the estimate goes up", () => {
    const before = tickCountdown(createCountdown(0), 10_000, 0);
    const after = tickCountdown(before, 60_000, 1_000);

    expect(after.displayMs).toBeLessThan(before.displayMs);
    // A plain 1x countdown would have taken a full second off; this took less.
    expect(after.displayMs).toBeGreaterThan(before.displayMs - 1_000);
  });

  it("never freezes, even while the estimate outruns the clock", () => {
    let state = tickCountdown(createCountdown(0), 10_000, 0);
    let estimate = 10_000;
    const started = state.displayMs;

    for (let now = COUNTDOWN_TICK_MS; now <= 10_000; now += COUNTDOWN_TICK_MS) {
      estimate += COUNTDOWN_TICK_MS * 2;
      state = tickCountdown(state, estimate, now);
    }
    // A number that stopped moving would read as a hung app.
    expect(state.displayMs).toBeLessThan(started);
  });

  it("holds the number through a warm-up gap", () => {
    const primed = tickCountdown(createCountdown(0), 5_000, 0);
    const held = tickCountdown(primed, null, 3_000);
    expect(held.displayMs).toBe(primed.displayMs);
    expect(held.at).toBe(3_000);
  });
});

describe("countdownSeconds", () => {
  it("ceils, so a second is shown until it is genuinely gone", () => {
    expect(countdownSeconds(state(4_001))).toBe(5);
    expect(countdownSeconds(state(4_000))).toBe(4);
  });

  it("never reads zero while the export is running", () => {
    expect(countdownSeconds(state(0))).toBe(1);
    expect(countdownSeconds(state(-500))).toBe(1);
    expect(countdownSeconds(state(Number.NaN))).toBe(1);
  });
});

function state(displayMs: number): CountdownState {
  return { displayMs, at: 0, primed: true };
}
