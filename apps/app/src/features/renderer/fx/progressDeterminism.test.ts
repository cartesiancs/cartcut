/**
 * Preview and export must derive the same `progress` from the same frame.
 *
 * The regression guard for a divergence that already exists in the app and that
 * transitions are the first feature to make visible.
 *
 * `elementControl.step` drives the preview cursor from the wall clock —
 * `Date.now() - startTime` — so it lands on arbitrary integer milliseconds.
 * `renderTimeline` drives export from a frame index, `(n / fps) * 1000`. For
 * everything that existed before, sampling a keyframe a few milliseconds off
 * was invisible. Feeding it to a shader is not: `progress` becomes a different
 * number in the preview than in the render, and the exported file quietly does
 * not match what the user approved.
 *
 * `progressOf` snaps to the frame grid before doing anything else, which is why
 * these pass. Remove the snap and every case below fails.
 */

import { describe, it, expect } from "vitest";
import { progressOf } from "../../timeline/transitionGeometry";
import { frameTimeMs } from "../../export/frames";
import { msToFrameFloor } from "../../timeline/frames";
import type { TransitionElementType } from "../../../@types/timeline";

function transition(startTime: number, duration: number) {
  return { startTime, duration } as TransitionElementType;
}

describe("progress is derived from the frame, not the clock", () => {
  const t = transition(1000, 500);

  /**
   * The property that actually matters.
   *
   * A wall-clock cursor is an integer millisecond, so it cannot land on a frame
   * boundary at all at 60fps — 1033.33 is not representable. What it can do is
   * fall *within* a frame, and the guarantee is that every cursor value inside
   * frame `n` produces the progress export produces when it renders frame `n`.
   *
   * That is stronger than "the numbers happen to match at the boundary": it
   * says the preview cannot show a progress the render will never produce.
   */
  function agreesAt(cursorMs: number, fps: number): void {
    const frame = msToFrameFloor(cursorMs, fps);
    const fromPreview = progressOf(t, cursorMs, fps);
    const fromExport = progressOf(t, frameTimeMs(frame, fps), fps);
    expect(fromPreview).toBe(fromExport);
  }

  it("agrees with the export path at every integer millisecond", () => {
    // Every cursor value the preview could report across the transition.
    for (let cursorMs = 950; cursorMs <= 1550; cursorMs++) {
      agreesAt(cursorMs, 60);
    }
  });

  it("agrees at 24, 30 and 50 fps too", () => {
    for (const fps of [24, 30, 50]) {
      for (let cursorMs = 950; cursorMs <= 1550; cursorMs++) {
        agreesAt(cursorMs, fps);
      }
    }
  });

  it("moves in whole frames rather than continuously", () => {
    const fps = 60;
    // Frame 61 spans [1016.67, 1033.33), so these three cursors are all inside
    // it and the one after is not.
    const a = progressOf(t, 1017, fps);
    const b = progressOf(t, 1025, fps);
    const c = progressOf(t, 1033, fps);
    const next = progressOf(t, 1034, fps);

    expect(msToFrameFloor(1017, fps)).toBe(61);
    expect(msToFrameFloor(1033, fps)).toBe(61);
    expect(msToFrameFloor(1034, fps)).toBe(62);

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(next).not.toBe(a);
  });

  it("never reports a progress from a frame the render will not produce", () => {
    const fps = 30;
    const rendered = new Set<number>();
    for (let frame = 0; frame < 60; frame++) {
      rendered.add(progressOf(t, frameTimeMs(frame, fps), fps));
    }
    for (let cursorMs = 950; cursorMs <= 1550; cursorMs++) {
      expect(rendered.has(progressOf(t, cursorMs, fps))).toBe(true);
    }
  });
});

describe("progressOf", () => {
  const fps = 60;

  it("runs 0 to 1 across the window", () => {
    const t = transition(1000, 500);
    expect(progressOf(t, 1000, fps)).toBe(0);
    expect(progressOf(t, 1500, fps)).toBe(1);
    expect(progressOf(t, 1250, fps)).toBeCloseTo(0.5, 2);
  });

  it("clamps outside the window rather than extrapolating", () => {
    // A shader that received progress of -3 would sample far outside its
    // intended range; several gl-transitions shaders divide by it.
    const t = transition(1000, 500);
    expect(progressOf(t, 0, fps)).toBe(0);
    expect(progressOf(t, 99_000, fps)).toBe(1);
  });

  it("reports a finished transition for a zero-length window", () => {
    // Should be unreachable — `resolveDuration` never grants one — but a
    // division by zero here would put NaN into a uniform, and a NaN in a
    // shader is silent and total.
    const t = transition(1000, 0);
    expect(progressOf(t, 1000, fps)).toBe(1);
    expect(Number.isNaN(progressOf(t, 1000, fps))).toBe(false);
  });

  it("falls back to a usable frame rate rather than producing NaN", () => {
    const t = transition(1000, 500);
    expect(Number.isNaN(progressOf(t, 1250, 0))).toBe(false);
    expect(Number.isNaN(progressOf(t, 1250, NaN))).toBe(false);
  });
});
