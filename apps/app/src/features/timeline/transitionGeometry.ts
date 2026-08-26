/**
 * The arithmetic of a cut: handles, windows, and how long a transition can be.
 *
 * Split from `transitionOps.ts` for one reason, and it is a hard one:
 * `repairTransitions` runs inside `normalizeDocument`, so anything it imports
 * must not import `tracks.ts` back. This module depends on `geometry.ts` and
 * the element types and nothing else, which is what lets both the repair pass
 * and the editing ops share one copy of the maths.
 *
 * ## Handles
 *
 * A transition needs frames from outside the cut: the outgoing clip has to keep
 * playing past its out-point, and the incoming one has to start before its
 * in-point. Those frames exist in the source file but sit outside `trim` — what
 * an NLE calls *handles*.
 *
 * They are finite. A clip trimmed to the last frame of its source has no tail
 * at all, and a two-second centred dissolve there is asking for frames that do
 * not exist. Everything below is in service of answering "how much is actually
 * there?" before anything is written, so the ops can shrink the transition
 * rather than produce one that renders a frozen frame.
 *
 * A static element — an image, a title, a shape — has infinite handles, because
 * there is no source window to run out of. That is why transitions between
 * stills always work and every interesting case is video.
 */

import type {
  TimelineElement,
  TransitionAlignment,
  TransitionElementType,
} from "../../@types/timeline";
import {
  ADJACENCY_EPSILON_MS,
  isDynamicElement,
  sourceDurationOf,
  spanEnd,
  spanLength,
  spanStart,
  speedOf,
} from "./geometry";
import { frameToMs, msToFrameFloor } from "./frames";

/**
 * The shortest transition worth having, in timeline ms.
 *
 * Roughly two frames at 50fps. Below this there is nothing to see — the mix
 * passes through before the eye catches it — and the timeline badge is too
 * narrow to grab. A cut whose handles cannot supply this much declines, rather
 * than producing a transition the user can neither perceive nor click.
 */
export const MIN_TRANSITION_MS = 40;

/** What a transition gets when the user just clicks a cut. */
export const DEFAULT_TRANSITION_MS = 500;

/**
 * Timeline ms the outgoing clip can still supply *after* its out-point.
 *
 * Source ms divided by `speed`, because `trim` addresses the file while the
 * transition occupies the timeline — the conversion `geometry.ts` exists to
 * keep straight. A 2x clip with 1000ms of unused tail can only cover 500ms of
 * transition.
 */
export function tailHandleOf(element: TimelineElement): number {
  if (!isDynamicElement(element)) {
    return Infinity;
  }
  const remaining = sourceDurationOf(element) - element.trim.endTime;
  return Math.max(0, remaining) / speedOf(element);
}

/** Timeline ms the incoming clip can still supply *before* its in-point. */
export function headHandleOf(element: TimelineElement): number {
  if (!isDynamicElement(element)) {
    return Infinity;
  }
  return Math.max(0, element.trim.startTime) / speedOf(element);
}

/**
 * The longest transition this cut can actually render, in timeline ms.
 *
 * Each alignment consumes a different mix of handle and body, and getting that
 * wrong is exactly how a transition ends up showing a frozen frame:
 *
 *  - **center** — the window straddles the cut, so each clip supplies half from
 *    its handle and half from its own body. All four quantities bound `d/2`.
 *  - **end** — the window sits entirely before the cut. The outgoing clip plays
 *    its own body there and spends `d` of it; the incoming clip is pre-rolled
 *    and needs `d` of head. The incoming clip's *length* is irrelevant, because
 *    the window never reaches it.
 *  - **start** — the mirror image. The outgoing clip needs `d` of tail, the
 *    incoming clip spends `d` of body, and the outgoing clip's length does not
 *    matter.
 *
 * Returns 0 when the cut can support nothing, and `Infinity` when both sides
 * are static — callers clamp against a requested length, so infinity is a
 * meaningful answer rather than one to guard against here.
 */
export function maxTransitionMs(
  from: TimelineElement,
  to: TimelineElement,
  alignment: TransitionAlignment,
): number {
  const tail = tailHandleOf(from);
  const head = headHandleOf(to);
  const lenFrom = spanLength(from);
  const lenTo = spanLength(to);

  switch (alignment) {
    case "end":
      return Math.max(0, Math.min(head, lenFrom));
    case "start":
      return Math.max(0, Math.min(tail, lenTo));
    case "center":
    default:
      return Math.max(0, 2 * Math.min(tail, head, lenFrom, lenTo));
  }
}

/**
 * Where the cut between two adjacent clips falls.
 *
 * Taken from the outgoing clip's end rather than the incoming clip's start so
 * that one number defines it even when the two disagree by a rounding error.
 */
export function cutTimeOf(from: TimelineElement): number {
  return spanEnd(from);
}

/** Whether `to` begins where `from` ends, within float slack. */
export function isAdjacent(from: TimelineElement, to: TimelineElement): boolean {
  return Math.abs(spanEnd(from) - spanStart(to)) <= ADJACENCY_EPSILON_MS;
}

/**
 * Where a transition of `durationMs` starts, for each alignment.
 *
 * Never negative in practice: `maxTransitionMs` already bounds the window by
 * each clip's own length, so a centred transition cannot reach back past the
 * outgoing clip's start, which is itself at or after zero.
 */
export function startTimeFor(
  cutMs: number,
  durationMs: number,
  alignment: TransitionAlignment,
): number {
  switch (alignment) {
    case "end":
      return cutMs - durationMs;
    case "start":
      return cutMs;
    case "center":
    default:
      return cutMs - durationMs / 2;
  }
}

/** The stretch of timeline a transition covers. */
export function windowOf(transition: TransitionElementType): {
  start: number;
  end: number;
} {
  return {
    start: transition.startTime,
    end: transition.startTime + transition.duration,
  };
}

/**
 * How far through a transition the playhead is, 0..1.
 *
 * **`timeInMs` is snapped to the frame grid before anything else happens, and
 * that is not a rounding nicety — it is what makes preview and export agree.**
 *
 * The two paths sample the timeline differently. Export walks frame indices:
 * `frameTimeMs(n, fps)` is exactly `(n / fps) * 1000`. The preview's playback
 * loop sets the cursor from the wall clock — `Date.now() - startTime` in
 * `elementControl.step` — which lands on arbitrary integer milliseconds.
 *
 * For everything that existed before transitions that difference was harmless:
 * sampling a keyframe 8ms off shows a marginally different frame and nobody can
 * tell. Feeding it to a shader is not harmless. `progress` becomes a slightly
 * different number in the preview than in the render, so the exported file does
 * not match what the user approved — and the discrepancy is invisible until
 * they compare the two side by side.
 *
 * Snapping here fixes it at the one place the value is derived, without
 * touching the playback cursor itself — which drives scrubbing, keyframes and
 * filmstrips, and is not this feature's to change. `frames.ts#frameToMs`
 * deliberately uses the exporter's own expression, bit for bit, so the two
 * agree exactly rather than approximately.
 *
 * **Floor, not nearest.** `snapMsToFrame` rounds, which is right for its own
 * job — a dragged clip should land on the closest frame line. It is wrong here.
 * Frame `n` is displayed throughout `[n/fps, (n+1)/fps)`, and export renders it
 * at the start of that span; a cursor two thirds of the way through frame 70
 * would round *up* to 71 and show the next frame's progress while the playhead
 * is still inside 70. Flooring makes "which frame is on screen" and "which
 * frame is being rendered" the same question.
 */
export function progressOf(
  transition: TransitionElementType,
  timeInMs: number,
  fps: number,
): number {
  if (!(transition.duration > 0)) {
    return 1;
  }
  const snapped = frameToMs(msToFrameFloor(timeInMs, fps), fps);
  const raw = (snapped - transition.startTime) / transition.duration;
  return Math.max(0, Math.min(1, raw));
}

/**
 * The length a transition will actually get, given what the clips can supply.
 *
 * Returns 0 when the cut cannot support a usable transition at all, which is
 * every caller's signal to decline. Everything else clamps rather than refuses:
 * asking for two seconds where only eight hundred milliseconds exist is a
 * coherent request, and shortening it is a better answer than an error.
 */
export function resolveDuration(
  from: TimelineElement,
  to: TimelineElement,
  requestedMs: number,
  alignment: TransitionAlignment,
): number {
  const max = maxTransitionMs(from, to, alignment);
  if (max < MIN_TRANSITION_MS) {
    return 0;
  }
  return Math.min(Math.max(MIN_TRANSITION_MS, requestedMs), max);
}
