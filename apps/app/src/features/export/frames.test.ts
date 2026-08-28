import { describe, it, expect } from "vitest";
import {
  frameByteLength,
  frameCount,
  frameTimeMs,
  inFlightWindow,
} from "./frames";
import {
  DEFAULT_FPS,
  frameToMs,
  isFrameAligned,
  msToFrame,
} from "../timeline/frames";

describe("frameCount", () => {
  it("is exact for integer durations", () => {
    expect(frameCount({ duration: 10, fps: 60 })).toBe(600);
    expect(frameCount({ duration: 1, fps: 25 })).toBe(25);
    expect(frameCount({ duration: 2, fps: 10 })).toBe(20);
  });

  it("rounds instead of letting float error add a frame", () => {
    // 2.2 * 25 === 55.00000000000001, which a `frame < total` loop runs 56
    // times — the last one rendering past the end of the project.
    expect(2.2 * 25).toBeGreaterThan(55);
    expect(frameCount({ duration: 2.2, fps: 25 })).toBe(55);

    expect(4.4 * 25).toBeGreaterThan(110);
    expect(frameCount({ duration: 4.4, fps: 25 })).toBe(110);
  });

  it("rounds to nearest, not toward zero", () => {
    expect(frameCount({ duration: 1.009, fps: 60 })).toBe(61);
    expect(frameCount({ duration: 1.001, fps: 60 })).toBe(60);
  });

  it("is zero for an empty or degenerate project", () => {
    expect(frameCount({ duration: 0, fps: 60 })).toBe(0);
    expect(frameCount({ duration: -1, fps: 60 })).toBe(0);
    expect(frameCount({ duration: 10, fps: 0 })).toBe(0);
    expect(frameCount({ duration: Number.NaN, fps: 60 })).toBe(0);
  });
});

describe("frameTimeMs", () => {
  it("maps frame index to timecode by fps", () => {
    expect(frameTimeMs(0, 60)).toBe(0);
    expect(frameTimeMs(1, 25)).toBe(40);
    expect(frameTimeMs(24, 25)).toBe(960);
  });
});

describe("inFlightWindow", () => {
  it("allows the maximum overlap at ordinary frame sizes", () => {
    expect(inFlightWindow(1280, 720)).toBe(4);
    expect(inFlightWindow(1920, 1080)).toBe(4);
  });

  it("narrows the window rather than holding hundreds of megabytes", () => {
    // A flat window of four would be 126 MB in flight at 4K.
    expect(inFlightWindow(3840, 2160)).toBe(2);
    expect(inFlightWindow(7680, 4320)).toBe(2);
  });

  it("never drops to lockstep, which is the case being fixed", () => {
    for (const [w, h] of [
      [16, 16],
      [1920, 1080],
      [3840, 2160],
      [15360, 8640],
    ]) {
      expect(inFlightWindow(w, h)).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps what it admits under the byte budget, once past the minimum", () => {
    const budget = 64 * 1024 * 1024;
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
    ]) {
      expect(inFlightWindow(w, h) * frameByteLength(w, h)).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  it("degenerates safely on a zero-sized frame", () => {
    expect(inFlightWindow(0, 0)).toBe(2);
  });
});

/**
 * The exporter and the editor must sample the timeline at the *same* doubles.
 *
 * `(k / fps) * 1000` and `(k * 1000) / fps` are equal in arithmetic and not in
 * IEEE-754, and the gap is enough to put a clip's start one ULP above the
 * instant the exporter samples — at which point `t >= start` is false and the
 * clip loses its own first frame. `frameTimeMs` used to hold its own copy of
 * the expression with a comment asking the two to stay in step; it now calls
 * through, and this is what holds that.
 */
describe("frameTimeMs against the editor's frame grid", () => {
  const RATES = [24, 25, 30, 50, 60, 120];

  it("is bit-identical to frameToMs at every rate", () => {
    for (const fps of RATES) {
      for (let frame = 0; frame <= 20_000; frame++) {
        if (!Object.is(frameTimeMs(frame, fps), frameToMs(frame, fps))) {
          throw new Error(`frame ${frame} at ${fps}fps disagrees`);
        }
      }
    }
  });

  it("agrees with the frame the timeline would snap to", () => {
    for (const fps of RATES) {
      for (let frame = 0; frame < 5_000; frame++) {
        const t = frameTimeMs(frame, fps);
        expect(isFrameAligned(t, fps)).toBe(true);
        expect(msToFrame(t, fps)).toBe(frame);
      }
    }
  });

  it("guards a rate the loop should never have been handed", () => {
    // The delegation picks this up for free; the open-coded division returned
    // `Infinity` and rendered nothing.
    expect(Number.isFinite(frameTimeMs(10, 0))).toBe(true);
    expect(frameTimeMs(10, 0)).toBe(frameToMs(10, DEFAULT_FPS));
  });
});
