/**
 * Which clips the auto-caption picker has chosen, and in what order.
 *
 * The order is the user's, not the timeline's: it is the order the clips are
 * transcribed in and the order their sections appear in the caption list. So
 * the selection is an ordered list of element keys rather than a set, and every
 * gesture on it (a click on a tile, a drag in the tray, a keystroke on a chip)
 * is one of the functions below.
 *
 * Here rather than in the picker for the reason `menus.ts` gives: the panel's
 * folder is outside every vitest include pattern. And every function **returns
 * its input by identity when it changes nothing**, the convention
 * `features/timeline/` states, so the picker can skip a repaint and an event on
 * a gesture that did nothing.
 */

import type { CaptionSource } from "./sources";

/** Element keys, in the order the user chose. */
export type ClipPick = readonly string[];

/** Add a clip at the end, or take it out and close the gap. */
export function togglePick(pick: ClipPick, key: string): ClipPick {
  return pick.includes(key) ? removePick(pick, key) : [...pick, key];
}

export function removePick(pick: ClipPick, key: string): ClipPick {
  return pick.includes(key) ? pick.filter((k) => k !== key) : pick;
}

/**
 * Move the clip at `from` to `to`.
 *
 * `to` is clamped to the list, so a drag past either end lands at that end
 * rather than being refused. The splice is `timeline/tracks.ts#moveTrack`'s.
 */
export function movePick(pick: ClipPick, from: number, to: number): ClipPick {
  if (!Number.isInteger(from) || from < 0 || from >= pick.length) {
    return pick;
  }
  const target = Math.min(pick.length - 1, Math.max(0, Math.round(to)));
  if (target === from) {
    return pick;
  }
  const next = [...pick];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** One step left or right, for the keyboard. Identity at either end. */
export function nudgePick(pick: ClipPick, key: string, delta: number): ClipPick {
  const from = pick.indexOf(key);
  if (from < 0) {
    return pick;
  }
  return movePick(pick, from, from + Math.sign(delta));
}

/** The badge on a tile: 1-based, or null for a clip that is not chosen. */
export function pickNumber(pick: ClipPick, key: string): number | null {
  const index = pick.indexOf(key);
  return index < 0 ? null : index + 1;
}

export function allPicked(pick: ClipPick, rows: readonly CaptionSource[]): boolean {
  return rows.length > 0 && rows.every((row) => pick.includes(row.key));
}

/**
 * The All button, which is a toggle.
 *
 * With every clip chosen it clears; otherwise it keeps what was chosen, in the
 * order it was chosen, and appends the rest in timeline order. The same rule
 * `selectionStore.mergeIds` keeps for a shift-drag.
 */
export function pickAll(pick: ClipPick, rows: readonly CaptionSource[]): ClipPick {
  if (rows.length === 0) {
    return pick;
  }
  if (allPicked(pick, rows)) {
    return [];
  }
  const chosen = new Set(pick);
  return [...pick, ...rows.map((row) => row.key).filter((key) => !chosen.has(key))];
}

/**
 * Drop whatever is no longer on the timeline.
 *
 * The timeline stays editable while the picker is closed, so a remembered
 * choice can name a clip the user has since deleted. Identity when nothing
 * went.
 */
export function reconcilePick(pick: ClipPick, rows: readonly CaptionSource[]): ClipPick {
  const present = new Set(rows.map((row) => row.key));
  return pick.every((key) => present.has(key))
    ? pick
    : pick.filter((key) => present.has(key));
}

/**
 * What the picker opens with.
 *
 * The last choice first, because reopening after a failure or a cancel should
 * not make anyone choose again. Then whatever is selected on the timeline, in
 * timeline order, because selecting clips and then asking for captions is the
 * gesture people try first. Then the only clip there is, since there is nothing
 * to choose between.
 */
export function initialPick(input: {
  previous: ClipPick;
  timelineSelection: readonly string[];
  rows: readonly CaptionSource[];
}): ClipPick {
  const previous = reconcilePick(input.previous, input.rows);
  if (previous.length > 0) {
    return previous;
  }

  const selected = new Set(input.timelineSelection);
  const fromTimeline = input.rows
    .filter((row) => selected.has(row.key))
    .map((row) => row.key);
  if (fromTimeline.length > 0) {
    return fromTimeline;
  }

  if (input.rows.length === 1) {
    return [input.rows[0].key];
  }
  return [];
}

/** The chosen rows, in the chosen order. Keys with no row are skipped. */
export function pickedSources(
  pick: ClipPick,
  rows: readonly CaptionSource[],
): CaptionSource[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return pick
    .map((key) => byKey.get(key))
    .filter((row): row is CaptionSource => row != null);
}
