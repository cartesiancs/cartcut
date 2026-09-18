/**
 * Changing a clip's playback rate.
 *
 * Speed sits between the two invariants `geometry.ts` states, and only one of
 * them mentions it:
 *
 *  - `duration === trim.endTime - trim.startTime`, in **source** ms. `speed`
 *    does not appear, so changing it cannot break `assertTrimInvariant`. None
 *    of the footage is gained or lost.
 *  - the clip occupies `[startTime, startTime + duration/speed)` on the
 *    **timeline**. `speed` is the divisor, so changing it *resizes the clip
 *    where it sits*.
 *
 * That second one is why this is not a field `update_clip` may write. Halving
 * the speed of a ten-second clip makes it occupy twenty and overlap whatever
 * is next to it — and "clips on a track never overlap" is the one rule every
 * other op in `clipOps.ts` checks with `findCollisions` and declines on.
 * `update_clip` has no collision check and no ripple, and bolting one onto a
 * generic property patcher would make its contract incoherent.
 *
 * Keyframes are deliberately left at their own times. They are stored in
 * timeline ms relative to the clip's start, so speeding a clip up leaves its
 * animation running past the new end. Rescaling them is a defensible choice
 * and so is not rescaling them; there is no UI precedent either way, and
 * silently rewriting curves the user authored is the worse failure. The tool
 * description says which one this is.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  isDynamicElement,
  spanOf,
  speedOf,
  type DynamicElement,
} from "./geometry";
import { withDerivedSpeed, withSpeedCurve } from "./clipEdit";
import {
  coerceSpeedCurve,
  MAX_SPEED,
  MIN_SPEED,
  speedCurveOf,
  type SpeedPoint,
} from "./speedCurve";
import { findCollisions } from "./overlap";
import { clipsOnTrack, normalizeDocument, type TimelineDocument } from "./tracks";

/**
 * The range the UI offers.
 *
 * Re-exported rather than declared, the way `mergeOps.ts` re-exports
 * `ADJACENCY_EPSILON_MS`. It moved to `speedCurve.ts` when the ramp arrived,
 * because a ramp's points are clamped to the same range and that file imports
 * nothing, so it cannot read a constant from here. Every existing importer
 * names `speedOps`, and keeping the name working is cheaper than a rename that
 * would touch the agent command and every suite.
 */
export { MIN_SPEED, MAX_SPEED } from "./speedCurve";

/**
 * The rates the option panel lists.
 *
 * A fixed menu rather than a scrub, because changing speed *resizes the clip*:
 * a continuous drag would rewrite every trailing clip on the lane on every
 * mousemove. Discrete rates make one change one undo step, and the two ends are
 * exactly the cases `ffmpegArgs.ts#atempoChain` has to chain two filters for.
 */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

/** Below this, a difference in span is not worth an undo step. */
const EPSILON_MS = 0.5;

/**
 * Whether this element has a playback rate at all.
 *
 * Deliberately `isDynamicElement` rather than a `SPEEDABLE_FILETYPES` list of
 * the kind `lutOps` and `maskOps` carry. Those need one because `Gradable` and
 * `Maskable` are mixins with no existing predicate; here the predicate already
 * exists, and it already knows that `mp4`/`mov`/`mp3` are dynamic aliases. A
 * second list would disagree with `setClipSpeed`'s own guard the moment either
 * moved, and disagree silently.
 */
export function isSpeedAdjustable(
  element: TimelineElement | null | undefined,
): boolean {
  return element != null && isDynamicElement(element);
}

/**
 * Validate a speed on its way *in*, the write half of the pair `geometry.ts`'s
 * `speedOf` reads with — the same split as `coerceFps`/`normalizeFps` and
 * `coerceBlend`/`blendOf`. Answers `null` for anything unusable, so a bad rate
 * is unrepresentable from the point it is stored.
 *
 * Takes a string as well as a number: a `<select>` hands back `"2"`.
 *
 * Unlike `coerceFps` it does **not round**. A frame rate of 59.99 is a float
 * artefact of a number that has to be whole; 1.75x is a rate someone meant.
 */
export function coerceSpeed(value: unknown): number | null {
  const speed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    return null;
  }
  return speed;
}

/**
 * The rates to list for a clip currently running at `current`.
 *
 * The presets, plus `current` itself when it is not one of them. `set_clip_speed`
 * accepts any rate in range, so a clip can arrive at 1.7x from the agent — and a
 * menu that did not carry it would render as its own first entry, showing 0.25x
 * for a clip running at 1.7x and turning the user's next click into a second
 * edit rather than the one they meant.
 */
export function speedOptionsFor(current: number): number[] {
  const presets: number[] = [...SPEED_PRESETS];
  const speed = coerceSpeed(current);

  if (speed == null || presets.includes(speed)) {
    return presets;
  }
  return [...presets, speed].sort((left, right) => left - right);
}

/**
 * Set one clip's playback rate.
 *
 * Returns the document unchanged, **by identity**, when the clip is missing,
 * carries no source window, the speed is out of range or unchanged, or the new
 * span would overlap a neighbour and `ripple` is off.
 */
export function setClipSpeed(
  doc: TimelineDocument,
  elementId: string,
  speed: number,
  options: { ripple?: boolean } = {},
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isSpeedAdjustable(element)) {
    return doc;
  }

  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    return doc;
  }

  // A ramped clip always proceeds, ahead of both identity guards below.
  // `speedOf` on one of those is the *derived mean*, so a clip ramping around
  // 1.5x asked for 1.5x would match the first guard, and one whose mean is
  // close enough would match the second. Either way the pick would delete
  // nothing, leave the ramp running, and report success: the two clips a user
  // is most likely to reach for this control on are exactly the two it would
  // silently refuse.
  const ramped = speedCurveOf(element) != null;

  const current = speedOf(element);
  if (!ramped && Math.abs(current - speed) < 1e-9) {
    return doc;
  }

  const before = spanOf(element);
  const newLength = element.duration / speed;
  const delta = newLength - before.length;

  if (!ramped && Math.abs(delta) < EPSILON_MS) {
    return doc;
  }

  // Picking a rate flattens the ramp. Destructive and deliberate: this control
  // states one rate for the whole clip, and a rate that silently rode on top of
  // a curve would be a third meaning for `speed`. The panel shows the ramp
  // directly below, and undo is one keystroke.
  const resized = withSpeedCurve(
    { ...element, speed } as DynamicElement,
    null,
  ) as TimelineElement;

  return resizeClipTo(doc, elementId, resized, options.ripple === true);
}

/**
 * Put a resized clip into the document, and make room for it or refuse.
 *
 * Shared by the two ops that change how long a clip is without changing how
 * much footage it holds, `setClipSpeed` and `setClipSpeedCurve`. One copy,
 * because the property the option panel leans on is a property of this function
 * rather than of either caller: with `ripple` on, the gap in front of every
 * later clip changes by exactly the amount this one grew or shrank, so a
 * collision has nowhere to come from and no rate ever has to be refused.
 *
 * `resized` must already carry its final `speed` and `speedCurve`; this reads
 * its span and nothing else about it.
 */
function resizeClipTo(
  doc: TimelineDocument,
  elementId: string,
  resized: TimelineElement,
  ripple: boolean,
): TimelineDocument {
  const element = doc.elements[elementId];
  const before = spanOf(element);
  const after = spanOf(resized);
  const delta = after.length - before.length;

  if (!ripple) {
    const withResized = { ...doc.elements, [elementId]: resized };
    const collisions = findCollisions(
      { ...doc, elements: withResized },
      element.trackId,
      { start: after.start, end: after.end },
      [elementId],
    );
    if (collisions.length > 0) {
      return doc;
    }
    return normalizeDocument({ ...doc, elements: withResized });
  }

  // Lane-local, exactly like `rippleDelete`: only clips after this one on the
  // same track move, and only by the amount this clip grew or shrank. A
  // magnetic timeline that pulled every track along would be a different
  // feature, and not one this editor has anywhere else.
  const elements: Record<string, TimelineElement> = {
    ...doc.elements,
    [elementId]: resized,
  };

  for (const [id, clip] of clipsOnTrack(doc, element.trackId)) {
    if (id === elementId) {
      continue;
    }
    if (spanOf(clip).start < before.end) {
      continue;
    }
    elements[id] = {
      ...clip,
      startTime: Math.max(0, clip.startTime + delta),
    } as TimelineElement;
  }

  return normalizeDocument({ ...doc, elements });
}

/**
 * Put a speed ramp on one clip, or take it off.
 *
 * The curve's own writer, next to `setClipSpeed` because it has the same effect
 * on the lane: the clip's timeline length is what the ramp takes to play its
 * source window, so authoring a curve *resizes the clip where it sits* and the
 * ripple that follows is the same one.
 *
 * `points` is **absolute**, never a delta, which is what lets a drag re-apply it
 * on every pointermove through one `GestureCommit` and collapse to a single undo
 * step. `null` removes the ramp and leaves `speed` at the mean it was running,
 * so flattening changes how the footage plays inside the clip and not where the
 * clip sits.
 *
 * Returns the document unchanged, **by identity**, when the clip is missing,
 * carries no source window, the curve is already what was asked for, or the new
 * span would overlap a neighbour with `ripple` off.
 */
export function setClipSpeedCurve(
  doc: TimelineDocument,
  elementId: string,
  points: readonly SpeedPoint[] | null,
  options: { ripple?: boolean } = {},
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isSpeedAdjustable(element)) {
    return doc;
  }

  const resized = withSpeedCurve(element as DynamicElement, points);
  if (resized === element) {
    return doc;
  }

  return resizeClipTo(
    doc,
    elementId,
    resized as TimelineElement,
    options.ripple === true,
  );
}

/**
 * Validate every ramp in a document and re-derive the scalar each one implies.
 *
 * Ingress only, called from `timelineStore.patchDocument` one line after
 * `normalizeAnimations`, and for the same reason that one is there: `speed`
 * means two things depending on whether a curve is present, and this is the
 * cheap moment to make a file that disagrees with itself self-heal. A project
 * written by a build with a bug, hand-edited, or saved by a future version
 * arrives with its curve coerced and its scalar recomputed, so nothing
 * downstream has to wonder which of the two to believe.
 *
 * Not in `normalizeDocument`, which runs on every checkpoint and every clip op;
 * re-walking curves at pointer rate to re-check data that was checked on the
 * way in is pure cost, which is the argument `patchDocument` already makes for
 * the baked lanes.
 *
 * Returns the document **by identity** when nothing changed, so a project with
 * no ramps costs one walk and no allocation.
 */
export function normalizeSpeedCurves(doc: TimelineDocument): TimelineDocument {
  let changed = false;
  const elements: Record<string, TimelineElement> = {};

  for (const [id, element] of Object.entries(doc.elements)) {
    elements[id] = element;

    if (!isDynamicElement(element) || element.speedCurve === undefined) {
      continue;
    }

    const coerced = coerceSpeedCurve(element.speedCurve);
    const repaired = withSpeedCurve(element, coerced);
    // `withSpeedCurve` settles the scalar when it writes a curve, but a file
    // whose points were already legal returns by identity and may still carry a
    // stale scalar, which is the exact shape a buggy writer leaves behind.
    const settled = withDerivedSpeed(repaired);

    if (settled !== element) {
      elements[id] = settled;
      changed = true;
    }
  }

  return changed ? { ...doc, elements } : doc;
}
