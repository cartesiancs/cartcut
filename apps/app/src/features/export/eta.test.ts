import { describe, expect, it } from "vitest";

import {
  createEtaState,
  finishTailMs,
  observeEta,
  readEta,
  type EtaState,
} from "./eta";

const TOTAL = 10_000;

function fresh(totalUnits = TOTAL, tailMs = 0): EtaState {
  return createEtaState({ totalUnits, tailMs });
}

/**
 * Run a constant-rate export up to `units`, sampling every frame.
 *
 * `startAt` is non-zero so nothing can accidentally depend on the clock
 * starting at the origin.
 */
function runAt(
  msPerUnit: number,
  units: number,
  state = fresh(),
  startAt = 5_000,
): { state: EtaState; now: number } {
  let now = startAt;
  let current = state;
  for (let u = 1; u <= units; u++) {
    now = startAt + u * msPerUnit;
    current = observeEta(current, u, now);
  }
  return { state: current, now };
}

/** The reading's milliseconds, failing loudly if it is not a number. */
function remainingOf(state: EtaState, now: number): number {
  const reading = readEta(state, now);
  expect(reading.kind).toBe("remaining");
  return reading.kind === "remaining" ? reading.ms : Number.NaN;
}

describe("finishTailMs", () => {
  it("brackets the three measured profiles", () => {
    // Measured through a 500ms poll, so these are +/- half a second.
    expect(finishTailMs(600)).toBeCloseTo(500, -2);
    expect(finishTailMs(2_400)).toBeGreaterThanOrEqual(500);
    expect(finishTailMs(18_000)).toBeCloseTo(3_000, -3);
  });

  it("clamps at both ends and survives a degenerate count", () => {
    expect(finishTailMs(1)).toBe(500);
    expect(finishTailMs(1e9)).toBe(8_000);
    expect(finishTailMs(0)).toBe(500);
    expect(finishTailMs(Number.NaN)).toBe(500);
  });
});

describe("warm-up", () => {
  it("shows nothing before there is enough work and enough clock", () => {
    expect(readEta(fresh(), 0).kind).toBe("warmup");

    // Enough units, not enough wall clock: 20 units at 1ms each is 20ms.
    const quick = runAt(1, 20);
    expect(readEta(quick.state, quick.now).kind).toBe("warmup");

    // Enough wall clock, not enough units.
    const slow = runAt(1_000, 5);
    expect(readEta(slow.state, slow.now).kind).toBe("warmup");
  });

  it("yields a number once both gates clear", () => {
    const run = runAt(200, 20);
    expect(readEta(run.state, run.now).kind).toBe("remaining");
  });
});

describe("steady state", () => {
  it("lands within 5% of the truth at every decile", () => {
    const msPerUnit = 3;
    let state = fresh();
    let now = 0;

    for (let u = 1; u <= TOTAL; u++) {
      now = u * msPerUnit;
      state = observeEta(state, u, now);

      if (u % 1_000 !== 0 || u === TOTAL) {
        continue;
      }
      const truth = (TOTAL - u) * msPerUnit;
      expect(remainingOf(state, now)).toBeCloseTo(truth, -Math.log10(truth * 0.05));
    }
  });

  it("does not depend on how often it is sampled", () => {
    // The property a wall-clock time constant cannot give: the same wall-clock
    // trajectory observed every frame and every tenth frame must agree.
    const msPerUnit = 4;
    let dense = fresh();
    let sparse = fresh();

    for (let u = 1; u <= 4_000; u++) {
      const now = u * msPerUnit;
      dense = observeEta(dense, u, now);
      if (u % 10 === 0) {
        sparse = observeEta(sparse, u, now);
      }
    }

    const now = 4_000 * msPerUnit;
    const a = remainingOf(dense, now);
    const b = remainingOf(sparse, now);
    expect(Math.abs(a - b) / a).toBeLessThan(0.02);
  });
});

describe("adaptation", () => {
  it("converges after the rate doubles", () => {
    const half = TOTAL / 2;
    let state = fresh();
    let now = 0;

    for (let u = 1; u <= half; u++) {
      now = u * 2;
      state = observeEta(state, u, now);
    }
    // A tenth of the job at the new rate is two horizons' worth of work.
    for (let u = half + 1; u <= half + TOTAL * 0.1; u++) {
      now += 4;
      state = observeEta(state, u, now);
    }

    const done = half + TOTAL * 0.1;
    const truth = (TOTAL - done) * 4;
    // Most of the way there, not all: the blend deliberately keeps a quarter of
    // its weight on the average over the whole run, which after an instant
    // doubling is still carrying the half that ran at the old rate. That is the
    // price of the variance reduction the blend buys early on, and the test
    // below pins the direction that price must not be paid in.
    expect(remainingOf(state, now)).toBeGreaterThan(truth * 0.8);
    expect(remainingOf(state, now)).toBeLessThan(truth * 1.2);
  });

  it("does not over-estimate at the end of a job that accelerates", () => {
    // The measured shape: the run gets ~40% faster from start to finish. A
    // cumulative average would still be carrying the slow beginning here and
    // would say roughly half again as long as the truth. This is the
    // regression test for the blend cap.
    let state = fresh();
    let now = 0;

    for (let u = 1; u <= TOTAL * 0.95; u++) {
      const progress = u / TOTAL;
      now += 5 - 2 * progress;
      state = observeEta(state, u, now);
    }

    const done = Math.floor(TOTAL * 0.95);
    const truth = (TOTAL - done) * (5 - 2 * 0.95);
    expect(remainingOf(state, now)).toBeLessThan(truth * 1.15);
  });
});

describe("stalls", () => {
  it("grows with the clock alone, then recovers", () => {
    const run = runAt(3, 5_000);
    const settled = remainingOf(run.state, run.now);

    const stalled = remainingOf(run.state, run.now + 30_000);
    // Beyond the grace window the overrun is real time the user must still
    // wait, so it counts — a frozen number here is the bug this replaces.
    expect(stalled).toBeGreaterThan(settled + 20_000);

    const recovered = observeEta(run.state, 5_001, run.now + 30_000);
    expect(remainingOf(recovered, run.now + 30_000)).toBeLessThan(stalled);
  });

  it("ignores an ordinary slow frame", () => {
    const run = runAt(3, 5_000);
    const settled = remainingOf(run.state, run.now);
    // Well inside the grace window.
    expect(remainingOf(run.state, run.now + 500)).toBeCloseTo(settled, 5);
  });
});

describe("degenerate input", () => {
  it("declines an observation that carries nothing, by identity", () => {
    const run = runAt(3, 100);
    expect(observeEta(run.state, 100, run.now + 10)).toBe(run.state);
    expect(observeEta(run.state, 50, run.now + 10)).toBe(run.state);
    expect(observeEta(run.state, Number.NaN, run.now)).toBe(run.state);
    expect(observeEta(run.state, 200, Number.NaN)).toBe(run.state);
  });

  it("finalizes rather than dividing by zero on an empty export", () => {
    expect(readEta(fresh(0), 0).kind).toBe("finalizing");
    expect(readEta(createEtaState({ totalUnits: -1, tailMs: 0 }), 0).kind).toBe(
      "finalizing",
    );
  });

  it("finalizes once the work is done", () => {
    const run = runAt(3, TOTAL);
    expect(readEta(run.state, run.now).kind).toBe("finalizing");
  });

  it("survives two observations sharing an instant", () => {
    let state = fresh();
    state = observeEta(state, 1, 1_000);
    state = observeEta(state, 2, 1_000);
    expect(Number.isFinite(state.rate ?? 0)).toBe(true);
  });

  it("only ever reads a finite, non-negative number", () => {
    for (const total of [1, 2, 37, TOTAL]) {
      for (const msPerUnit of [0, 0.001, 1, 10_000]) {
        const run = runAt(msPerUnit, total, fresh(total, 500));
        for (const at of [0, run.now, run.now + 1e6]) {
          const reading = readEta(run.state, at);
          if (reading.kind === "remaining") {
            expect(Number.isFinite(reading.ms)).toBe(true);
            expect(reading.ms).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("adds the flush tail so the number does not reach zero early", () => {
    const withTail = runAt(3, 9_000, fresh(TOTAL, 2_000));
    const without = runAt(3, 9_000, fresh(TOTAL, 0));
    expect(remainingOf(withTail.state, withTail.now)).toBeCloseTo(
      remainingOf(without.state, without.now) + 2_000,
      5,
    );
  });
});
