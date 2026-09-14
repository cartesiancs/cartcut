import { createStore } from "zustand/vanilla";

/**
 * Whether the timeline is currently somebody else's.
 *
 * The auto-caption session is the first and so far the only holder. While it
 * runs, the document the user is looking at is a projection recomputed from a
 * baseline on every change, so an edit made anywhere else is not merely
 * inconvenient to merge: it is discarded, silently, by the next keystroke in
 * the caption panel. Refusing the edit is the honest answer.
 *
 * ## It is not a field on the track, and that is the decision
 *
 * `TimelineTrack` would take a `locked?: true` happily. `tracks.json` is a bare
 * `JSON.stringify` of the array, `HistoryEntry` snapshots the whole array so
 * undo would cover it for free, and an optional field never moves
 * `SCHEMA_VERSION`. Every part of that works.
 *
 * It is still wrong, because this lock is not a setting the editor turned on.
 * It is another name for "a session is live". Written into the document it
 * would survive a crash, and the user would open a project locked by a session
 * that no longer exists, with nothing anywhere offering to unlock it. A lock
 * with no holder must not be representable, and keeping it here is what makes
 * that true by construction: nothing saves it and a reload has none.
 *
 * A per-track lock the user sets by hand is a different feature and would go on
 * the track. It would read through this same predicate, with one more input.
 */
export type TimelineLockReason = "captionSession";

export interface ITimelineLockStore {
  /** Who holds it, or null. */
  reason: TimelineLockReason | null;
  lock: (reason: TimelineLockReason) => void;
  unlock: () => void;
}

export const timelineLockStore = createStore<ITimelineLockStore>((set, get) => ({
  reason: null,

  // Guarded before `set`, the rule `selectionStore` states: zustand merges an
  // empty partial into a fresh object and notifies, so writing the value
  // already held would repaint every subscriber for nothing. The caption
  // session locks on start and unlocks on every exit path, and those paths
  // overlap, so re-locking an already locked timeline is ordinary.
  lock: (reason) => {
    if (get().reason === reason) {
      return;
    }
    set({ reason });
  },

  unlock: () => {
    if (get().reason === null) {
      return;
    }
    set({ reason: null });
  },
}));

/**
 * Whether an edit should be refused right now.
 *
 * A function rather than a boolean export so call sites read the store at the
 * moment of the gesture. There are five of them and they are listed at
 * `features/timeline/timelineLock.test.ts`.
 */
export function isTimelineLocked(): boolean {
  return timelineLockStore.getState().reason !== null;
}

/**
 * What to tell the user, once.
 *
 * Never empty, and phrased as the way out rather than as the refusal: somebody
 * who has just had a drag ignored needs to know which window to go and close,
 * not that a flag is set.
 */
export function timelineLockMessage(): string {
  return "The timeline is locked while the caption panel is open. Press Apply, or close the caption window, to edit it again.";
}
