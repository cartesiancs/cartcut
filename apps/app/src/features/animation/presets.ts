/**
 * The common animation moves, correctly built.
 *
 * Lifted out of `optionVideo.handleClickAddAnimatePreset` so the agent and the
 * panel's own Fade In / Zoom In buttons produce the same thing. The shape of
 * the composition matters more than the numbers: `setTrackActive` then two
 * `addKeyframe`s, folded into one transform, so the whole preset is one undo
 * step. Three separate writes is what it used to be, and undoing a preset was
 * impossible.
 *
 * Units differ per property and are easy to get wrong, which is most of the
 * reason to have presets at all:
 *
 *  - `opacity` is 0-100.
 *  - `scale` is **tenths** — 10 is unscaled, 12 is 120%. `transform.ts` divides
 *    the track value by 10.
 *  - `rotation` is degrees.
 */

import type { AnimatableProperty } from "../../@types/timeline";
import { animatableProperties } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import { spanLength } from "../timeline/geometry";
import { addKeyframe, setTrackActive } from "./keyframeOps";

export type PresetName = "fade_in" | "fade_out" | "zoom_in" | "zoom_out";

/** Unscaled, in the tenths the scale track stores. */
const SCALE_NEUTRAL = 10;
const SCALE_ZOOMED = 12;

type PresetShape = {
  property: AnimatableProperty;
  /** `[valueAtStart, valueAtEnd]` across the preset's duration. */
  values: [number, number];
  /** Anchored to the clip's end rather than its start. */
  fromEnd?: boolean;
};

const PRESETS: Record<PresetName, PresetShape> = {
  fade_in: { property: "opacity", values: [0, 100] },
  fade_out: { property: "opacity", values: [100, 0], fromEnd: true },
  zoom_in: { property: "scale", values: [SCALE_NEUTRAL, SCALE_ZOOMED] },
  zoom_out: { property: "scale", values: [SCALE_ZOOMED, SCALE_NEUTRAL] },
};

export function presetNames(): PresetName[] {
  return Object.keys(PRESETS) as PresetName[];
}

/** Which property a preset drives, for error messages. */
export function presetProperty(preset: PresetName): AnimatableProperty | null {
  return PRESETS[preset]?.property ?? null;
}

/**
 * Apply a preset to one element.
 *
 * Returns the document unchanged, by identity, when the element is missing or
 * cannot animate that property — a GIF and an audio clip carry no `animation`
 * block at all, and a shape carries only `opacity`.
 *
 * Keyframe times are element-local, which is the convention `keyframeOps`
 * works in: `0` is the clip's own start.
 */
export function applyPreset(
  doc: TimelineDocument,
  elementId: string,
  preset: PresetName,
  durationMs: number,
): TimelineDocument {
  const shape = PRESETS[preset];
  const element = doc.elements[elementId];

  if (shape == null || element == null) {
    return doc;
  }
  if (!animatableProperties(element).includes(shape.property)) {
    return doc;
  }

  const span = spanLength(element);
  // A preset longer than the clip is clamped rather than refused: "fade this in"
  // on a 200ms clip is a coherent request, and the 250ms default should not
  // turn it into an error.
  const length = Math.max(1, Math.min(durationMs, span));

  const [from, to] = shape.values;
  const startAt = shape.fromEnd ? Math.max(0, span - length) : 0;
  const endAt = startAt + length;

  let next = setTrackActive(doc, elementId, shape.property, true);
  next = addKeyframe(next, elementId, shape.property, "x", startAt, from);
  next = addKeyframe(next, elementId, shape.property, "x", endAt, to);

  return next;
}
