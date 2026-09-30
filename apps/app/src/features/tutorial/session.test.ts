import { describe, expect, it } from "vitest";
import { IDLE, reduceTutorial, type TutorialState } from "./session";
import { DONE_FLASH_MS } from "./motion";
import { TUTORIAL_STEPS } from "./steps";

const LAST = TUTORIAL_STEPS.length - 1;

const showing = (step: number): TutorialState => ({
  kind: "running",
  step,
  phase: "showing",
});

const done = (step: number, doneAt: number): TutorialState => ({
  kind: "running",
  step,
  phase: "done",
  doneAt,
});

describe("tutorial session", () => {
  it("starts at the first step", () => {
    expect(reduceTutorial(IDLE, { type: "start" })).toEqual(showing(0));
  });

  it("does not start over a tutorial that is running", () => {
    const state = showing(3);
    expect(reduceTutorial(state, { type: "start" })).toBe(state);
  });

  it("restarts from the first step whatever it was doing", () => {
    for (const state of [
      IDLE,
      showing(4),
      done(2, 100),
      { kind: "finished", outcome: "skipped" } as TutorialState,
    ]) {
      expect(reduceTutorial(state, { type: "restart" })).toEqual(showing(0));
    }
  });

  describe("Next", () => {
    it("moves one step on", () => {
      expect(reduceTutorial(showing(2), { type: "next" })).toEqual(showing(3));
    });

    it("finishes from the last step", () => {
      expect(reduceTutorial(showing(LAST), { type: "next" })).toEqual({
        kind: "finished",
        outcome: "completed",
      });
    });

    // Pressing Next during the check mark skips the rest of the flash; it does
    // not also let the flash's own tick advance a second time.
    it("cuts the flash short, once", () => {
      const next = reduceTutorial(done(1, 0), { type: "next" });
      expect(next).toEqual(showing(2));
      expect(reduceTutorial(next, { type: "tick", now: DONE_FLASH_MS * 10 })).toBe(
        next,
      );
    });

    it("does nothing when nothing is running", () => {
      expect(reduceTutorial(IDLE, { type: "next" })).toBe(IDLE);
    });
  });

  describe("Skip", () => {
    it("finishes, marked as skipped", () => {
      expect(reduceTutorial(showing(1), { type: "skip" })).toEqual({
        kind: "finished",
        outcome: "skipped",
      });
      expect(reduceTutorial(done(1, 0), { type: "skip" })).toEqual({
        kind: "finished",
        outcome: "skipped",
      });
    });

    it("does nothing when nothing is running", () => {
      const finished: TutorialState = { kind: "finished", outcome: "completed" };
      expect(reduceTutorial(finished, { type: "skip" })).toBe(finished);
    });
  });

  describe("a step being done", () => {
    it("shows the check, then moves on once the flash is over", () => {
      const checked = reduceTutorial(showing(0), {
        type: "satisfied",
        step: 0,
        now: 1000,
      });
      expect(checked).toEqual(done(0, 1000));

      const early = reduceTutorial(checked, {
        type: "tick",
        now: 1000 + DONE_FLASH_MS - 1,
      });
      expect(early).toBe(checked);

      expect(
        reduceTutorial(checked, { type: "tick", now: 1000 + DONE_FLASH_MS }),
      ).toEqual(showing(1));
    });

    it("finishes the tutorial when the last step is done", () => {
      const checked = reduceTutorial(showing(LAST), {
        type: "satisfied",
        step: LAST,
        now: 0,
      });
      expect(
        reduceTutorial(checked, { type: "tick", now: DONE_FLASH_MS }),
      ).toEqual({ kind: "finished", outcome: "completed" });
    });

    // Every one of these is a no-op, and a no-op is the same object: the
    // runner reads identity as "nothing happened" and touches nothing.
    it("ignores what does not apply, by identity", () => {
      const s = showing(2);
      const d = done(2, 50);

      expect(reduceTutorial(s, { type: "satisfied", step: 1, now: 0 })).toBe(s);
      expect(reduceTutorial(d, { type: "satisfied", step: 2, now: 80 })).toBe(d);
      expect(reduceTutorial(s, { type: "satisfied", step: 2, now: NaN })).toBe(s);
      expect(reduceTutorial(IDLE, { type: "satisfied", step: 0, now: 0 })).toBe(
        IDLE,
      );
      expect(reduceTutorial(s, { type: "tick", now: 1e9 })).toBe(s);
      expect(reduceTutorial(d, { type: "tick", now: NaN })).toBe(d);
      expect(reduceTutorial(IDLE, { type: "tick", now: 1e9 })).toBe(IDLE);
    });
  });
});
