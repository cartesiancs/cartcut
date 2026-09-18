/**
 * Element-level editing primitives: trim and split, as pure functions.
 *
 * Every one of these returns a fresh element (nested `trim` included) and
 * preserves the source-window invariant from `geometry.ts`:
 *
 *   duration === trim.endTime - trim.startTime
 *
 * That coupling is the whole point. The old trim handles in
 * `elementTimelineCanvas` wrote `trim` and nothing else, so `duration` stayed
 * at the full source length and the export happily emitted the untrimmed clip.
 * Splitting had the same shape of bug: it adjusted `trim` without moving
 * `startTime`, so both halves drew a full-width bar at the same x and could
 * only be told apart by which shoulder was shaded — which is exactly why a cut
 * needed a second row to be visible at all.
 *
 * `clipOps` (document level) builds on these; keeping them separate means the
 * arithmetic can be tested without a track model around it.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  MIN_SOURCE_MS,
  MIN_TIMELINE_MS,
  isDurationLocked,
  isDynamicElement,
  sourceDurationOf,
  sourceTimeAt,
  spanLength,
  speedOf,
  type DynamicElement,
} from "./geometry";
import { rebaseAnimation, sliceAnimation } from "../animation/keyframes";
import {
  coerceSpeedCurve,
  curveSourceAt,
  curveSpanLength,
  derivedSpeedOf,
  sameSpeedCurve,
  speedCurveOf,
  type SpeedPoint,
} from "./speedCurve";

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Recompute the derived `speed` from the clip's ramp, if it has one.
 *
 * `speed` is authored on a clip with no `speedCurve` and derived on one that
 * has it, so every write to `trim` moves the window the ramp is integrated over
 * and the scalar has to follow. This is the one place that happens, and
 * `geometry.ts#assertSpeedInvariant` is what catches an op that forgets.
 *
 * Total on purpose: a degenerate window leaves the existing rate alone rather
 * than writing a `NaN` that `spanLength` would spread through every span in the
 * document. `MIN_SOURCE_MS` makes that unreachable through the ops here, and an
 * element arriving from a hand-edited file is the case it exists for.
 */
export function withDerivedSpeed<T extends DynamicElement>(element: T): T {
  const curve = speedCurveOf(element);
  if (curve == null) {
    return element;
  }
  const speed = derivedSpeedOf(
    curve,
    element.trim.startTime,
    element.trim.endTime,
    element.duration,
  );
  if (speed == null || speed === element.speed) {
    return element;
  }
  return { ...element, speed };
}

/**
 * Put a ramp on a clip, or take it off, and settle the scalar in one step.
 *
 * `null` deletes the key rather than storing an empty list, which is what makes
 * a clip whose ramp was added and then removed save byte-identically to one
 * that never had one. Taking the ramp off leaves `speed` at the mean the ramp
 * was running, so the clip does not jump on the timeline: flattening a ramp
 * changes how the footage plays inside the clip and not where the clip sits.
 */
export function withSpeedCurve<T extends DynamicElement>(
  element: T,
  points: readonly SpeedPoint[] | null,
): T {
  const next = points == null ? null : coerceSpeedCurve(points);
  if (next == null) {
    if (element.speedCurve == null) {
      return element;
    }
    const { speedCurve: _dropped, ...rest } = element;
    return rest as T;
  }
  // Declines by identity when the ramp is already exactly this, which is the
  // convention every pure op here follows and which `withCheckpoint` reads as
  // "nothing happened". Reachable: re-picking a preset the clip is already on,
  // and every step of a drag that has not moved. Without it each of those is an
  // empty undo step, and fifty of them evict the whole history.
  //
  // The derived rate has to agree too. A file can arrive carrying the right
  // curve and a stale scalar, and that is exactly what the ingress repair is
  // there to fix, so it must not be declined here.
  const settled = withDerivedSpeed({ ...element, speedCurve: next });
  if (
    sameSpeedCurve(element.speedCurve, next) &&
    settled.speed === element.speed
  ) {
    return element;
  }
  return settled;
}

function withTrim<T extends DynamicElement>(
  element: T,
  startTime: number,
  duration: number,
  trimStart: number,
  trimEnd: number,
): T {
  // Every trim and both halves of every split come through here, which is why
  // the derived rate is settled here and not at each of the four call sites.
  return withDerivedSpeed({
    ...element,
    startTime,
    duration,
    trim: { startTime: trimStart, endTime: trimEnd },
  });
}

/**
 * Drag the clip's left edge by `deltaMs` of **timeline** time.
 *
 * Positive shortens from the left. The move is clamped by three things at
 * once: the start of the source file, the start of the timeline, and the
 * minimum window — so the returned element is always valid, and a drag that
 * runs past a limit simply stops there instead of inverting the clip.
 */
export function trimStart(
  element: TimelineElement,
  deltaMs: number,
): TimelineElement {
  // A template's length is the author's. Returning the element by identity is
  // what `withCheckpoint` reads as "nothing happened", so a drag that lands on
  // one costs no undo step.
  if (isDurationLocked(element)) {
    return element;
  }
  if (!isDynamicElement(element)) {
    const room = element.duration - MIN_TIMELINE_MS;
    const applied = clamp(deltaMs, -element.startTime, room);
    // Keyframe times are relative to `startTime`, so moving the left edge
    // without rebasing slides the whole animation against the content it was
    // drawn on. Rebase only — never slice: a trim is reversible, so a keyframe
    // pushed outside the visible window has to survive being pulled back in.
    return rebaseAnimation(
      {
        ...element,
        startTime: element.startTime + applied,
        duration: element.duration - applied,
      },
      applied,
    );
  }

  const speed = speedOf(element);
  const curve = speedCurveOf(element);
  const { startTime: srcStart, endTime: srcEnd } = element.trim;

  // How much source a timeline drag of `deltaMs` consumes, and how much
  // timeline a source distance costs. Both are a multiply and a divide by
  // `speed` on an unramped clip, and the ramp's integral and its inverse on a
  // ramped one. Written as two closures so the three clamps below read the same
  // either way: a second copy of this arithmetic in the branch is exactly how
  // the head clamp and the timeline-zero clamp would drift apart.
  const sourceAfter = (timelineMs: number) =>
    curve == null
      ? srcStart + timelineMs * speed
      : curveSourceAt(curve, srcStart, timelineMs);
  const timelineFor = (sourceMs: number) =>
    curve == null
      ? (sourceMs - srcStart) / speed
      : curveSpanLength(curve, srcStart, sourceMs);

  // Leftward travel is bounded by whichever runs out first: source head room,
  // or the timeline's own zero. The second bound is a *timeline* distance, so
  // it has to be carried into source units through the same map the drag uses.
  const maxLeftSource = Math.min(
    srcStart,
    srcStart - sourceAfter(-element.startTime),
  );
  const maxRightSource = srcEnd - srcStart - MIN_SOURCE_MS;
  const appliedSource = clamp(
    sourceAfter(deltaMs) - srcStart,
    -maxLeftSource,
    maxRightSource,
  );

  const nextSrcStart = srcStart + appliedSource;
  // Keyframes live in timeline ms, so the rebase distance is how much timeline
  // the consumed source was worth. On a ramped clip that is the integral rather
  // than a division, which makes the rule exactly right rather than nearly: a
  // keyframe at clip-local `k` goes on naming the source instant it named
  // before the trim, because the curve is anchored in source time and the new
  // window is a sub-window of the old one.
  const appliedTimeline = timelineFor(nextSrcStart);
  return rebaseAnimation(
    withTrim(
      element,
      element.startTime + appliedTimeline,
      srcEnd - nextSrcStart,
      nextSrcStart,
      srcEnd,
    ),
    appliedTimeline,
  );
}

/**
 * Drag the clip's right edge by `deltaMs` of **timeline** time.
 *
 * Positive lengthens. A dynamic clip stops at the end of its source file —
 * which is what `sourceDuration` exists for. Before that field, `trim.endTime`
 * doubled as the source length and was destroyed by the first inward drag, so
 * a trim could never be undone by dragging back out.
 */
export function trimEnd(
  element: TimelineElement,
  deltaMs: number,
): TimelineElement {
  if (isDurationLocked(element)) {
    return element;
  }
  if (!isDynamicElement(element)) {
    const applied = Math.max(deltaMs, MIN_TIMELINE_MS - element.duration);
    return { ...element, duration: element.duration + applied };
  }

  const speed = speedOf(element);
  const { startTime: srcStart, endTime: srcEnd } = element.trim;

  const curve = speedCurveOf(element);
  const minSource = MIN_SOURCE_MS - (srcEnd - srcStart);
  const maxSource = sourceDurationOf(element) - srcEnd;
  // Measured from the *tail*, so a drag outwards picks up footage at whatever
  // rate the curve holds past its last point. That is what "holds its end
  // values" means, and it is the only answer that does not need a rate for
  // footage the ramp says nothing about.
  const candidate =
    curve == null
      ? srcEnd + deltaMs * speed
      : curveSourceAt(curve, srcEnd, deltaMs);
  const appliedSource = clamp(candidate - srcEnd, minSource, maxSource);

  const nextSrcEnd = srcEnd + appliedSource;
  return withTrim(
    element,
    element.startTime,
    nextSrcEnd - srcStart,
    srcStart,
    nextSrcEnd,
  );
}

/**
 * Cut the clip at timeline time `atMs`.
 *
 * Returns `null` when the cut would produce an empty half, so callers can treat
 * "playhead sitting on a clip boundary" as a no-op rather than creating a
 * zero-length clip that is permanently invisible (spans are half-open).
 *
 * Both halves keep the element's `trackId`; the caller assigns the right half a
 * fresh id. Adjacency is exact — `left` ends precisely where `right` begins —
 * which is what lets the two pieces sit side by side on one track and be
 * rejoined without drift.
 */
export function splitAt(
  element: TimelineElement,
  atMs: number,
): { left: TimelineElement; right: TimelineElement } | null {
  // A template cannot be cut in two. Without this the branch below would take
  // the non-dynamic path — a template has no `trim` — and produce two halves
  // that each still render the whole composition, each to its own clock.
  if (isDurationLocked(element)) {
    return null;
  }

  const offset = atMs - element.startTime;
  if (offset <= 0 || offset >= spanLength(element)) {
    return null;
  }

  // `offset` is timeline ms and so are keyframe times, so the same window
  // serves both branches — the source-ms `cut` below is the wrong measure for
  // animation and using it here would misplace every keyframe on a sped-up clip.
  const span = spanLength(element);

  if (!isDynamicElement(element)) {
    return {
      left: sliceAnimation({ ...element, duration: offset }, 0, offset),
      right: rebaseAnimation(
        sliceAnimation(
          {
            ...element,
            startTime: element.startTime + offset,
            duration: element.duration - offset,
          },
          offset,
          span,
        ),
        offset,
      ),
    };
  }

  const { startTime: srcStart, endTime: srcEnd } = element.trim;
  // `sourceTimeAt` rather than `srcStart + offset * speed`, so a ramped clip
  // cuts at the frame the playhead is actually showing. Both halves keep the
  // same `speedCurve` array, and because the ramp is keyed in source ms and its
  // integral is additive, their spans reconstruct the original exactly.
  const cut = sourceTimeAt(element, atMs);

  return {
    left: sliceAnimation(
      withTrim(element, element.startTime, cut - srcStart, srcStart, cut),
      0,
      offset,
    ),
    right: rebaseAnimation(
      sliceAnimation(
        withTrim(
          element,
          element.startTime + offset,
          srcEnd - cut,
          cut,
          srcEnd,
        ),
        offset,
        span,
      ),
      offset,
    ),
  };
}
