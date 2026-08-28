/**
 * The playback cursor is now quantized, and the claim that makes that safe is
 * arithmetic rather than judgement: flooring `Date.now() - startTime` onto the
 * frame grid moves the cursor by less than one frame, and one frame is two
 * orders of magnitude inside the drift tolerance `playback.ts` re-seeks at.
 *
 * The other claim is the one that used to be a bug elsewhere in this codebase:
 * the position is recomputed from `elapsed` every tick and never accumulated,
 * so a minute of playback lands exactly where a single jump of a minute does.
 */

import { describe, expect, it } from "vitest";
import { cursorAtElapsed } from "./playbackClock";
import {
  DEFAULT_FPS,
  frameDurationMs,
  frameToMs,
  isFrameAligned,
  msToFrameFloor,
} from "./frames";
import { PLAYING_DRIFT_TOLERANCE_SEC } from "./playback";
import { mulberry32 } from "../renderer/testing";

const RATES = [24, 25, 30, 50, 60, 120];

describe("cursorAtElapsed", () => {
  it("always lands on a frame boundary", () => {
    const random = mulberry32(11);
    for (const fps of RATES) {
      for (let i = 0; i < 1000; i++) {
        const elapsed = random() * 600_000;
        expect(isFrameAligned(cursorAtElapsed(elapsed, fps), fps)).toBe(true);
      }
    }
  });

  it("holds the frame the wall clock is inside", () => {
    for (const fps of RATES) {
      const step = frameDurationMs(fps);
      for (let frame = 0; frame < 300; frame++) {
        const start = frameToMs(frame, fps);
        for (const offset of [0, 0.25, 0.5, 0.999]) {
          expect(cursorAtElapsed(start + step * offset, fps)).toBeCloseTo(
            start,
            9,
          );
        }
      }
    }
  });

  it("never runs ahead of the wall clock", () => {
    // Flooring can only ever be late, which is what makes the bound below a
    // bound rather than an average.
    const random = mulberry32(12);
    for (const fps of RATES) {
      for (let i = 0; i < 1000; i++) {
        const elapsed = random() * 600_000;
        expect(cursorAtElapsed(elapsed, fps)).toBeLessThanOrEqual(
          elapsed + 1e-6,
        );
      }
    }
  });

  it("lags by less than one frame, which is far inside the seek tolerance", () => {
    // The claim that says this does not fight `applyIntent`. At 24fps — the
    // worst case, since a frame is longest there — one frame is 41.7ms against
    // a 250ms tolerance.
    const random = mulberry32(13);
    for (const fps of RATES) {
      const frame = frameDurationMs(fps);
      for (let i = 0; i < 1000; i++) {
        const elapsed = random() * 600_000;
        const lag = elapsed - cursorAtElapsed(elapsed, fps);
        expect(lag).toBeGreaterThanOrEqual(-1e-6);
        expect(lag).toBeLessThan(frame);
      }
      expect(frame).toBeLessThan(PLAYING_DRIFT_TOLERANCE_SEC * 1000);
    }
  });

  it("does not accumulate: a thousand ticks match one jump", () => {
    // The bug this shape exists to make unrepresentable. Stepping the cursor by
    // `1000 / fps` sixty times gives 999.9999999999991, not 1000.
    for (const fps of RATES) {
      const step = frameDurationMs(fps);
      for (let n = 0; n <= 1000; n += 137) {
        const viaClock = cursorAtElapsed(n * step + step / 2, fps);
        expect(viaClock).toBeCloseTo(frameToMs(n, fps), 9);
        expect(Object.is(viaClock, frameToMs(n, fps))).toBe(true);
      }
    }
  });

  it("advances monotonically", () => {
    for (const fps of RATES) {
      let previous = -1;
      // A 120Hz panel sampling a project of any rate: most ticks repeat the
      // value, none goes backwards.
      for (let tick = 0; tick < 2000; tick++) {
        const now = cursorAtElapsed(tick * (1000 / 120), fps);
        expect(now).toBeGreaterThanOrEqual(previous);
        previous = now;
      }
    }
  });

  it("repeats a value exactly when the display outruns the project", () => {
    // What makes the `setCursor` no-op guard worth having: at 30fps on a 120Hz
    // panel, three ticks in four ask for the instant already set.
    const ticks = 400;
    const seen = new Set<number>();
    for (let tick = 0; tick < ticks; tick++) {
      seen.add(cursorAtElapsed(tick * (1000 / 120), 30));
    }
    expect(seen.size).toBe(ticks / 4);
  });

  it("starts at zero and never precedes it", () => {
    for (const fps of RATES) {
      expect(Object.is(cursorAtElapsed(0, fps), 0)).toBe(true);
      expect(Object.is(cursorAtElapsed(-1000, fps), 0)).toBe(true);
    }
  });

  it("agrees with msToFrameFloor, which is what every consumer uses", () => {
    const random = mulberry32(14);
    for (const fps of RATES) {
      for (let i = 0; i < 500; i++) {
        const elapsed = random() * 3_600_000;
        expect(
          Object.is(
            cursorAtElapsed(elapsed, fps),
            frameToMs(msToFrameFloor(elapsed, fps), fps),
          ),
        ).toBe(true);
      }
    }
  });

  it("guards an unusable rate", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(cursorAtElapsed(1234.5, bad)).toBe(
        cursorAtElapsed(1234.5, DEFAULT_FPS),
      );
    }
  });
});
