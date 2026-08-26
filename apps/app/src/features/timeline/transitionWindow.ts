/**
 * Which clips a transition keeps on screen past their own edges.
 *
 * Inside a transition's window the outgoing clip must keep playing after its
 * out-point and the incoming clip must start before its in-point — the handles
 * `transitionGeometry.ts` measures. Everywhere else in the app a clip's
 * visibility is exactly its span, so this is the one place that widens it.
 *
 * It is deliberately answered in a single function, because three subsystems
 * ask the same question and have to agree:
 *
 *  - the compositor, deciding what to paint;
 *  - `loadedAssetStore.seek`, deciding which `<video>` to position for export;
 *  - `playback.ts`, deciding which handle should be rolling during preview.
 *
 * If those three disagreed, the transition would blend a frame that had not
 * been seeked — the class of bug `geometry.ts` was written to end.
 *
 * ## Keyed by element identity, not by id
 *
 * `isElementVisibleAtTime(t, timeline, element)` receives the element but not
 * its id, and changing that signature would churn a dozen call sites. Elements
 * are plain objects held in the document, so object identity is a perfectly
 * good key — and every edit produces a new element object, which means a stale
 * entry cannot survive an edit.
 *
 * The index is memoised on the `Timeline` object with a `WeakMap`, exactly as
 * `renderer/timeline.ts#prioritySorted` memoises its sort. Without it this
 * would be an O(n) scan per element per frame; with it, one pass per document.
 */

import type {
  Timeline,
  TimelineElement,
  TransitionElementType,
} from "../../@types/timeline";
import { isTimeInRange } from "../../utils/time";
import { windowOf } from "./transitionGeometry";

/** Transitions that extend a given element, keyed by the element object. */
type TransitionIndex = Map<TimelineElement, TransitionElementType[]>;

const indexCache = new WeakMap<Timeline, TransitionIndex>();

/**
 * Every element a transition extends, mapped to the transitions doing it.
 *
 * Empty for the overwhelming majority of documents, and cheap to build: one
 * pass over the keys, touching only the transition elements.
 */
export function transitionIndex(elements: Timeline): TransitionIndex {
  const cached = indexCache.get(elements);
  if (cached != null) {
    return cached;
  }

  const index: TransitionIndex = new Map();

  for (const element of Object.values(elements)) {
    if (element.filetype !== "transition") {
      continue;
    }
    for (const id of [element.fromId, element.toId]) {
      const target = elements[id];
      if (target == null) {
        continue;
      }
      const list = index.get(target);
      if (list == null) {
        index.set(target, [element]);
      } else {
        list.push(element);
      }
    }
  }

  indexCache.set(elements, index);
  return index;
}

/**
 * Whether a transition is holding this element on screen at `timeInMs`.
 *
 * Only true outside the element's own span — inside it, ordinary visibility
 * already applies and the caller has answered before reaching here.
 */
export function isVisibleThroughTransition(
  timeInMs: number,
  elements: Timeline,
  element: TimelineElement,
): boolean {
  const index = transitionIndex(elements);
  if (index.size === 0) {
    return false;
  }

  const transitions = index.get(element);
  if (transitions == null) {
    return false;
  }

  for (const transition of transitions) {
    const { start, end } = windowOf(transition);
    if (isTimeInRange(timeInMs, start, end)) {
      return true;
    }
  }
  return false;
}

/**
 * The transitions active at `timeInMs`, with both clips present.
 *
 * A transition whose clips have gone is skipped rather than half-drawn.
 * `repairTransitions` should have removed it already; this is the render path
 * declining to trust that, because a document reaches the compositor from IPC
 * and from `.ngt` as well as from an edit.
 */
export function activeTransitionsAt(
  elements: Timeline,
  timeInMs: number,
): Array<[string, TransitionElementType]> {
  const active: Array<[string, TransitionElementType]> = [];

  for (const [id, element] of Object.entries(elements)) {
    if (element.filetype !== "transition") {
      continue;
    }
    if (elements[element.fromId] == null || elements[element.toId] == null) {
      continue;
    }
    const { start, end } = windowOf(element);
    if (isTimeInRange(timeInMs, start, end)) {
      active.push([id, element]);
    }
  }

  return active;
}
