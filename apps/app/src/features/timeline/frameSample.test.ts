/**
 * `frameSampleMs` — the instant a decoder is addressed at.
 *
 * The property under test is not "it returns the centre" for its own sake. It
 * is that the value it returns lands **strictly inside the intended frame, with
 * enough room that microsecond quantisation cannot move it out**. That is the
 * whole reason the function exists: `video.currentTime` is a double that
 * Chromium truncates to whole microseconds, and addressing a frame at its
 * boundary loses that tie a third to two thirds of the time.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FPS,
  frameDurationMs,
  frameSampleMs,
  frameToMs,
  msToFrameFloor,
} from "./frames";

/** The rates a project can realistically run at, plus the awkward ones. */
const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

describe("frameSampleMs", () => {
  it("lands inside the frame it was asked for, for every rate", () => {
    for (const fps of RATES) {
      for (let frame = 0; frame < 2000; frame++) {
        const at = frameToMs(frame, fps);
        const sample = frameSampleMs(at, fps);
        expect(
          msToFrameFloor(sample, fps),
          `fps ${fps}, frame ${frame}: sample ${sample} fell outside its own frame`,
        ).toBe(frame);
      }
    }
  });

  /**
   * The margin is the point. One microsecond is what Chromium rounds by; half a
   * frame is what this buys, and the ratio is the safety factor.
   */
  it("keeps at least a third of a frame of clearance from either boundary", () => {
    for (const fps of RATES) {
      const frameMs = frameDurationMs(fps);
      for (let frame = 0; frame < 500; frame++) {
        const start = frameToMs(frame, fps);
        const sample = frameSampleMs(start, fps);
        const fromStart = sample - start;
        const toEnd = start + frameMs - sample;
        expect(fromStart).toBeGreaterThan(frameMs / 3);
        expect(toEnd).toBeGreaterThan(frameMs / 3);
        // A microsecond is 0.001ms. Even at 120fps half a frame is ~4.17ms.
        expect(Math.min(fromStart, toEnd)).toBeGreaterThan(1);
      }
    }
  });

  it("is the centre of the frame for an on-grid instant", () => {
    for (const fps of [24, 30, 60]) {
      for (const frame of [0, 1, 2, 59, 1000]) {
        expect(frameSampleMs(frameToMs(frame, fps), fps)).toBeCloseTo(
          frameToMs(frame, fps) + frameDurationMs(fps) / 2,
          9,
        );
      }
    }
  });

  /**
   * An off-grid instant takes the centre of the frame that *contains* it, not
   * its own value plus half a frame. The two differ for anything not already on
   * a boundary, and only the first is the frame actually being displayed.
   */
  it("takes the centre of the covering frame for an off-grid instant", () => {
    const fps = 60;
    const frameMs = frameDurationMs(fps);
    const centreOfFrame3 = frameToMs(3, fps) + frameMs / 2;

    for (const offset of [0, 0.001, frameMs * 0.25, frameMs * 0.5, frameMs * 0.99]) {
      const inside = frameToMs(3, fps) + offset;
      expect(frameSampleMs(inside, fps)).toBeCloseTo(centreOfFrame3, 9);
      expect(msToFrameFloor(frameSampleMs(inside, fps), fps)).toBe(3);
    }
  });

  it("is monotonic across frames", () => {
    const fps = 60;
    let previous = -Infinity;
    for (let frame = 0; frame < 5000; frame++) {
      const sample = frameSampleMs(frameToMs(frame, fps), fps);
      expect(sample).toBeGreaterThan(previous);
      previous = sample;
    }
  });

  it("falls back to the default rate rather than producing NaN", () => {
    const expected = frameDurationMs(DEFAULT_FPS) / 2;
    for (const bad of [0, -30, NaN, Infinity, null, undefined]) {
      expect(frameSampleMs(0, bad as unknown as number)).toBeCloseTo(expected, 9);
    }
  });

  /**
   * The regression this was written for, stated in its own terms.
   *
   * Truncating the request to whole microseconds — what Chromium does — and
   * then taking the frame at or below it must still give frame N. Addressing
   * the boundary instead fails this for 30 and 60 and is what shipped.
   */
  it("survives truncation to whole microseconds", () => {
    const truncateToMicroseconds = (ms: number) => Math.trunc(ms * 1000) / 1000;

    for (const fps of RATES) {
      let wrong = 0;
      for (let frame = 0; frame < 3000; frame++) {
        const sample = truncateToMicroseconds(frameSampleMs(frameToMs(frame, fps), fps));
        if (msToFrameFloor(sample, fps) !== frame) wrong++;
      }
      expect(wrong, `fps ${fps}: ${wrong} frames lost to microsecond truncation`).toBe(0);
    }

    // And the boundary addressing it replaced does not, which is the bug.
    const boundaryLosses = (fps: number) => {
      let wrong = 0;
      for (let frame = 0; frame < 3000; frame++) {
        const sample = truncateToMicroseconds(frameToMs(frame, fps));
        if (msToFrameFloor(sample, fps) !== frame) wrong++;
      }
      return wrong;
    };
    expect(boundaryLosses(30)).toBeGreaterThan(0);
    expect(boundaryLosses(60)).toBeGreaterThan(0);
  });
});
