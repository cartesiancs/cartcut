import { describe, expect, it } from "vitest";
import {
  HOLD_MS,
  SILENCE_EPSILON,
  SILENT,
  advanceMeter,
  isMoving,
  silentAt,
  type MeterState,
} from "./meterBallistics";

/** Run the meter forward in `stepMs` slices, so a decay is measured, not guessed. */
function run(
  state: MeterState,
  target: number,
  fromMs: number,
  toMs: number,
  stepMs = 16,
): MeterState {
  let current = state;
  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    current = advanceMeter(current, target, t);
  }
  return current;
}

describe("advanceMeter", () => {
  it("rises instantly — a peak that is missed is a peak that was not shown", () => {
    const next = advanceMeter(SILENT, 0.9, 16);
    expect(next.level).toBe(0.9);
  });

  it("keeps rising with the signal", () => {
    const a = advanceMeter(SILENT, 0.3, 16);
    const b = advanceMeter(a, 0.7, 32);
    expect(b.level).toBe(0.7);
  });

  it("falls gradually rather than snapping to the new level", () => {
    const peak = advanceMeter(SILENT, 1, 0);

    const after200 = run(peak, 0, 0, 200);
    expect(after200.level).toBeLessThan(1);
    expect(after200.level).toBeGreaterThan(0);

    const after600 = run(peak, 0, 0, 600);
    expect(after600.level).toBeLessThan(after200.level);
  });

  it("reaches rest, so the drawing loop can stop", () => {
    const settled = run(advanceMeter(SILENT, 1, 0), 0, 0, 4000);
    expect(settled.level).toBe(0);
    expect(settled.hold).toBe(0);
    expect(isMoving(settled)).toBe(false);
  });

  it("never falls below the signal it is tracking", () => {
    const peak = advanceMeter(SILENT, 1, 0);
    const held = run(peak, 0.4, 0, 2000);
    expect(held.level).toBe(0.4);
  });

  it("holds the peak marker, then lets it fall", () => {
    const peak = advanceMeter(SILENT, 0.9, 0);
    expect(peak.hold).toBe(0.9);
    expect(peak.holdUntilMs).toBe(HOLD_MS);

    // Still up just inside the hold window, even though the bar has dropped.
    const inside = run(peak, 0, 0, HOLD_MS - 100);
    expect(inside.hold).toBe(0.9);
    expect(inside.level).toBeLessThan(0.9);

    const after = run(peak, 0, 0, HOLD_MS + 600);
    expect(after.hold).toBeLessThan(0.9);
  });

  it("re-arms the hold when a louder peak arrives", () => {
    const first = advanceMeter(SILENT, 0.5, 0);
    const louder = advanceMeter(first, 0.8, 500);
    expect(louder.hold).toBe(0.8);
    expect(louder.holdUntilMs).toBe(500 + HOLD_MS);
  });

  it("never lets the marker sink below the bar", () => {
    const state = run(advanceMeter(SILENT, 1, 0), 0.6, 0, 5000);
    expect(state.hold).toBeGreaterThanOrEqual(state.level);
  });

  /**
   * The repo's decline convention, and load-bearing rather than tidy: the
   * drawing loop compares the returned state against the one it had, so a
   * project sitting silent stops repainting instead of clearing and refilling
   * the same pixels sixty times a second.
   */
  it("returns its input by identity when nothing moved", () => {
    const resting = run(advanceMeter(SILENT, 1, 0), 0, 0, 4000);
    expect(advanceMeter(resting, 0, 5000)).toBe(resting);
    expect(advanceMeter(SILENT, 0, 16)).toBe(SILENT);
  });

  it("elapses no time for a clock that has not moved", () => {
    const peak = advanceMeter(SILENT, 1, 100);
    expect(advanceMeter(peak, 0, 100)).toBe(peak);
    // A clock that goes backwards is treated as zero elapsed, not as a rise.
    expect(advanceMeter(peak, 0, 50)).toBe(peak);
  });

  it("clamps a target outside 0..1 rather than drawing off the bar", () => {
    expect(advanceMeter(SILENT, 4, 16).level).toBe(1);
    expect(advanceMeter(SILENT, -1, 16).level).toBe(0);
    expect(advanceMeter(SILENT, NaN, 16).level).toBe(0);
  });

  it("snaps the last sliver to zero, so the decay terminates", () => {
    const tiny = advanceMeter(SILENT, SILENCE_EPSILON / 2, 16);
    expect(tiny.level).toBe(0);
  });
});

describe("isMoving", () => {
  it("is false at rest and true with anything left to draw", () => {
    expect(isMoving(SILENT)).toBe(false);
    expect(isMoving(advanceMeter(SILENT, 0.5, 16))).toBe(true);
  });
});

describe("silentAt", () => {
  it("parks the clock, so the next wake measures its decay from now", () => {
    const parked = silentAt(9000);
    expect(parked.level).toBe(0);
    expect(parked.hold).toBe(0);
    expect(parked.atMs).toBe(9000);
  });
});
