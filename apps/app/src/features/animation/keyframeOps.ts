/**
 * Keyframe editing at the document level.
 *
 * `keyframes.ts` is to this file what `clipEdit.ts` is to `clipOps.ts`: the
 * arithmetic on one track, with no notion of a document around it. This is the
 * layer `withCheckpoint` drives, and so it is where the decline-by-identity
 * contract lives — an op that changes nothing returns the document it was
 * given, and `withCheckpoint` compares by identity to decide whether an undo
 * step happened.
 *
 * The single most important property here: authored keyframes and their baked
 * samples are written **together**, in one transform. The API this replaces made
 * baking a separate `interpolate()` call the caller had to remember, and the
 * editor's delete path forgot it — so the store kept applying an animation the
 * user had just removed.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import {
  DEFAULT_HANDLE_MS,
  addKeyframe as addToList,
  bakeTrack,
  moveKeyframe as moveInList,
  normalizeAnimation,
  removeKeyframe as removeFromList,
  setHandles as setHandlesInList,
  type Keyframe,
  type Lane,
} from "./keyframes";

export type { Lane };

/** Baked-array field name for a lane. */
function bakedKeyOf(lane: Lane): "ax" | "ay" {
  return lane === "x" ? "ax" : "ay";
}

type Resolved = {
  element: TimelineElement;
  track: any;
  list: Keyframe[];
};

/**
 * Look up an element's track, or `null` if the edit has nowhere to land.
 *
 * `animatableProperties` is the gate rather than a plain `in` check: a shape
 * carries only `opacity` in its type, so a `scale` keyframe on one would create
 * a track the renderer never reads and the type system says cannot exist.
 */
function resolve(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
): Resolved | null {
  const element = doc.elements[elementId];
  if (element == null) {
    return null;
  }
  if (!animatableProperties(element).includes(property)) {
    return null;
  }

  const track = (element as any).animation?.[property];
  if (track == null || typeof track !== "object") {
    return null;
  }
  // Only `position` has a second lane; asking for `y` anywhere else is a bug in
  // the caller, not something to invent a track for.
  if (lane === "y" && !("y" in track)) {
    return null;
  }

  const list = Array.isArray(track[lane]) ? (track[lane] as Keyframe[]) : [];
  return { element, track, list };
}

/**
 * Rebuild the document with one lane replaced, re-baking as it goes.
 *
 * Every object from the document root down to the changed lane is copied and
 * everything else is shared, which is what keeps a keyframe edit from reaching
 * into the undo history — the failure mode that made this whole module
 * necessary.
 */
function withLane(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  list: Keyframe[],
): TimelineDocument {
  const element = doc.elements[elementId] as any;
  const animation = element.animation;
  const track = animation[property];

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: {
        ...element,
        animation: {
          ...animation,
          [property]: {
            ...track,
            [lane]: list,
            [bakedKeyOf(lane)]: bakeTrack(list),
          },
        },
      },
    },
  };
}

export function addKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  tMs: number,
  value: number,
  handleMs: number = DEFAULT_HANDLE_MS,
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = addToList(found.list, tMs, value, handleMs);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next);
}

export function moveKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  tMs: number,
  value: number,
): { doc: TimelineDocument; index: number } {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return { doc, index };
  }
  const moved = moveInList(found.list, index, tMs, value);
  if (moved.list === found.list) {
    return { doc, index: moved.index };
  }
  return {
    doc: withLane(doc, elementId, property, lane, moved.list),
    index: moved.index,
  };
}

export function removeKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = removeFromList(found.list, index);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next);
}

export function setHandles(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  patch: { cs?: [number, number]; ce?: [number, number] },
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = setHandlesInList(found.list, index, patch);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next);
}

/**
 * The element's own static value for a property, used to seed a track.
 *
 * Scale is stored in tenths — `renderElement` divides by 10 — so an unscaled
 * element seeds at 10, not 1. That constant is otherwise only visible as a bare
 * `interpolate(10, ...)` in the renderer.
 */
function staticValueOf(
  element: TimelineElement,
  property: AnimatableProperty,
  lane: Lane,
): number {
  const any = element as any;
  switch (property) {
    case "position":
      return (lane === "x" ? any.location?.x : any.location?.y) ?? 0;
    case "opacity":
      return any.opacity ?? 100;
    case "rotation":
      return any.rotation ?? 0;
    case "scale":
      return 10;
  }
}

/**
 * Turn a property's animation on or off.
 *
 * Switching on with `seed` and no keyframes yet plants one at the cursor
 * carrying the element's current static value, so the first thing the user does
 * after enabling animation is not "watch the element jump".
 *
 * Switching off keeps the keyframes. Re-enabling should restore the animation
 * the user drew, not present them with an empty track — deleting their work is
 * what the `remove` button is for.
 */
export function setTrackActive(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  active: boolean,
  seed?: { atMs: number },
): TimelineDocument {
  const element = doc.elements[elementId] as any;
  if (element == null || !animatableProperties(element).includes(property)) {
    return doc;
  }
  const track = element.animation?.[property];
  if (track == null || typeof track !== "object") {
    return doc;
  }

  const lanes: Lane[] = "y" in track ? ["x", "y"] : ["x"];
  const alreadyActive = track.isActivate === true;

  const nextTrack: any = { ...track, isActivate: active };
  let changed = alreadyActive !== active;

  if (active && seed != null) {
    for (const lane of lanes) {
      const list = Array.isArray(track[lane]) ? (track[lane] as Keyframe[]) : [];
      if (list.length > 0) {
        continue;
      }
      const seeded = addToList(
        list,
        seed.atMs,
        staticValueOf(element, property, lane),
      );
      if (seeded !== list) {
        nextTrack[lane] = seeded;
        nextTrack[bakedKeyOf(lane)] = bakeTrack(seeded);
        changed = true;
      }
    }
  }

  if (!changed) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: {
        ...element,
        animation: { ...element.animation, [property]: nextTrack },
      },
    },
  };
}

/**
 * Repair every element's animation block, or return the document untouched.
 *
 * Called on ingress — `patchDocument`, which is what project load goes through
 * — and deliberately *not* from `normalizeDocument`, which runs on every
 * checkpoint and every clip op. Walking keyframe arrays at pointer rate to
 * re-validate data that was already validated when it entered would be a real
 * cost for no benefit.
 */
export function normalizeAnimations(doc: TimelineDocument): TimelineDocument {
  let changed = false;
  const elements: Record<string, TimelineElement> = {};

  for (const [id, element] of Object.entries(doc.elements)) {
    const next = normalizeAnimation(element);
    elements[id] = next;
    if (next !== element) {
      changed = true;
    }
  }

  return changed ? { ...doc, elements } : doc;
}
