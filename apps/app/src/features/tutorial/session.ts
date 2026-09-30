/**
 * The tutorial's state machine, as one pure reducer.
 *
 * Time only enters through actions (`satisfied` and `tick` carry `now`), never
 * through a timer of its own. So a "done" flash from a step the user has
 * already left by pressing Next cannot fire into the step after it: the tick
 * that would have ended it finds a state it does not apply to.
 *
 * An action that does not apply returns its input, by identity, the same
 * convention the timeline's pure ops follow. The runner reads that as
 * "nothing happened" and touches nothing.
 */

import { TUTORIAL_STEPS } from "./steps";
import { DONE_FLASH_MS } from "./motion";

export type TutorialState =
  | { kind: "idle" }
  | { kind: "running"; step: number; phase: "showing" }
  | { kind: "running"; step: number; phase: "done"; doneAt: number }
  | { kind: "finished"; outcome: "completed" | "skipped" };

export type TutorialAction =
  | { type: "start" }
  | { type: "restart" }
  | { type: "next" }
  | { type: "skip" }
  | { type: "satisfied"; step: number; now: number }
  | { type: "tick"; now: number };

export const IDLE: TutorialState = { kind: "idle" };

const showing = (step: number): TutorialState => ({
  kind: "running",
  step,
  phase: "showing",
});

export function reduceTutorial(
  state: TutorialState,
  action: TutorialAction,
  stepCount: number = TUTORIAL_STEPS.length,
  doneMs: number = DONE_FLASH_MS,
): TutorialState {
  switch (action.type) {
    case "start":
      // Starting a tutorial that is already running would throw away the
      // user's progress for nothing.
      return state.kind === "running" ? state : showing(0);

    case "restart":
      return showing(0);

    case "next":
      return state.kind === "running" ? advance(state.step, stepCount) : state;

    case "skip":
      return state.kind === "running"
        ? { kind: "finished", outcome: "skipped" }
        : state;

    case "satisfied":
      if (
        state.kind !== "running" ||
        state.phase !== "showing" ||
        state.step !== action.step ||
        !Number.isFinite(action.now)
      ) {
        return state;
      }
      return {
        kind: "running",
        step: state.step,
        phase: "done",
        doneAt: action.now,
      };

    case "tick":
      if (
        state.kind !== "running" ||
        state.phase !== "done" ||
        !Number.isFinite(action.now) ||
        action.now - state.doneAt < doneMs
      ) {
        return state;
      }
      return advance(state.step, stepCount);
  }
}

/** Off the last step is the end of the tutorial, not a step past it. */
function advance(step: number, stepCount: number): TutorialState {
  return step + 1 >= stepCount
    ? { kind: "finished", outcome: "completed" }
    : showing(step + 1);
}
