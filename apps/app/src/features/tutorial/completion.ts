/**
 * Whether the user has done what a step asked.
 *
 * Decided from two snapshots of the editor, never from an event: the one taken
 * when the step began, and the one taken now. Events would each need a
 * listener on a different component, and several of the actions have none to
 * listen to (a sidebar tab is Bootstrap's `.active` and nothing else; a
 * duration change lands in a store object that was mutated in place, so a
 * subscriber's `prev` already holds the new value).
 */

import type { Completion } from "./steps";

/** The handful of editor facts the seven steps are judged on. */
export interface TutorialSnapshot {
  /** `renderOptionStore.options.duration`, seconds. */
  durationSec: number;
  /** A folder is open in the asset panel. */
  hasDirectory: boolean;
  /** Elements on the timeline, of any kind. */
  elementCount: number;
  /** Elements with `filetype: "text"`. */
  textCount: number;
  /** `draft`, `text`, `home`, ... from the active sidebar tab's target. */
  activeSidebarTab: string | null;
  /** Ruler presses that moved the playhead, counted by `releaseRuler`. */
  rulerMoves: number;
}

const finite = (value: number) => Number.isFinite(value);

/**
 * Two kinds of condition, and the difference is deliberate.
 *
 * - **Changes** (duration, a clip, a text, the playhead) must have happened
 *   since the step began. A project that already has clips must not complete
 *   "add a clip" on sight.
 * - **States** (a tab, an open folder) count whenever they hold, including
 *   when the step begins. A user who opened the File tab while reading the
 *   first card has done the second one, and asking again would be odd.
 */
export function isStepSatisfied(
  completion: Completion,
  baseline: TutorialSnapshot,
  now: TutorialSnapshot,
): boolean {
  switch (completion.kind) {
    case "durationChanged":
      return (
        finite(now.durationSec) &&
        finite(baseline.durationSec) &&
        now.durationSec !== baseline.durationSec
      );
    case "elementAdded":
      return grew(baseline.elementCount, now.elementCount);
    case "textAdded":
      return grew(baseline.textCount, now.textCount);
    case "playheadMoved":
      return grew(baseline.rulerMoves, now.rulerMoves);
    case "sidebarTab":
      return now.activeSidebarTab === completion.tab;
    case "folderOpen":
      return now.hasDirectory;
  }
}

const grew = (before: number, after: number) =>
  finite(before) && finite(after) && after > before;

/**
 * A press on the ruler, and how many of them have moved the playhead.
 *
 * The playhead also moves on its own during playback and under the arrow keys,
 * so "the cursor changed" is not the same as "the user dragged it". A move is
 * counted only when a press that began on the ruler is released with the
 * cursor somewhere else, and only on the release, so the step does not tick
 * over while the user is still dragging.
 */
export type RulerGesture = {
  /** The cursor, in ms, as the press began; null with no press under way. */
  pressedAt: number | null;
  moves: number;
};

export const IDLE_RULER: RulerGesture = { pressedAt: null, moves: 0 };

/**
 * Records where the playhead was before the ruler's own handler moves it.
 * The caller listens in the capture phase for exactly that ordering.
 */
export function pressRuler(
  gesture: RulerGesture,
  cursorMs: number,
): RulerGesture {
  if (!finite(cursorMs)) return gesture;
  return { pressedAt: cursorMs, moves: gesture.moves };
}

/** A release with no press under way changes nothing. */
export function releaseRuler(
  gesture: RulerGesture,
  cursorMs: number,
): RulerGesture {
  if (gesture.pressedAt === null) return gesture;

  const moved = finite(cursorMs) && cursorMs !== gesture.pressedAt;
  return {
    pressedAt: null,
    moves: moved ? gesture.moves + 1 : gesture.moves,
  };
}
