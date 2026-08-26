/**
 * The `time` uniform has to be the same in the preview and in the render.
 *
 * Same hazard as `progress`, and the same fix — see
 * `progressDeterminism.test.ts` for the long version. The preview cursor is a
 * wall-clock millisecond (`Date.now()` in `elementControl.step`), export walks
 * frame indices. Feed the raw difference to a noise function and the grain in
 * the exported file is not the grain the user approved.
 */

import { describe, it, expect } from "vitest";
import { effectTimeOf } from "./effectTime";
import { frameTimeMs } from "../../export/frames";
import { msToFrameFloor } from "../../timeline/frames";
import type { EffectElementType } from "../../../@types/timeline";

function effect(startTime: number): EffectElementType {
  return { startTime } as EffectElementType;
}

describe("effectTimeOf", () => {
  it("counts from the effect's own start, not the timeline origin", () => {
    // An effect dragged elsewhere on the timeline must animate identically.
    const early = effect(0);
    const late = effect(30_000);
    expect(effectTimeOf(early, 1000, 60)).toBeCloseTo(
      effectTimeOf(late, 31_000, 60),
      6,
    );
  });

  it("is seconds", () => {
    expect(effectTimeOf(effect(0), 2000, 60)).toBeCloseTo(2, 3);
  });

  it("never goes negative before the effect starts", () => {
    // A negative time through `fract`/`mod` puts a discontinuity exactly on the
    // clip's first frame.
    expect(effectTimeOf(effect(5000), 0, 60)).toBe(0);
    expect(effectTimeOf(effect(5000), 4999, 60)).toBe(0);
  });

  it("agrees between the two sampling paths at every integer millisecond", () => {
    const el = effect(1000);
    for (const fps of [24, 30, 60]) {
      for (let cursorMs = 1000; cursorMs <= 3000; cursorMs++) {
        const frame = msToFrameFloor(cursorMs, fps);
        const fromPreview = effectTimeOf(el, cursorMs, fps);
        const fromExport = effectTimeOf(el, frameTimeMs(frame, fps), fps);
        expect(fromPreview).toBe(fromExport);
      }
    }
  });

  it("holds still within one frame and moves at the boundary", () => {
    const el = effect(0);
    const fps = 60;
    // Frame 61 spans [1016.67, 1033.33).
    expect(effectTimeOf(el, 1017, fps)).toBe(effectTimeOf(el, 1033, fps));
    expect(effectTimeOf(el, 1034, fps)).not.toBe(effectTimeOf(el, 1017, fps));
  });

  it("survives a missing frame rate rather than producing NaN", () => {
    expect(Number.isNaN(effectTimeOf(effect(0), 1000, 0))).toBe(false);
    expect(Number.isNaN(effectTimeOf(effect(0), 1000, NaN))).toBe(false);
  });
});
