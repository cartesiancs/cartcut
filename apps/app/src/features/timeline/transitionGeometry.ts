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
 * The longest transition this cut can hold, in timeline ms.
 *
 * Bounded by the **clips' own lengths** and nothing else. A transition cannot
 * reach back past the outgoing clip's start or forward past the incoming
 * clip's end — there is no picture there at all — so those are hard limits:
 *
 *  - **center** — the window straddles the cut, taking `d/2` from each side,
 *    so `d/2` is bounded by both clips' lengths.
 *  - **end** — the window sits entirely before the cut, inside the outgoing
 *    clip. Only its length matters.
 *  - **start** — the mirror image.
 *
 * Handles are deliberately **not** a limit here, and that was the bug. A
 * freshly imported clip is trimmed to its whole source (`trim` is
 * `0..sourceDuration`), so it has exactly zero handle on either side — which
 * made this return 0 for the single most common edit there is: two imports
 * dropped end to end. The transition was then refused, and the advice to try
 * another alignment was impossible too, because all three need a handle.
 *
 * What happens instead is `freezeMs` below: where the source runs out the clip
 * holds its last or first frame. That is what the renderer already does —
 * `sourceTimeAt` extrapolates past `trim` and the media element clamps at its
 * own bounds — so the only thing that ever prevented it was this function.
 */
export function maxTransitionMs(
  from: TimelineElement,
  to: TimelineElement,
  alignment: TransitionAlignment,
): number {
  const lenFrom = spanLength(from);
  const lenTo = spanLength(to);

  switch (alignment) {
    case "end":
      return Math.max(0, lenFrom);
    case "start":
      return Math.max(0, lenTo);
    case "center":
    default:
      return Math.max(0, 2 * Math.min(lenFrom, lenTo));
  }
}

/**
 * How much of a transition here would be real footage rather than held frames.
 *
 * The old meaning of `maxTransitionMs`, kept because it is still worth knowing
 * — it is what the panel reports and what decides whether a badge is marked as
 * freezing. It just no longer decides whether a transition may exist.
 *
 * Each alignment draws on a different handle: a centred window needs tail from
 * the outgoing clip *and* head from the incoming one, an `end`-aligned window
 * needs only head, a `start`-aligned one only tail.
 */
export function realFootageMs(
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
 * How much of a transition of `durationMs` would be held frames, in timeline ms.
 *
 * Zero when the handles cover it. Reported rather than prevented: a held frame
 * across a short dissolve is barely perceptible and is what every editor does,
 * but the user should be able to see that it is happening and trim for real
 * footage if they care.
 */
export function freezeMs(
  from: TimelineElement,
  to: TimelineElement,
  alignment: TransitionAlignment,
  durationMs: number,
): number {
  const real = realFootageMs(from, to, alignment);
  if (!Number.isFinite(real)) {
    return 0;
  }
  return Math.max(0, durationMs - real);
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
 * The length a transition will actually get.
 *
 * Returns 0 only when the *clips* are too short to hold one — which is a real
 * impossibility, not a shortage of footage. Every other case clamps: asking for
 * two seconds across clips that are only one second long is a coherent request,
 * and shortening it beats an error.
 *
 * Note what this no longer does: it does not shorten a transition to fit the
 * available handles. Handles decide how much is real footage, not how long the
 * transition may be — see `maxTransitionMs`.
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
