/**
 * Whether the project has diverged from what is on disk.
 *
 * One owner for one question. Three surfaces ask it — File → Open, the quit
 * guard, and Auto Save — and they must not be able to disagree: a quit guard
 * that waves through a state Auto Save thinks is dirty is a lost session with
 * a dialog that said nothing.
 *
 * It replaces `features/element/elementTimeline.ts`'s
 * `timelineHashTable`/`isTimelineChange`, whose defects are catalogued in
 * `projectDigest.ts`. The one that mattered most: it hashed elements only, so
 * a track rename or reorder read as unmodified and Open would
 * `clearTimeline()` straight over it.
 *
 * ## Not a store
 *
 * Nothing repaints on this. A zustand store would invite a subscriber, and a
 * subscriber on `useTimelineStore` fires at the display rate during playback
 * (there is no `subscribeWithSelector` here). It is session state with one
 * owner, read on demand.
 *
 * ## The baseline is set from the store, never from the file
 *
 * `patchDocument` runs `normalizeAnimations`, then optionally
 * `rebakeAnimations`, then `normalizeDocument` — so the document in the store
 * after a load is **not** byte-identical to the `timeline.json` it came from.
 * Baselining from the file therefore reads as dirty immediately, and the first
 * autosave writes a file identical in meaning to the `.ngt` for no reason.
 * Every `markProjectSaved` below takes its digest from the store.
 */

import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { projectStateDigest } from "./projectDigest";

/**
 * The digest of the project as it stands.
 *
 * `getDocument()` builds a fresh wrapper each call but `tracks` and `elements`
 * are reference-stable, so this reads the store's own arrays rather than a
 * copy.
 */
export function currentProjectDigest(): string {
  const state = useTimelineStore.getState();
  return projectStateDigest(
    state.timeline,
    state.tracks,
    renderOptionStore.getState().options,
  );
}

/**
 * `null` until something establishes a baseline.
 *
 * A fresh launch has an empty project that matches an empty baseline, so
 * `baseline` is seeded at module load rather than left null — otherwise the
 * quit guard would warn about an untouched project.
 */
let baseline: string | null = null;

/**
 * Record that the project as it stands is what is on disk.
 *
 * Called on a **confirmed** write and nowhere else. `digest` exists for the
 * one caller that needs to pass a stale value: Auto Save computes the digest
 * before a write and hands that back on success, because an edit can land
 * while the bytes are in flight and must leave the project dirty afterwards
 * rather than be swallowed by a baseline taken after the fact.
 */
export function markProjectSaved(digest?: string): void {
  baseline = digest ?? currentProjectDigest();
}

/** Whether the project differs from the last thing known to be on disk. */
export function isProjectDirty(): boolean {
  if (baseline == null) {
    baseline = currentProjectDigest();
    return false;
  }
  return currentProjectDigest() !== baseline;
}

/** The current baseline, or `null`. For assertions and for Auto Save's gate. */
export function projectBaseline(): string | null {
  return baseline;
}

/**
 * Whether the timeline holds anything at all.
 *
 * A separate question from dirtiness, and Auto Save recovery needs both:
 * recovery replaces everything, so it refuses on a non-empty timeline even if
 * that timeline is saved — while File → Open refuses only on *dirty*, because
 * a clean project is on disk and opening another loses nothing. Refusing Open
 * on non-empty would mean never being able to open a second project.
 *
 * `tracks.length` counts on its own: three added rows and nothing else is work
 * worth refusing over, and it is exactly what the old element-only hash read
 * as unmodified.
 */
export function isProjectEmpty(): boolean {
  const state = useTimelineStore.getState();
  return Object.keys(state.timeline).length === 0 && state.tracks.length === 0;
}

/** Drop the baseline. For tests, and for a new project. */
export function resetProjectBaseline(): void {
  baseline = null;
}
