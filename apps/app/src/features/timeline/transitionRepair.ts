/**
 * Keeping transitions honest about the cut they describe.
 *
 * This is the mechanism that makes the rest of the feature cost nothing.
 *
 * A transition names two clips and sits on the boundary between them. Every
 * ordinary edit can invalidate that: deleting a clip, dragging one to another
 * row, trimming one so a gap opens, splitting one so a third clip lands in
 * between, pasting over the top. Teaching `splitClip`, `moveClips`,
 * `trimClipStart`, `trimClipEnd`, `deleteClips`, `rippleDelete`, `removeRanges`
 * and `pasteClips` each to notice would be eight opportunities to forget.
 *
 * Instead this runs from `normalizeDocument`, which every one of those ops
 * already funnels through. **`clipOps.ts` is not modified at all.** It is the
 * same shape as `repairHierarchy`, and for the same reason.
 *
 * Two jobs:
 *
 *  - **Drop** transitions whose cut no longer exists.
 *  - **Re-fit** the ones that survive: a trim moves the cut, so the window
 *    follows it, and a trim that frees up handles restores a length that an
 *    earlier edit had shrunk.
 *
 * That second half is why `requestedDuration` is stored. Without it, trimming a
 * clip in and then straight back out again would leave the transition
 * permanently shortened by an edit the user has since undone by hand.
 *
 * Cost on a project with no transitions: one pass over the element keys, then
 * the input back by identity. That is the same bargain `repairHierarchy`
 * strikes, and it is what makes running on every checkpoint affordable.
 */

import {
  occupiesTrack,
  type Timeline,
  type TimelineElement,
  type TransitionElementType,
} from "../../@types/timeline";
import {
  cutTimeOf,
  isAdjacent,
  resolveDuration,
  startTimeFor,
} from "./transitionGeometry";
// Type-only, deliberately: `tracks.ts` calls `repairTransitions` from
// `normalizeDocument`, so a value import in this direction would close a
// runtime cycle between the two modules.
import type { TimelineDocument } from "./tracks";

/**
 * Whether the two clips a transition names still form the cut it describes.
 *
 * Both must exist, be real occupants of the same track, and meet. "Meet" is
 * what a gap, an inserted clip, or a drag in either direction all break.
 */
function cutStillExists(
  elements: Timeline,
  transition: TransitionElementType,
): boolean {
  const from = elements[transition.fromId];
  const to = elements[transition.toId];

  if (from == null || to == null) {
    return false;
  }
  if (from === to) {
    return false;
  }
  if (!occupiesTrack(from) || !occupiesTrack(to)) {
    return false;
  }
  if (from.trackId !== to.trackId) {
    return false;
  }
  return isAdjacent(from, to);
}

/**
 * The transition as it should now be, or `null` if it should be dropped.
 *
 * Returns the *same object* when nothing needs changing, so the caller can tell
 * a no-op repair from a real one by identity and leave the document alone.
 */
function refit(
  elements: Timeline,
  transition: TransitionElementType,
): TransitionElementType | null {
  if (!cutStillExists(elements, transition)) {
    return null;
  }

  const from = elements[transition.fromId];
  const to = elements[transition.toId];

  // What the user last asked for, which may be longer than what they got.
  // Re-resolving against this rather than against the current duration is what
  // lets a transition grow back when a trim gives its handles room again.
  const requested = transition.requestedDuration ?? transition.duration;
  const duration = resolveDuration(
    from,
    to,
    requested,
    transition.alignment,
  );

  // The handles ran out entirely — a trim took the last of them. Dropping is
  // the honest outcome: a zero-length transition would render nothing and sit
  // on the timeline as an un-grabbable sliver.
  if (duration <= 0) {
    return null;
  }

  const startTime = startTimeFor(
    cutTimeOf(from),
    duration,
    transition.alignment,
  );
  // The pair may have been moved to another row together, in which case the
  // transition follows them rather than being dropped.
  const trackId = from.trackId;
  const requestedDuration = requested > duration ? requested : undefined;

  if (
    transition.duration === duration &&
    transition.startTime === startTime &&
    transition.trackId === trackId &&
    transition.requestedDuration === requestedDuration
  ) {
    return transition;
  }

  const next: TransitionElementType = {
    ...transition,
    duration,
    startTime,
    trackId,
    requestedDuration,
  };
  // `undefined` survives an object spread as a present key, and `.ngt` is
  // written with `JSON.stringify`, which drops it — so leaving it in makes a
  // saved and reloaded project differ from the one in memory.
  if (requestedDuration === undefined) {
    delete next.requestedDuration;
  }
  return next;
}

/**
 * Drop transitions whose cut is gone, and re-fit the ones that remain.
 *
 * Also enforces one transition per cut: if two ever name the same pair — a
 * paste that duplicated one, a hand-edited `.ngt` — the lowest id wins and the
 * rest are dropped, so the render pass never has to decide between them.
 *
 * Returns its input by identity when nothing needed repairing, so
 * `withCheckpoint` still reads a declined op as declined.
 */
export function repairTransitions(doc: TimelineDocument): TimelineDocument {
  const elements = doc.elements;

  // The fast path, and the reason this is affordable on every edit: a project
  // with no transitions is recognised in one pass over the keys.
  let anyTransition = false;
  for (const id of Object.keys(elements)) {
    if (elements[id]?.filetype === "transition") {
      anyTransition = true;
      break;
    }
  }
  if (!anyTransition) {
    return doc;
  }

  const next: Timeline = {};
  let changed = false;

  // Decide first, walking in id order so that the winner of a contested cut is
  // the lowest id rather than whichever happened to be inserted first.
  const claimed = new Set<string>();
  const verdicts = new Map<string, TransitionElementType | null>();

  for (const id of Object.keys(elements).sort((a, b) => a.localeCompare(b))) {
    const element: TimelineElement = elements[id];
    if (element.filetype !== "transition") {
      continue;
    }

    const cutKey = [element.trackId, element.fromId, element.toId].join("|");
    if (claimed.has(cutKey)) {
      verdicts.set(id, null);
      continue;
    }

    const repaired = refit(elements, element);
    verdicts.set(id, repaired);
    if (repaired != null) {
      claimed.add(cutKey);
    }
  }

  // Build in the document's own key order. `derivePriorities` reorders the map
  // afterwards anyway, but it does so deliberately and by paint rank; a repair
  // pass reshuffling the keys on its way through would be an unrelated change
  // to something `renderMain` reads with `for..in`.
  for (const [id, element] of Object.entries(elements)) {
    if (!verdicts.has(id)) {
      next[id] = element;
      continue;
    }

    const repaired = verdicts.get(id) ?? null;
    if (repaired == null) {
      changed = true;
      continue;
    }

    next[id] = repaired;
    if (repaired !== element) {
      changed = true;
    }
  }

  return changed ? { ...doc, elements: next } : doc;
}
