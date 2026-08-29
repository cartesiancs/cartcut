/**
 * Document-level edits to a full-frame effect.
 *
 * Modelled on `filterOps.ts`, including the rule that matters most: **switching
 * preset replaces the parameters rather than carrying them over.** That file's
 * header explains what carrying them over costs — a blur's `f=5` reinterpreted
 * as a chromakey threshold makes `distance() < 5` always true and the clip
 * renders fully transparent. Preset parameters here are keyed by name rather
 * than by position, which makes a silent collision less likely but not
 * impossible: two presets can both declare `amount` and mean quite different
 * ranges by it. Re-seeding from the new preset's defaults is the only version
 * that cannot surprise anyone.
 *
 * The caller supplies those defaults. This module stays DOM-free and knows
 * nothing about the preset registry, which reads from disk.
 *
 * Every mutator returns the document **by identity** when it changes nothing,
 * the contract `withCheckpoint` reads as "no undo step".
 */

import {
  isEffectElement,
  type EffectElementType,
  type FxParams,
  type TimelineElement,
} from "../../@types/timeline";
import { createEffectElement } from "../element/effectElement";
import { placeNewElement } from "./placement";
import { normalizeDocument, type TimelineDocument } from "./tracks";

/** What an effect's panel binds to, or `null` when the element is not one. */
export function effectOf(element: TimelineElement | undefined): {
  presetId: string;
  params: FxParams;
  intensity: number;
  blend?: GlobalCompositeOperation;
} | null {
  if (element == null || !isEffectElement(element)) {
    return null;
  }
  return {
    presetId: element.presetId,
    params: element.params,
    intensity: element.intensity,
    blend: element.blend,
  };
}

/**
 * Whether a stored parameter value already equals the one being written.
 *
 * `===` is not enough: a `point` parameter stores `[x, y]`, and two arrays with
 * the same numbers are never identical. Without this, dragging an XY control
 * back to where it started would record an undo step for a no-op edit.
 */
export function sameParamValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}

function effectAt(
  doc: TimelineDocument,
  elementId: string,
): EffectElementType | null {
  const element = doc.elements[elementId];
  return element != null && isEffectElement(element) ? element : null;
}

function writeEffect(
  doc: TimelineDocument,
  elementId: string,
  next: EffectElementType,
): TimelineDocument {
  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  };
}

/**
 * Place a new effect.
 *
 * Placement goes through `placeNewElement`, so an effect obeys the no-overlap
 * rule like any other clip: two effects on one row cannot cover the same
 * instant, and a second one at the same moment takes a row of its own — which
 * for effects is the right outcome anyway, since stacked rows compose.
 *
 * What it does **not** do is let `placeNewElement` invent the first effect
 * track. `appendTrackOfKind` now ranks the kinds and would land it at the top
 * anyway, but an adjustment layer's row is the whole feature rather than a
 * detail of where new rows go — the bottom row paints first, so an effect
 * composited there would apply to nothing at all. So when no effect track
 * exists yet, one is created at the top explicitly and named as the preference,
 * and this op does not depend on a table it does not own.
 *
 * Declines when the id is taken or the length is not positive.
 */
export function addEffect(
  doc: TimelineDocument,
  elementId: string,
  presetId: string,
  startMs: number,
  durationMs: number,
  newTrackId: string,
  params: FxParams = {},
  options: {
    intensity?: number;
    blend?: GlobalCompositeOperation;
    preferredTrackId?: string;
  } = {},
): TimelineDocument {
  if (doc.elements[elementId] != null) {
    return doc;
  }
  if (!(durationMs > 0)) {
    return doc;
  }

  const element = createEffectElement({
    presetId,
    params,
    startTime: startMs,
    duration: durationMs,
    intensity: options.intensity,
    blend: options.blend,
  });

  const hasEffectTrack = doc.tracks.some((track) => track.kind === "effect");
  const seeded = hasEffectTrack ? doc : addEffectTrack(doc, newTrackId);
  const preferred = hasEffectTrack ? options.preferredTrackId : newTrackId;

  return placeNewElement(
    seeded,
    elementId,
    element,
    startMs,
    // Only reachable when an effect track already existed and the requested
    // moment is busy on every one of them; `addEffectTrack` has already
    // consumed `newTrackId` otherwise.
    hasEffectTrack ? newTrackId : `${newTrackId}-overflow`,
    preferred,
  );
}

/**
 * Swap which preset an effect uses, re-seeding its parameters.
 *
 * `params` is replaced wholesale — see this module's header for why merging is
 * the wrong instinct here.
 */
export function setEffectPreset(
  doc: TimelineDocument,
  elementId: string,
  presetId: string,
  params: FxParams,
): TimelineDocument {
  const effect = effectAt(doc, elementId);
  if (effect == null || effect.presetId === presetId) {
    return doc;
  }
  return writeEffect(doc, elementId, { ...effect, presetId, params });
}

/** Patch individual parameter values, leaving the rest alone. */
export function setEffectParams(
  doc: TimelineDocument,
  elementId: string,
  patch: FxParams,
): TimelineDocument {
  const effect = effectAt(doc, elementId);
  if (effect == null) {
    return doc;
  }

  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return doc;
  }
  if (
    entries.every(([key, value]) => sameParamValue(effect.params[key], value))
  ) {
    return doc;
  }

  return writeEffect(doc, elementId, {
    ...effect,
    params: { ...effect.params, ...patch },
  });
}

/**
 * Set the effect's overall strength, 0-100.
 *
 * Clamped rather than refused, so a spinner scrubbed past its end settles at
 * the bound instead of recording nothing and leaving the field showing a value
 * the document does not hold.
 */
export function setEffectIntensity(
  doc: TimelineDocument,
  elementId: string,
  intensity: number,
): TimelineDocument {
  const effect = effectAt(doc, elementId);
  if (effect == null) {
    return doc;
  }

  const clamped = Math.max(0, Math.min(100, intensity));
  if (clamped === effect.intensity) {
    return doc;
  }
  return writeEffect(doc, elementId, { ...effect, intensity: clamped });
}

/**
 * Set how an overlay effect combines with the frame beneath it.
 *
 * `null` clears the field, which is what a shader preset wants — it does its
 * own combining in GLSL, and a stray `blend` left over from a previous overlay
 * preset would be read by the Canvas2D fast path.
 */
export function setEffectBlend(
  doc: TimelineDocument,
  elementId: string,
  blend: GlobalCompositeOperation | null,
): TimelineDocument {
  const effect = effectAt(doc, elementId);
  if (effect == null) {
    return doc;
  }
  if ((effect.blend ?? null) === blend) {
    return doc;
  }

  if (blend == null) {
    const { blend: _dropped, ...rest } = effect;
    return writeEffect(doc, elementId, rest as EffectElementType);
  }
  return writeEffect(doc, elementId, { ...effect, blend });
}

/**
 * Add an effect track above everything.
 *
 * Index 0 is the top row and the front of the composite, which for an effect
 * means "applies to every layer" — the sensible default, and the one the user
 * can then narrow by dragging the row down. `appendTrackOfKind` ranks `effect`
 * at the front too, so it would agree; this stays explicit because the
 * guarantee belongs to the feature rather than to that table, and because it
 * also declines an id that is already taken.
 */
export function addEffectTrack(
  doc: TimelineDocument,
  trackId: string,
): TimelineDocument {
  if (doc.tracks.some((track) => track.id === trackId)) {
    return doc;
  }
  const shifted = doc.tracks.map((track) => ({
    ...track,
    index: track.index + 1,
  }));
  return normalizeDocument({
    ...doc,
    tracks: [
      ...shifted,
      { id: trackId, kind: "effect" as const, name: "E1", index: 0 },
    ],
  });
}
