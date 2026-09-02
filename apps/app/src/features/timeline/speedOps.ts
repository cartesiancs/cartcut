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
import { isDynamicElement, spanOf, speedOf } from "./geometry";
import { findCollisions } from "./overlap";
import { clipsOnTrack, normalizeDocument, type TimelineDocument } from "./tracks";

/** The range the UI offers. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

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

  const current = speedOf(element);
  if (Math.abs(current - speed) < 1e-9) {
    return doc;
  }

  const before = spanOf(element);
  const newLength = element.duration / speed;
  const delta = newLength - before.length;

  if (Math.abs(delta) < EPSILON_MS) {
    return doc;
  }

  const resized = { ...element, speed } as TimelineElement;
  const newEnd = before.start + newLength;

  const ripple = options.ripple === true;

  if (!ripple) {
    const withResized = { ...doc.elements, [elementId]: resized };
    const collisions = findCollisions(
      { ...doc, elements: withResized },
      element.trackId,
      { start: before.start, end: newEnd },
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
