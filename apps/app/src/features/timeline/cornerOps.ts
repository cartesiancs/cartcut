/**
 * Rounding a clip's corners.
 *
 * One optional number, `cornerRadius`, on an image or a video, and the ops that
 * write it. Shaped like `mirrorOps.ts` and `scaleOps.ts`:
 *
 *  1. **Only image and video carry it.** A shape already has a radius in its
 *     geometry, and two on one clip would disagree about which wins.
 *  2. **Zero deletes the key rather than storing `0`.** A project nobody has
 *     rounded then saves byte-identically to one written before the feature,
 *     and `SCHEMA_VERSION` did not move.
 *  3. **Declining returns the document by identity**, so re-applying the
 *     radius a clip already has records no undo step.
 *  4. **Off keeps the radius.** The Corners section's eye writes
 *     `cornerRadiusOff`, a second optional key, rather than clearing the
 *     radius, for the reason a disabled border keeps its width: switching it
 *     back on has to give back what was there, a keyed curve included.
 *     `cornerRadiusOf` answers what is stored and `cornerRadiusAt` what is
 *     drawn, which is 0 while it is off.
 *
 * Where it is drawn is `renderer/element.ts#drawDirect`, in box space and
 * before the mirror and the crop, so the corners belong to the box on screen
 * and a border and a shadow trace them.
 */

import { isRoundable, type TimelineElement } from "../../@types/timeline";
import { sampleTrack } from "../animation/keyframes";
import type { TimelineDocument } from "./tracks";

export { ROUNDABLE_FILETYPES, isRoundable } from "../../@types/timeline";

/**
 * The largest radius that is stored, in element pixels.
 *
 * Above half the shorter side of any box this app produces, so it never caps
 * a radius somebody could see. It exists so the agent's `RANGES` has a finite
 * ceiling to state; the clamp that shapes the picture is half the shorter side
 * of the box, applied where it is drawn.
 */
export const MAX_CORNER_RADIUS = 2000;

function clampRadius(n: number): number {
  return Math.min(MAX_CORNER_RADIUS, Math.max(0, n));
}

/**
 * The static radius on a clip, in element pixels.
 *
 * The read guard. It runs inside the paint loop and must never throw, so
 * anything that is not a finite number reads as square, and a negative one is
 * floored at zero: Chromium's `roundRect` **throws** a `RangeError` on a
 * negative radius, which in a paint loop is a blank frame, and
 * `@napi-rs/canvas` does not, so no node suite would catch it.
 */
export function cornerRadiusOf(
  element: TimelineElement | null | undefined,
): number {
  if (!isRoundable(element)) {
    return 0;
  }
  const raw = (element as { cornerRadius?: unknown }).cornerRadius;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return clampRadius(raw);
}

/**
 * A radius fit to store, or `null` for a value that is not a number at all.
 *
 * The write validator, the strict twin of `cornerRadiusOf`. A number out of
 * range is clamped rather than refused, the bargain `coerceStroke` makes.
 */
export function coerceCornerRadius(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) {
    return null;
  }
  return clampRadius(n);
}

/**
 * A live keyframe track, or `null`.
 *
 * The `isActivate` gate is the point. `sampleTrack` answers off `ax` whenever
 * `ax` exists, and a track switched off still holds its curve, so without the
 * gate a disarmed radius would go on animating. The same helper is written out
 * at `audio.ts#activeTrack` and three other places, deliberately.
 */
function activeTrack(element: TimelineElement, property: string): unknown {
  const track = (element as any)?.animation?.[property];
  return track != null && track.isActivate === true ? track : null;
}

/**
 * The radius this clip is drawn with at `cursorMs`, in element pixels.
 *
 * **A keyframed radius behaves exactly like the static field it keyframes**,
 * the contract `volumeDbAt` states for sound: the sampled value replaces
 * `cornerRadius`, before the clip starts and while the track is off the field
 * answers.
 *
 * Clamped **at the read**, never in the curve, so a curve may overshoot below
 * zero between its keys the way every other curve does without ever reaching
 * `roundRect` as a negative number. 0 while the eye is off, whatever is
 * stored.
 *
 * Not half the shorter side. That clamp needs the sampled box, and belongs to
 * the one place that has it, `renderer/decoration.ts#frameOutline`. Not a field
 * on `transform.ts#LocalSample` either, for the reason `volumeDbAt` gives: a
 * radius moves no box, and five consumers of that sample would carry it.
 */
export function cornerRadiusAt(
  element: TimelineElement | null | undefined,
  cursorMs: number,
): number {
  if (cornerRadiusOffOf(element)) {
    return 0;
  }
  const fallback = cornerRadiusOf(element);
  if (element == null || !isRoundable(element)) {
    return fallback;
  }
  const track = activeTrack(element, "cornerRadius");
  if (track == null) {
    return fallback;
  }
  const sampled = sampleTrack(
    track as any,
    (element as any).startTime,
    cursorMs,
    fallback,
  );
  return Number.isFinite(sampled) ? clampRadius(sampled) : fallback;
}

/**
 * Set one clip's static radius, or clear it with 0.
 *
 * Declines, returning `doc` itself, for an id that is not in the document, a
 * clip that cannot be rounded, a value that is not a number, and the radius it
 * already has. Clearing a clip that was never rounded is the last of those.
 */
export function setCornerRadius(
  doc: TimelineDocument,
  elementId: string,
  radius: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRoundable(element)) {
    return doc;
  }
  const next = coerceCornerRadius(radius);
  if (next == null) {
    return doc;
  }
  const stored = (element as { cornerRadius?: unknown }).cornerRadius;
  if (next === 0 ? stored === undefined : stored === next) {
    return doc;
  }

  let updated: TimelineElement;
  if (next === 0) {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined
    // value, so the saved project would not match the one in memory. The off
    // switch goes with it unless a curve is left for it to hide, so a clip
    // squared for good carries nothing a clip never rounded does not.
    const { cornerRadius: _cleared, ...rest } = element as TimelineElement &
      Record<string, unknown>;
    updated = (
      hasCornerTrack(element) ? rest : withoutOffSwitch(rest)
    ) as TimelineElement;
  } else {
    updated = { ...element, cornerRadius: next } as TimelineElement;
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: updated },
  };
}

/** `setCornerRadius` over a selection, as one document. */
export function setCornerRadiusMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  radius: number,
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => setCornerRadius(accumulated, id, radius),
    doc,
  );
}

// ------------------------------------------------------------- the eye

/**
 * Whether the Corners section's eye is off on this clip. Anything but a
 * literal `true` reads as on, so a hand-edited project cannot square a clip
 * with a truthy string.
 */
export function cornerRadiusOffOf(
  element: TimelineElement | null | undefined,
): boolean {
  return (
    isRoundable(element) &&
    (element as { cornerRadiusOff?: unknown }).cornerRadiusOff === true
  );
}

/** Whether a curve is kept on the clip, armed or not. */
function hasCornerTrack(element: TimelineElement): boolean {
  const track = (element as any)?.animation?.cornerRadius;
  return Array.isArray(track?.x) && track.x.length > 0;
}

function withoutOffSwitch(element: Record<string, unknown>) {
  const { cornerRadiusOff: _cleared, ...rest } = element;
  return rest;
}

/**
 * Whether the eye shows on: the clip has corners to draw and they are not
 * switched off. A radius counts, and so does an armed curve on a clip whose
 * static field is square, which is how a card that opens from square corners
 * is keyed.
 */
export function cornersOn(
  element: TimelineElement | null | undefined,
): boolean {
  if (element == null || !isRoundable(element) || cornerRadiusOffOf(element)) {
    return false;
  }
  return (
    cornerRadiusOf(element) > 0 || activeTrack(element, "cornerRadius") != null
  );
}

/**
 * The radius the eye switches a square clip on with: a twentieth of the
 * shorter side of its box.
 *
 * Proportional rather than a fixed number, which is the one place this parts
 * from the border's default width. A border of 2px reads at any size; a
 * corner of 24px is a card on a 1280-wide clip and invisible on a 3600-wide
 * screen recording, which is the footage this is most often put on.
 */
export function defaultCornerRadius(width: number, height: number): number {
  const shorter = Math.min(width, height);
  if (!Number.isFinite(shorter) || shorter <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(shorter / 20));
}

/**
 * Switch the eye off, or on again with whatever was there.
 *
 * Declines, returning `doc` itself, for a clip that cannot be rounded, the
 * state it is already in, and switching off a clip whose corners are already
 * square: a switch with nothing to hide is a key with no meaning.
 */
export function setCornerRadiusOff(
  doc: TimelineDocument,
  elementId: string,
  off: boolean,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRoundable(element) || cornerRadiusOffOf(element) === off) {
    return doc;
  }
  if (off && !cornersOn(element)) {
    return doc;
  }
  const updated = (
    off
      ? { ...element, cornerRadiusOff: true }
      : withoutOffSwitch(element as TimelineElement & Record<string, unknown>)
  ) as TimelineElement;
  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: updated },
  };
}

/**
 * What the eye does when it is clicked on: give back the corners that were
 * hidden, or round a square clip with `radiusIfNone`, the way the border's
 * eye writes its defaults on a clip that never had one.
 */
export function showCorners(
  doc: TimelineDocument,
  elementId: string,
  radiusIfNone: number,
): TimelineDocument {
  const shown = setCornerRadiusOff(doc, elementId, false);
  if (cornersOn(shown.elements[elementId])) {
    return shown;
  }
  return setCornerRadius(shown, elementId, radiusIfNone);
}
