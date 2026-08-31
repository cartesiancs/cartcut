import { describe, expect, it } from "vitest";
import {
  DEFAULT_FPS,
  FPS_PRESETS,
  MAX_FPS,
  MIN_FPS,
  coerceFps,
  frameStartMs,
  GRID_HIDE_PX,
  GRID_SHOW_PX,
  frameDurationMs,
  frameToMs,
  framePx,
  isFrameAligned,
  msToFrame,
  msToFrameCeil,
  msToFrameFloor,
  normalizeFps,
  planFrameGrid,
  isFrameLocked,
  shouldShowFrameGrid,
  snapMsToFrame,
  stepCursorByFrames,
} from "./frames";
import { msToPxSigned, pxToMsSigned } from "./geometry";
import { xAtTime } from "./layout";
import { MAX_RANGE } from "./zoom";
import {
  audioElement,
  gifElement,
  imageElement,
  mulberry32,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { isAudibleElement } from "./audio";

/** The rates a project plausibly runs at, plus two awkward ones. */
const RATES = [24, 25, 30, 50, 60, 120];

describe("normalizeFps", () => {
  it("passes a usable rate through", () => {
    expect(normalizeFps(24)).toBe(24);
    expect(normalizeFps(29.97)).toBe(29.97);
  });

  it("falls back for anything unusable", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(normalizeFps(bad)).toBe(DEFAULT_FPS);
    }
    expect(normalizeFps(undefined as unknown as number)).toBe(DEFAULT_FPS);
    expect(normalizeFps(null as unknown as number)).toBe(DEFAULT_FPS);
  });
});

describe("frameDurationMs", () => {
  it("divides the second", () => {
    expect(frameDurationMs(25)).toBe(40);
    expect(frameDurationMs(50)).toBe(20);
    expect(frameDurationMs(60)).toBeCloseTo(16.6667, 4);
    expect(frameDurationMs(24)).toBeCloseTo(41.6667, 4);
  });
});

describe("frameToMs", () => {
  it("lands exactly on whole seconds", () => {
    for (const fps of RATES) {
      expect(frameToMs(fps, fps)).toBe(1000);
      expect(frameToMs(fps * 3, fps)).toBe(3000);
    }
  });

  it("is zero at zero, for either sign of the index", () => {
    expect(frameToMs(0, 60)).toBe(0);
    expect(frameToMs(-0, 60)).toBe(0);
  });

  it("produces the exporter's sample instant, bit for bit", () => {
    // `renderTimeline.ts:47` computes `(currentFrame / fps) * 1000`. Writing it
    // the other way round — `(frame * 1000) / fps` — is equal in arithmetic and
    // not in IEEE-754: it disagrees on 27% of the first 200k frames at 60fps.
    // A clip placed one ULP above the sampled instant fails `t >= start` and
    // loses its own first frame, so this equality is the whole feature.
    for (const fps of RATES) {
      for (let frame = 0; frame < 5000; frame++) {
        expect(frameToMs(frame, fps)).toBe((frame / fps) * 1000);
      }
    }
  });

  it("differs from the naive expression often enough to matter", () => {
    // Guards the comment above: if this ever stops being true, the equality
    // test has stopped proving anything.
    let differing = 0;
    for (let frame = 0; frame < 20_000; frame++) {
      if (frameToMs(frame, 60) !== (frame * 1000) / 60) {
        differing++;
      }
    }
    expect(differing).toBeGreaterThan(1000);
  });
});

describe("msToFrame", () => {
  it("rounds to the nearest frame", () => {
    expect(msToFrame(0, 60)).toBe(0);
    expect(msToFrame(8, 60)).toBe(0);
    expect(msToFrame(9, 60)).toBe(1);
    expect(msToFrame(50, 60)).toBe(3);
    expect(msToFrame(2000, 60)).toBe(120);
  });

  it("handles negative times, and never yields negative zero", () => {
    expect(msToFrame(-16.7, 60)).toBe(-1);
    // `Math.round(-0.48)` is `-0`; frame zero is frame zero.
    expect(Object.is(msToFrame(-8, 60), 0)).toBe(true);
    expect(Object.is(msToFrameCeil(-8, 60), 0)).toBe(true);
    expect(Object.is(frameToMs(-0, 60), 0)).toBe(true);
  });

  it("round-trips every frame index, at every rate", () => {
    // The property the whole module rests on, checked exhaustively rather than
    // by sampling: a frame instant must name its own frame back.
    for (const fps of RATES) {
      for (let frame = 0; frame <= 50_000; frame++) {
        expect(msToFrame(frameToMs(frame, fps), fps)).toBe(frame);
      }
    }
  });
});

describe("msToFrameFloor / msToFrameCeil", () => {
  it("recovers the exact index on a boundary", () => {
    // Without the epsilon this fails on real values: over the first 100k frames
    // at 60fps a bare `Math.floor` returns `n - 1` for 2,793 of them.
    for (const fps of RATES) {
      for (let frame = 0; frame <= 20_000; frame++) {
        const ms = frameToMs(frame, fps);
        expect(msToFrameFloor(ms, fps)).toBe(frame);
        expect(msToFrameCeil(ms, fps)).toBe(frame);
      }
    }
  });

  it("brackets an off-grid time", () => {
    expect(msToFrameFloor(49.9, 60)).toBe(2);
    expect(msToFrameCeil(49.9, 60)).toBe(3);
    expect(msToFrameFloor(50.1, 60)).toBe(3);
    expect(msToFrameCeil(50.1, 60)).toBe(4);
  });
});

describe("snapMsToFrame", () => {
  it("returns an already-aligned time bit-identically", () => {
    // The drag code's no-op rule depends on this: a gesture that moves nothing
    // must yield a delta of exactly 0 so `withCheckpoint` records no undo step.
    for (const fps of RATES) {
      for (let frame = 0; frame < 5000; frame++) {
        const ms = frameToMs(frame, fps);
        expect(snapMsToFrame(ms, fps)).toBe(ms);
      }
    }
  });

  it("is idempotent on arbitrary input", () => {
    const random = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const ms = random() * 600_000;
      const once = snapMsToFrame(ms, 60);
      expect(snapMsToFrame(once, 60)).toBe(once);
    }
  });

  it("never moves a time by more than half a frame", () => {
    const random = mulberry32(11);
    for (const fps of RATES) {
      const half = frameDurationMs(fps) / 2;
      for (let i = 0; i < 200; i++) {
        const ms = random() * 600_000;
        expect(Math.abs(snapMsToFrame(ms, fps) - ms)).toBeLessThanOrEqual(
          half + 1e-9,
        );
      }
    }
  });
});

describe("isFrameAligned", () => {
  it("tolerates the float noise a real edit introduces", () => {
    // A quantized time reaches the document as `start + (target - start)`,
    // which IEEE-754 does not promise equals `target`.
    const target = frameToMs(437, 60);
    const throughAnEdit = 596_567.47 + (target - 596_567.47);
    expect(throughAnEdit).not.toBe(target);
    expect(isFrameAligned(throughAnEdit, 60)).toBe(true);
  });

  it("rejects a genuinely off-grid time", () => {
    expect(isFrameAligned(frameToMs(3, 60) + 1, 60)).toBe(false);
    expect(isFrameAligned(1988.888, 60)).toBe(false);
  });
});

describe("stepCursorByFrames", () => {
  it("does not drift over many steps", () => {
    let cursor = 0;
    for (let i = 0; i < 10_000; i++) {
      cursor = stepCursorByFrames(cursor, 1, 60);
    }
    expect(cursor).toBe(frameToMs(10_000, 60));
  });

  it("beats the accumulating step it replaces", () => {
    // `increaseCursor(1000 / 60)` sixty times gives 999.9999999999991.
    let naive = 0;
    for (let i = 0; i < 60; i++) {
      naive += 1000 / 60;
    }
    expect(naive).not.toBe(1000);

    let stepped = 0;
    for (let i = 0; i < 60; i++) {
      stepped = stepCursorByFrames(stepped, 1, 60);
    }
    expect(stepped).toBe(1000);
  });

  it("returns to the start after going forward and back", () => {
    let cursor = frameToMs(500, 30);
    for (let i = 0; i < 2000; i++) {
      cursor = stepCursorByFrames(cursor, 1, 30);
    }
    for (let i = 0; i < 2000; i++) {
      cursor = stepCursorByFrames(cursor, -1, 30);
    }
    expect(cursor).toBe(frameToMs(500, 30));
  });

  it("pulls an off-grid cursor onto the grid on the first press", () => {
    const next = stepCursorByFrames(1988.888, 1, 60);
    expect(isFrameAligned(next, 60)).toBe(true);
    expect(msToFrame(next, 60)).toBe(msToFrame(1988.888, 60) + 1);
  });

  it("clamps at zero rather than going negative", () => {
    expect(stepCursorByFrames(0, -1, 60)).toBe(0);
    expect(stepCursorByFrames(frameToMs(1, 60), -5, 60)).toBe(0);
  });
});

describe("framePx", () => {
  it("agrees with the shared px/ms conversion", () => {
    // Cross-checked rather than re-derived, so the two can never drift apart.
    for (const fps of RATES) {
      for (const range of [0.9, 5, 20, MAX_RANGE]) {
        expect(framePx(range, fps)).toBe(
          msToPxSigned(frameDurationMs(fps), range),
        );
      }
    }
  });

  it("puts a 60fps frame at 50px at maximum zoom", () => {
    // The reason `MAX_RANGE` is 60. At the old ceiling of ~9.93 this was 8.3px.
    expect(framePx(MAX_RANGE, 60)).toBeCloseTo(50, 6);
    expect(framePx(9.933071490757152, 60)).toBeCloseTo(8.28, 2);
  });

  it("grows with zoom and shrinks with frame rate", () => {
    expect(framePx(5, 60)).toBeGreaterThan(framePx(0.9, 60));
    expect(framePx(5, 24)).toBeGreaterThan(framePx(5, 60));
  });
});

describe("shouldShowFrameGrid", () => {
  it("is off at the default zoom and on near the top", () => {
    expect(shouldShowFrameGrid(0.9, 60, false)).toBe(false);
    expect(shouldShowFrameGrid(MAX_RANGE, 60, false)).toBe(true);
  });

  it("switches on within a hair of the show threshold", () => {
    // Reconstructing the exact range for a given `framePx` is not possible in
    // floating point — it lands a few ULPs either side — so the threshold is
    // bracketed rather than hit.
    const rangeFor = (px: number) => (px * 20) / frameDurationMs(60);
    expect(shouldShowFrameGrid(rangeFor(GRID_SHOW_PX + 0.01), 60, false)).toBe(
      true,
    );
    expect(shouldShowFrameGrid(rangeFor(GRID_SHOW_PX - 0.01), 60, false)).toBe(
      false,
    );
  });

  it("holds the previous answer inside the hysteresis band", () => {
    const band = (GRID_SHOW_PX + GRID_HIDE_PX) / 2;
    const range = (band * 20) / frameDurationMs(60);
    expect(shouldShowFrameGrid(range, 60, true)).toBe(true);
    expect(shouldShowFrameGrid(range, 60, false)).toBe(false);
  });

  it("ignores the previous answer outside the band", () => {
    expect(shouldShowFrameGrid(MAX_RANGE, 60, false)).toBe(true);
    expect(shouldShowFrameGrid(0.9, 60, true)).toBe(false);
  });

  it("switches at most once in each direction across a full sweep", () => {
    // What the hysteresis is for: dragging the zoom slider through the
    // threshold must not strobe the grid on and off.
    let showing = false;
    let transitions = 0;
    const steps = 4000;
    for (let i = 0; i <= steps; i++) {
      const range = 0.9 + ((MAX_RANGE - 0.9) * i) / steps;
      const next = shouldShowFrameGrid(range, 60, showing);
      if (next !== showing) {
        transitions++;
      }
      showing = next;
    }
    for (let i = steps; i >= 0; i--) {
      const range = 0.9 + ((MAX_RANGE - 0.9) * i) / steps;
      const next = shouldShowFrameGrid(range, 60, showing);
      if (next !== showing) {
        transitions++;
      }
      showing = next;
    }
    expect(transitions).toBe(2);
    expect(showing).toBe(false);
  });
});

describe("planFrameGrid", () => {
  const RANGE = MAX_RANGE;
  const FPS = 60;

  it("places every line on a global frame boundary", () => {
    const xs = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 0,
      x1: 400,
      fps: FPS,
    });
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) {
      const frame = msToFrame(pxToMsSigned(x, RANGE), FPS);
      expect(Math.abs(x - xAtTime(frameToMs(frame, FPS), RANGE, 0))).toBeLessThan(
        0.5001,
      );
    }
  });

  it("agrees with layout.xAtTime", () => {
    const hScroll = 137;
    const xs = planFrameGrid({
      range: RANGE,
      hScroll,
      x0: 0,
      x1: 300,
      fps: FPS,
    });
    const first = msToFrameCeil(pxToMsSigned(hScroll, RANGE), FPS);
    xs.forEach((x, i) => {
      expect(x).toBe(
        Math.round(xAtTime(frameToMs(first + i, FPS), RANGE, hScroll)),
      );
    });
  });

  it("is anchored globally, not to the window it was asked about", () => {
    // The property that makes lines continue across a cut: two clips starting
    // at unrelated offsets must produce lines from the same lattice.
    const a = planFrameGrid({ range: RANGE, hScroll: 0, x0: 0, x1: 200, fps: FPS });
    const b = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 73,
      x1: 200,
      fps: FPS,
    });
    for (const x of b) {
      expect(a).toContain(x);
    }
  });

  it("tiles two adjacent windows without a gap or a duplicate", () => {
    const whole = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 0,
      x1: 400,
      fps: FPS,
    });
    const left = planFrameGrid({ range: RANGE, hScroll: 0, x0: 0, x1: 200, fps: FPS });
    const right = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 200,
      x1: 400,
      fps: FPS,
    });
    expect([...new Set([...left, ...right])].sort((p, q) => p - q)).toEqual(whole);
  });

  it("shifts by exactly the scroll", () => {
    const at0 = planFrameGrid({ range: RANGE, hScroll: 0, x0: 0, x1: 400, fps: FPS });
    const at50 = planFrameGrid({
      range: RANGE,
      hScroll: 50,
      x0: -50,
      x1: 350,
      fps: FPS,
    });
    expect(at50).toEqual(at0.map((x) => x - 50));
  });

  it("stays inside the window and stays ordered", () => {
    const random = mulberry32(3);
    for (let i = 0; i < 300; i++) {
      const range = 1 + random() * (MAX_RANGE - 1);
      const hScroll = random() * 100_000;
      const x0 = random() * 200;
      const x1 = x0 + random() * 800;
      const xs = planFrameGrid({ range, hScroll, x0, x1, fps: FPS });
      for (let k = 1; k < xs.length; k++) {
        expect(xs[k]).toBeGreaterThan(xs[k - 1]);
      }
      for (const x of xs) {
        // Rounded to whole pixels, so a line may sit half a pixel outside.
        expect(x).toBeGreaterThanOrEqual(Math.round(x0) - 1);
        expect(x).toBeLessThanOrEqual(Math.round(x1) + 1);
      }
    }
  });

  it("returns roughly one line per frame of window", () => {
    const xs = planFrameGrid({ range: RANGE, hScroll: 0, x0: 0, x1: 400, fps: FPS });
    expect(xs.length).toBeGreaterThanOrEqual(400 / framePx(RANGE, FPS) - 1);
    expect(xs.length).toBeLessThanOrEqual(400 / framePx(RANGE, FPS) + 1);
  });

  it("is empty for a degenerate window", () => {
    const base = { range: RANGE, hScroll: 0, fps: FPS };
    expect(planFrameGrid({ ...base, x0: 100, x1: 100 })).toEqual([]);
    expect(planFrameGrid({ ...base, x0: 200, x1: 100 })).toEqual([]);
    expect(planFrameGrid({ ...base, x0: 0, x1: 400, range: 0 })).toEqual([]);
  });

  it("returns exactly one line for a window holding one boundary", () => {
    const x = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 0,
      x1: 400,
      fps: FPS,
    })[2];
    expect(planFrameGrid({ range: RANGE, hScroll: 0, x0: x - 1, x1: x + 1, fps: FPS }))
      .toEqual([x]);
  });

  it("refuses to plan an absurd number of lines", () => {
    // A mis-set zoom must degrade to "no grid", not to a million-element array.
    expect(
      planFrameGrid({ range: 0.001, hScroll: 0, x0: 0, x1: 100_000, fps: FPS }),
    ).toEqual([]);
  });

  it("falls back to the default rate rather than throwing", () => {
    const xs = planFrameGrid({
      range: RANGE,
      hScroll: 0,
      x0: 0,
      x1: 200,
      fps: 0,
    });
    expect(xs).toEqual(
      planFrameGrid({ range: RANGE, hScroll: 0, x0: 0, x1: 200, fps: DEFAULT_FPS }),
    );
  });
});

/**
 * `coerceFps` is the write guard, and the whole point of it is that a rate
 * reaching the store is already a whole positive number in the supported band —
 * so no reader downstream has to ask. These pin what "already" means.
 */
describe("coerceFps", () => {
  it("passes every preset through untouched", () => {
    for (const fps of FPS_PRESETS) {
      expect(coerceFps(fps)).toBe(fps);
    }
  });

  it("accepts any integer between the bounds", () => {
    for (const fps of [MIN_FPS, 2, 12, 48, 90, 144, MAX_FPS]) {
      expect(coerceFps(fps)).toBe(fps);
    }
  });

  it("rounds a fractional rate to the nearest whole one", () => {
    // A number input can hand back a float for reasons that have nothing to do
    // with intent, and 29.97 is a rate this app deliberately does not support.
    expect(coerceFps(59.999999)).toBe(60);
    expect(coerceFps(29.97)).toBe(30);
    expect(coerceFps(23.976)).toBe(24);
    expect(coerceFps(59.94)).toBe(60);
    expect(coerceFps(30.4)).toBe(30);
    expect(coerceFps(30.5)).toBe(31);
  });

  it("clamps to the supported band", () => {
    expect(coerceFps(1000)).toBe(MAX_FPS);
    expect(coerceFps(MAX_FPS + 1)).toBe(MAX_FPS);
    // Rounds first, so anything above zero survives as at least one frame.
    expect(coerceFps(0.4)).toBe(MIN_FPS);
    expect(coerceFps(0.6)).toBe(MIN_FPS);
  });

  it("falls back for anything that is not a usable rate", () => {
    for (const bad of [0, -1, -60, NaN, Infinity, -Infinity]) {
      expect(coerceFps(bad)).toBe(DEFAULT_FPS);
    }
    for (const bad of [null, undefined, {}, [], "", "abc", true, false]) {
      expect(coerceFps(bad)).toBe(DEFAULT_FPS);
    }
  });

  it("reads a numeric string, because a form field is where it comes from", () => {
    expect(coerceFps("30")).toBe(30);
    expect(coerceFps(" 120 ")).toBe(120);
  });

  it("is idempotent", () => {
    for (const value of [0, 29.97, 1000, NaN, "30", 24]) {
      expect(coerceFps(coerceFps(value))).toBe(coerceFps(value));
    }
  });

  it("never returns something normalizeFps would reject", () => {
    for (const value of [0, -5, NaN, 1e9, "x", 47.3]) {
      const fps = coerceFps(value);
      expect(Number.isInteger(fps)).toBe(true);
      expect(normalizeFps(fps)).toBe(fps);
    }
  });
});

describe("frameStartMs", () => {
  it("is the frame boundary at or before the instant", () => {
    for (const fps of RATES) {
      const step = frameDurationMs(fps);
      for (let frame = 0; frame < 400; frame++) {
        const start = frameToMs(frame, fps);
        expect(frameStartMs(start, fps)).toBeCloseTo(start, 9);
        // Anywhere inside the frame answers with the same boundary.
        expect(frameStartMs(start + step * 0.25, fps)).toBeCloseTo(start, 9);
        expect(frameStartMs(start + step * 0.99, fps)).toBeCloseTo(start, 9);
      }
    }
  });

  it("lands on a frame boundary for any instant at all", () => {
    const random = mulberry32(4242);
    for (const fps of RATES) {
      for (let i = 0; i < 500; i++) {
        const ms = random() * 600_000;
        expect(isFrameAligned(frameStartMs(ms, fps), fps)).toBe(true);
        expect(frameStartMs(ms, fps)).toBeLessThanOrEqual(ms + 1e-6);
      }
    }
  });

  it("reproduces the expression the three clocks used to open-code", () => {
    // `effectTimeOf`, `progressOf` and playback all held their own copy of
    // this. Bit-identical, not close: the effect clock feeds a shader uniform
    // that the export has to reproduce exactly.
    const random = mulberry32(7);
    for (const fps of RATES) {
      for (let i = 0; i < 2000; i++) {
        const ms = random() * 3_600_000;
        expect(
          Object.is(
            frameStartMs(ms, fps),
            frameToMs(msToFrameFloor(ms, fps), fps),
          ),
        ).toBe(true);
      }
    }
  });

  it("never returns negative zero, and never precedes zero", () => {
    for (const fps of RATES) {
      expect(Object.is(frameStartMs(0, fps), 0)).toBe(true);
      expect(Object.is(frameStartMs(0.0001, fps), 0)).toBe(true);
    }
  });

  it("guards an unusable rate the way every other reader does", () => {
    expect(frameStartMs(1000, 0)).toBe(frameStartMs(1000, DEFAULT_FPS));
    expect(frameStartMs(1000, NaN)).toBe(frameStartMs(1000, DEFAULT_FPS));
  });
});

describe("isFrameLocked", () => {
  // The grid is a picture constraint. Every element type that draws is bound by
  // it; the one that only makes a sound is not.
  it("holds every drawn element on the grid", () => {
    expect(isFrameLocked(videoElement())).toBe(true);
    expect(isFrameLocked(imageElement())).toBe(true);
    expect(isFrameLocked(gifElement())).toBe(true);
    expect(isFrameLocked(textElement())).toBe(true);
    expect(isFrameLocked(shapeElement())).toBe(true);
  });

  it("lets audio off it", () => {
    expect(isFrameLocked(audioElement())).toBe(false);
  });

  // The two predicates read the same field and answer opposite questions, so
  // reaching for the wrong one compiles and very nearly works. A video with
  // sound is the case that tells them apart: audible, and still drawn.
  it("is not `isAudibleElement` — a noisy video stays locked", () => {
    const noisy = videoElement({ isExistAudio: true });
    expect(isAudibleElement(noisy)).toBe(true);
    expect(isFrameLocked(noisy)).toBe(true);

    // And the mirror image: a detached video is silent but still drawn.
    const silenced = videoElement({ isExistAudio: true, audioDetached: true });
    expect(isAudibleElement(silenced)).toBe(false);
    expect(isFrameLocked(silenced)).toBe(true);
  });
});
