import { describe, expect, it } from "vitest";

import type {
  EffectElementType,
  Timeline,
  TransitionElementType,
} from "../../@types/timeline";
import {
  audioElement,
  groupElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { buildCostCurve, type CostCurve } from "./cost";

const FPS = 10;
/** Ten seconds at 10fps, so one frame is 100ms and boundaries land exactly. */
const TOTAL_FRAMES = 100;

function effectElement(over: Partial<EffectElementType> = {}): EffectElementType {
  return {
    key: "fx",
    localpath: "EFFECT",
    trackId: "fx-1",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: 4000,
    filetype: "effect",
    presetId: "glow",
    params: {},
    intensity: 50,
    animation: { opacity: { isActivate: false, x: [], ax: [] } },
    ...over,
  } as EffectElementType;
}

function transitionElement(
  over: Partial<TransitionElementType> = {},
): TransitionElementType {
  return {
    key: "tr",
    localpath: "TRANSITION",
    trackId: "track-1",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: 1000,
    filetype: "transition",
    presetId: "crossfade",
    params: {},
    fromId: "a",
    toId: "b",
    alignment: "center",
    ...over,
  } as TransitionElementType;
}

/** The weight of one frame, read off the curve. */
function frameWeight(curve: CostCurve, frame: number): number {
  return curve.before(frame + 1) - curve.before(frame);
}

describe("buildCostCurve", () => {
  it("anchors at both ends", () => {
    const curve = buildCostCurve(
      { a: videoElement({ startTime: 2000, duration: 3000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    expect(curve.before(0)).toBe(0);
    expect(curve.before(TOTAL_FRAMES)).toBeCloseTo(curve.total, 9);
    // Past the end is still the end, not an extrapolation.
    expect(curve.before(TOTAL_FRAMES + 50)).toBeCloseTo(curve.total, 9);
    expect(curve.before(-5)).toBe(0);
  });

  it("is non-decreasing across every frame", () => {
    const curve = buildCostCurve(
      {
        a: videoElement({ startTime: 0, duration: 3000 }),
        b: textElement({ startTime: 1500, duration: 6000 }),
        c: imageElement({ startTime: 7000, duration: 3000 }),
      },
      TOTAL_FRAMES,
      FPS,
    );

    let previous = 0;
    for (let f = 0; f <= TOTAL_FRAMES; f++) {
      const at = curve.before(f);
      expect(at).toBeGreaterThanOrEqual(previous);
      expect(Number.isFinite(at)).toBe(true);
      previous = at;
    }
  });

  it("degrades to frame counting when every frame costs the same", () => {
    // The property that makes this layer safe to ship: a document whose weight
    // never changes must produce exactly the progress axis it replaces.
    for (const timeline of [
      {} as Timeline,
      { a: videoElement({ startTime: 0, duration: 10_000 }) },
    ]) {
      const curve = buildCostCurve(timeline, TOTAL_FRAMES, FPS);
      for (const f of [0, 1, 37, 99, TOTAL_FRAMES]) {
        expect(curve.before(f) / curve.total).toBeCloseTo(f / TOTAL_FRAMES, 9);
      }
    }
  });

  it("charges more where the timeline is busy", () => {
    // A video across the first half only. The first half must therefore be
    // worth more than half the total — which is the entire point of the file.
    const curve = buildCostCurve(
      { a: videoElement({ startTime: 0, duration: 5000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    expect(curve.before(50) / curve.total).toBeGreaterThan(0.5);
    expect(frameWeight(curve, 10)).toBeGreaterThan(frameWeight(curve, 90));
  });

  it("puts a clip's first frame where the renderer does", () => {
    // A clip starting at 1000ms in a 10fps project first appears on frame 10;
    // frame 9 is at 900ms and is outside its half-open window. Flooring the
    // start instead of ceiling it would charge for frame 9.
    const curve = buildCostCurve(
      { a: videoElement({ startTime: 1000, duration: 1000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    expect(frameWeight(curve, 9)).toBeCloseTo(frameWeight(curve, 0), 9);
    expect(frameWeight(curve, 10)).toBeGreaterThan(frameWeight(curve, 9));
    // And its last frame is 19, not 20.
    expect(frameWeight(curve, 19)).toBeGreaterThan(frameWeight(curve, 20));
  });

  it("prices a second video below the first, because seeks run in parallel", () => {
    const one = buildCostCurve(
      { a: videoElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    const two = buildCostCurve(
      {
        a: videoElement({ startTime: 0, duration: 10_000 }),
        b: videoElement({ key: "b", startTime: 0, duration: 10_000 }),
      },
      TOTAL_FRAMES,
      FPS,
    );

    const first = frameWeight(one, 5) - 1; // net of FRAME_BASE
    const both = frameWeight(two, 5) - 1;
    expect(both).toBeGreaterThan(first);
    expect(both).toBeLessThan(first * 2);
  });

  it("charges extra for a filtered video", () => {
    const plain = buildCostCurve(
      { a: videoElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    const filtered = buildCostCurve(
      {
        a: videoElement({
          startTime: 0,
          duration: 10_000,
          filter: { enable: true, list: ["blur"] as never },
        }),
      },
      TOTAL_FRAMES,
      FPS,
    );
    expect(frameWeight(filtered, 5)).toBeGreaterThan(frameWeight(plain, 5));
  });

  it("ignores a filter that is enabled but empty", () => {
    // `videoPipeline` runs no passes for an empty list, so neither does this.
    const empty = buildCostCurve(
      {
        a: videoElement({
          startTime: 0,
          duration: 10_000,
          filter: { enable: true, list: [] },
        }),
      },
      TOTAL_FRAMES,
      FPS,
    );
    const off = buildCostCurve(
      { a: videoElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    expect(frameWeight(empty, 5)).toBeCloseTo(frameWeight(off, 5), 9);
  });

  it("charges the scratch canvas once however many effects overlap", () => {
    const one = buildCostCurve(
      { e: effectElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    const three = buildCostCurve(
      {
        e: effectElement({ startTime: 0, duration: 10_000 }),
        f: effectElement({ key: "f", startTime: 0, duration: 10_000 }),
        g: effectElement({ key: "g", startTime: 0, duration: 10_000 }),
      },
      TOTAL_FRAMES,
      FPS,
    );
    const oneNet = frameWeight(one, 5) - 1;
    const threeNet = frameWeight(three, 5) - 1;
    // Three effects share one scratch buffer, so this is well under 3x.
    expect(threeNet).toBeGreaterThan(oneNet);
    expect(threeNet).toBeLessThan(oneNet * 2);
  });

  it("costs more inside a transition's window than outside it", () => {
    const timeline: Timeline = {
      a: videoElement({ key: "a", startTime: 0, duration: 5000 }),
      b: videoElement({ key: "b", startTime: 5000, duration: 5000 }),
      t: transitionElement({ startTime: 4500, duration: 1000 }),
    };
    const curve = buildCostCurve(timeline, TOTAL_FRAMES, FPS);
    // Frame 48 is at 4800ms, inside the transition; frame 20 is not.
    expect(frameWeight(curve, 48)).toBeGreaterThan(frameWeight(curve, 20));
  });

  it("charges nothing for elements that paint nothing", () => {
    const bare = buildCostCurve(
      { a: imageElement({ startTime: 0, duration: 10_000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    const withGhosts = buildCostCurve(
      {
        a: imageElement({ startTime: 0, duration: 10_000 }),
        g: groupElement({ key: "g", startTime: 0, duration: 10_000 }),
        s: audioElement({ startTime: 0, duration: 10_000 }),
      },
      TOTAL_FRAMES,
      FPS,
    );
    // A group holds a transform for its children and draws nothing; audio has
    // no picture at all. Both are excluded by the same guard the paint loop
    // uses, and this pins that they stay excluded.
    expect(frameWeight(withGhosts, 5)).toBeCloseTo(frameWeight(bare, 5), 9);
  });

  it("answers a backwards query correctly, not just a forward one", () => {
    const curve = buildCostCurve(
      { a: videoElement({ startTime: 3000, duration: 2000 }) },
      TOTAL_FRAMES,
      FPS,
    );
    const forward = [10, 40, 70].map((f) => curve.before(f));
    const backward = [70, 40, 10].map((f) => curve.before(f)).reverse();
    expect(backward).toEqual(forward);
  });

  it("falls back to a uniform curve on degenerate input", () => {
    const timeline: Timeline = {
      a: videoElement({ startTime: 0, duration: 5000 }),
    };

    for (const curve of [
      buildCostCurve(timeline, 0, FPS),
      buildCostCurve(timeline, Number.NaN, FPS),
      buildCostCurve(timeline, -10, FPS),
    ]) {
      expect(curve.total).toBe(0);
      expect(curve.before(10)).toBe(0);
    }

    // A rate of zero cannot place a frame on the timeline, so the shape is
    // unknowable — but the export still has frames to count.
    const noFps = buildCostCurve(timeline, TOTAL_FRAMES, 0);
    expect(noFps.total).toBe(TOTAL_FRAMES);
    expect(noFps.before(25)).toBe(25);
  });

  it("survives an element with a non-finite span", () => {
    const curve = buildCostCurve(
      {
        a: videoElement({ startTime: 0, duration: 5000 }),
        bad: imageElement({ key: "bad", startTime: Number.NaN, duration: 100 }),
      },
      TOTAL_FRAMES,
      FPS,
    );
    expect(Number.isFinite(curve.total)).toBe(true);
    expect(curve.total).toBeGreaterThan(0);
    expect(curve.before(TOTAL_FRAMES)).toBeCloseTo(curve.total, 9);
  });
});
