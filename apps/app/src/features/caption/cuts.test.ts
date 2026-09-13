import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import type { TimeRange } from "../timeline/clipOps";
import {
  linesFromWordGroups,
  removeLine,
  removedSpans,
  type CaptionLine,
} from "./lines";
import { EMPTY_CUT_PLAN, planCuts, sourceWindowOf } from "./cuts";

/** A 10s clip at 1x, untrimmed, sitting at timeline 0. */
const plain = () =>
  videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 10_000,
    trim: { startTime: 0, endTime: 10_000 },
    sourceDuration: 10_000,
  });

/** The same footage trimmed to source 2s..8s, placed at timeline 1s. */
const trimmed = () =>
  videoElement({
    trackId: "v1",
    startTime: 1000,
    duration: 6000,
    trim: { startTime: 2000, endTime: 8000 },
    sourceDuration: 10_000,
  });

/** 10s of source played at 2x, so it occupies 5s of timeline. */
const fast = () =>
  videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 10_000,
    trim: { startTime: 0, endTime: 10_000 },
    sourceDuration: 10_000,
    speed: 2,
  });

/** Three lines, a second each, at 1s, 4s and 7s. */
const lines = (): CaptionLine[] =>
  linesFromWordGroups([
    [{ word: "one", start: 1, end: 2 }],
    [{ word: "two", start: 4, end: 5 }],
    [{ word: "three", start: 7, end: 8 }],
  ]);

/** A 100ms grid, the shape `onFrame` has at 10fps. */
const grid = (ms: number) => Math.round(ms / 100) * 100;

describe("sourceWindowOf", () => {
  it("reports the clip's trim window", () => {
    expect(sourceWindowOf(trimmed())).toEqual({ startMs: 2000, endMs: 8000 });
  });

  it("has nothing to report for a missing or non-dynamic clip", () => {
    expect(sourceWindowOf(undefined)).toBeNull();
  });
});

describe("planCuts", () => {
  it("plans nothing when nothing was struck out and no silence was found", () => {
    expect(planCuts([], plain())).toEqual(EMPTY_CUT_PLAN);
  });

  it("declines without a clip to cut", () => {
    expect(planCuts(removedSpans(removeLine(lines(), 0)), undefined)).toEqual(
      EMPTY_CUT_PLAN,
    );
  });

  it("turns a struck-out line into its own span", () => {
    const plan = planCuts(removedSpans(removeLine(lines(), 1)), plain());
    expect(plan.cuts).toEqual([{ startMs: 4000, endMs: 5000 }]);
    expect(plan.removedMs).toBe(1000);
    expect(plan.coversWholeClip).toBe(false);
  });

  it("carries silence ranges through as well", () => {
    const silences: TimeRange[] = [{ startMs: 2000, endMs: 3000 }];
    const plan = planCuts(silences, plain());
    expect(plan.cuts).toEqual([{ startMs: 2000, endMs: 3000 }]);
  });

  // The reason both gestures share one list: a silence sitting inside a line
  // the user also struck out must cost its footage once, not twice.
  it("merges a silence that overlaps a struck-out line", () => {
    const silences: TimeRange[] = [{ startMs: 4500, endMs: 5500 }];
    const plan = planCuts([...removedSpans(removeLine(lines(), 1)), ...silences], plain());
    expect(plan.cuts).toEqual([{ startMs: 4000, endMs: 5500 }]);
    expect(plan.removedMs).toBe(1500);
  });

  it("merges two cuts that touch into one", () => {
    const silences: TimeRange[] = [{ startMs: 5000, endMs: 6000 }];
    const plan = planCuts([...removedSpans(removeLine(lines(), 1)), ...silences], plain());
    expect(plan.cuts).toEqual([{ startMs: 4000, endMs: 6000 }]);
  });

  it("maps through a trim offset and the clip's own start", () => {
    // Source 4000..5000 is 2000..3000 into the trim, so timeline 3000..4000.
    const plan = planCuts(removedSpans(removeLine(lines(), 1)), trimmed());
    expect(plan.cuts).toEqual([{ startMs: 3000, endMs: 4000 }]);
  });

  // The panel plays the whole file; the clip may hold only part of it.
  it("drops a line the clip trimmed away", () => {
    const plan = planCuts(removedSpans(removeLine(lines(), 0)), trimmed());
    expect(plan.cuts).toEqual([]);
    expect(plan.removedMs).toBe(0);
  });

  it("clamps a line that only half reaches into the trim window", () => {
    const late = linesFromWordGroups([[{ word: "edge", start: 1.5, end: 2.5 }]]);
    const plan = planCuts(removedSpans(removeLine(late, 0)), trimmed());
    // Source 2000..2500 clamps to the window, landing at timeline 1000..1500.
    expect(plan.cuts).toEqual([{ startMs: 1000, endMs: 1500 }]);
  });

  it("divides by speed, so a 2x clip loses half the timeline it loses source", () => {
    const plan = planCuts(removedSpans(removeLine(lines(), 1)), fast());
    expect(plan.cuts).toEqual([{ startMs: 2000, endMs: 2500 }]);
    expect(plan.removedMs).toBe(500);
  });

  it("snaps both edges onto the grid", () => {
    const odd = linesFromWordGroups([[{ word: "odd", start: 1.234, end: 2.567 }]]);
    const plan = planCuts(removedSpans(removeLine(odd, 0)), plain(), grid);
    expect(plan.cuts).toEqual([{ startMs: 1200, endMs: 2600 }]);
  });

  // The whole reason snapping happens here: `removeRanges` skips a range whose
  // width clamps to zero, so a list that kept it would predict a cut that never
  // lands and place every later caption early.
  it("drops a range the grid collapsed onto one frame", () => {
    const tiny = linesFromWordGroups([[{ word: "x", start: 1.01, end: 1.02 }]]);
    const plan = planCuts(removedSpans(removeLine(tiny, 0)), plain(), grid);
    expect(plan.cuts).toEqual([]);
    expect(plan.removedMs).toBe(0);
  });

  it("reports cuts descending, the order removeRanges wants", () => {
    const plan = planCuts(removedSpans(removeLine(removeLine(lines(), 0), 2)), plain());
    expect(plan.cuts.map((cut) => cut.startMs)).toEqual([7000, 1000]);
  });

  it("adds several cuts up", () => {
    const plan = planCuts(removedSpans(removeLine(removeLine(lines(), 0), 2)), plain());
    expect(plan.removedMs).toBe(2000);
  });

  it("notices when the cuts would leave no footage", () => {
    const whole: TimeRange[] = [{ startMs: 0, endMs: 10_000 }];
    const plan = planCuts(whole, plain());
    expect(plan.coversWholeClip).toBe(true);
  });

  it("does not clamp a cut wider than the clip into an overstated total", () => {
    const over: TimeRange[] = [{ startMs: 0, endMs: 99_000 }];
    const plan = planCuts(over, plain());
    expect(plan.removedMs).toBe(10_000);
  });

  it("is not covering the whole clip when one frame survives", () => {
    const nearly: TimeRange[] = [{ startMs: 0, endMs: 9900 }];
    const plan = planCuts(nearly, plain(), grid);
    expect(plan.coversWholeClip).toBe(false);
  });
});
