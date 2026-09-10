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
import {
  DEFAULT_MASK_FEATHER,
  DEFAULT_MASK_LOCATION,
  DEFAULT_MASK_ROTATION,
  DEFAULT_MASK_ROUNDNESS,
  DEFAULT_MASK_SIZE,
  maskOf,
} from "../mask/maskShape";
import { DEFAULT_REVEAL_PROGRESS, revealOf } from "../text/reveal";
import { setClipMaskFields } from "../timeline/maskOps";
import { setClipTextRevealFields } from "../timeline/textRevealOps";
import { isTrackLive } from "../timeline/keyframeMarkers";
import { keyframeNavAt } from "./keyframeNav";
import { setIn } from "../../utils/immutable";
import type { TimelineDocument } from "../timeline/tracks";
import {
  BAKE_HZ,
  DEFAULT_HANDLE_MS,
  type Baked,
  addKeyframe as addToList,
  bakeTrack,
  isConditionalTrack,
  lanesOf,
  moveKeyframe as moveInList,
  normalizeAnimation,
  plantKeyframe,
  removeKeyframe as removeFromList,
  sampleBaked,
  setHandles as setHandlesInList,
  siblingLane,
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
  bakeHz: number = BAKE_HZ,
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
            [bakedKeyOf(lane)]: bakeTrack(list, bakeHz),
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
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = addToList(found.list, tMs, value, handleMs);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next, bakeHz);
}

export function moveKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  tMs: number,
  value: number,
  bakeHz: number = BAKE_HZ,
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
    doc: withLane(doc, elementId, property, lane, moved.list, bakeHz),
    index: moved.index,
  };
}

export function removeKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = removeFromList(found.list, index);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next, bakeHz);
}

export function setHandles(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  patch: { cs?: [number, number]; ce?: [number, number] },
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const found = resolve(doc, elementId, property, lane);
  if (found == null) {
    return doc;
  }
  const next = setHandlesInList(found.list, index, patch);
  if (next === found.list) {
    return doc;
  }
  return withLane(doc, elementId, property, lane, next, bakeHz);
}

// ------------------------------------------------------- paired lane editing

/**
 * Keyframe editing for `position`, where the two lanes are one thing.
 *
 * Every producer of position keyframes already writes `x` and `y` at the same
 * instant — `setTrackActive` seeds both, `previewCanvas` commits both in one
 * checkpoint, the transform panel writes both. The curve editor was the sole
 * exception: it edited whichever lane the x/y buttons had selected, so dragging
 * a dot along the time axis moved one half of the pair and left the other
 * behind. The element then traced a path nobody had drawn, and there was no way
 * to see why from the lane you were looking at.
 *
 * So the pairing is enforced here rather than in the editor. Structure — which
 * instants carry a keyframe — is shared between the lanes; only the *value* is
 * per-lane. Add, remove, and time-drag act on both; dragging the value axis
 * acts on the one being edited.
 *
 * A sibling is matched by **time, not index**. Projects authored before this
 * existed can have lanes of different lengths, and an index would silently pair
 * up two unrelated keyframes.
 */

/** Whether a property's structure spans two lanes. */
function isPaired(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
): boolean {
  if (lanesOf(property).length < 2) {
    return false;
  }
  // The type says `position` has two lanes; the document is what decides
  // whether *this* element's track actually carries them.
  return resolve(doc, elementId, property, "y") != null;
}

/** The index in `list` of the keyframe at exactly `tMs`, or `-1`. */
function indexAtTime(list: Keyframe[], tMs: number): number {
  for (let i = 0; i < list.length; i++) {
    if (list[i].p[0] === tMs) {
      return i;
    }
  }
  return -1;
}

/**
 * The value the sibling lane holds at `tMs`, when `tMs` lies outside its curve.
 *
 * `null` means "inside the authored range", where the curve is real and
 * `plantKeyframe` must preserve it exactly. Outside it — or on a lane with no
 * keyframes at all — there is nothing to preserve: the track reads its nearest
 * end value there (`sampleBaked` clamps to the first and last samples), so the
 * new keyframe can be added with ordinary handles and the pair comes out with
 * one shape on both lanes.
 */
function heldValueOutside(
  list: Keyframe[],
  tMs: number,
  staticValue: number,
): number | null {
  if (list.length === 0) {
    // The element's own static value is what the renderer would have shown at
    // that instant anyway.
    return staticValue;
  }
  if (tMs < list[0].p[0]) {
    return list[0].p[1];
  }
  const last = list[list.length - 1];
  if (tMs > last.p[0]) {
    return last.p[1];
  }
  return null;
}

/**
 * Add a keyframe to `lane`, and a matching one to its sibling.
 *
 * The sibling's keyframe is *planted* — placed on the curve that lane already
 * has, with control points from an exact de Casteljau subdivision — so the
 * lane the user was not editing keeps the shape it had and merely gains a
 * point on it. Resampling it through fresh default handles instead, which is
 * the obvious implementation, visibly bows the sibling curve between the new
 * keyframe and its neighbours. Seeding it from the static `location`, which is
 * all there was before pairing existed, would be worse still: it would yank
 * the other axis to wherever the element started.
 */
export function addKeyframePaired(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  tMs: number,
  value: number,
  handleMs: number = DEFAULT_HANDLE_MS,
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const primary = addKeyframe(
    doc,
    elementId,
    property,
    lane,
    tMs,
    value,
    handleMs,
    bakeHz,
  );
  if (!isPaired(doc, elementId, property)) {
    return primary;
  }

  const other = siblingLane(lane);
  // Read the sibling from the document as it was, before the primary add. The
  // lanes are independent, so reading from `primary` would work by luck.
  const sibling = resolve(doc, elementId, property, other);
  if (sibling == null) {
    return primary;
  }

  // Outside the sibling's authored range there is no curve to preserve — the
  // track simply holds its nearest end value — so the keyframe is *added*, with
  // the same `handleMs` the primary lane just got, rather than planted.
  //
  // Planting there was the bug: `planted` appends its boundary keyframe with
  // handles collapsed onto the anchor, which is right for the caller it was
  // written for (clip splitting, where the curve must not change), and the
  // `addKeyframe` that follows takes its replace-in-place branch, which
  // deliberately *keeps* the handles already on a keyframe. So the pair came out
  // with two different curves: the edited lane eased and the sibling ran linear.
  // Authoring forward in time takes this branch every time, which is why a
  // dragged diagonal bowed and a size+position zoom drifted off its focus point.
  const held = heldValueOutside(
    sibling.list,
    tMs,
    staticValueOf(doc.elements[elementId], property, other),
  );
  if (held != null) {
    return addKeyframe(
      primary,
      elementId,
      property,
      other,
      tMs,
      held,
      handleMs,
      bakeHz,
    );
  }

  const planted = plantKeyframe(sibling.list, tMs);
  if (planted === sibling.list) {
    // Already a keyframe there; the pair is intact.
    return primary;
  }
  return withLane(primary, elementId, property, other, planted, bakeHz);
}

/**
 * Move a keyframe, taking its sibling along.
 *
 * The sibling moves in time only — it keeps its own value, because the drag
 * expressed an intent about one lane's curve and one lane's curve alone.
 */
export function moveKeyframePaired(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  tMs: number,
  value: number,
  bakeHz: number = BAKE_HZ,
): { doc: TimelineDocument; index: number } {
  if (!isPaired(doc, elementId, property)) {
    return moveKeyframe(
      doc,
      elementId,
      property,
      lane,
      index,
      tMs,
      value,
      bakeHz,
    );
  }

  const found = resolve(doc, elementId, property, lane);
  const original = found?.list[index];
  if (original == null) {
    return { doc, index };
  }
  const fromMs = original.p[0];

  const primary = moveKeyframe(
    doc,
    elementId,
    property,
    lane,
    index,
    tMs,
    value,
    bakeHz,
  );
  if (primary.doc === doc) {
    // Declined — the target instant is taken, or nothing moved.
    return primary;
  }

  const other = siblingLane(lane);
  const sibling = resolve(doc, elementId, property, other);
  const siblingIndex =
    sibling == null ? -1 : indexAtTime(sibling.list, fromMs);
  if (siblingIndex < 0) {
    // No partner to bring: a lane authored before pairing, or a keyframe the
    // user made while the two lanes were still independent. Moving the one we
    // have is better than refusing the drag outright.
    return primary;
  }

  const moved = moveKeyframe(
    primary.doc,
    elementId,
    property,
    other,
    siblingIndex,
    tMs,
    sibling!.list[siblingIndex].p[1],
    bakeHz,
  );
  if (moved.doc === primary.doc) {
    // The sibling could not follow — its target instant is occupied. Letting
    // the primary move alone is exactly the desync this module exists to
    // prevent, so the whole gesture declines instead.
    return { doc, index };
  }

  return { doc: moved.doc, index: primary.index };
}

/** Remove a keyframe and the sibling that shares its instant. */
export function removeKeyframePaired(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  index: number,
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  if (!isPaired(doc, elementId, property)) {
    return removeKeyframe(doc, elementId, property, lane, index, bakeHz);
  }

  const found = resolve(doc, elementId, property, lane);
  const original = found?.list[index];
  if (original == null) {
    return doc;
  }
  const atMs = original.p[0];

  const primary = removeKeyframe(
    doc,
    elementId,
    property,
    lane,
    index,
    bakeHz,
  );
  if (primary === doc) {
    return doc;
  }

  const other = siblingLane(lane);
  const sibling = resolve(doc, elementId, property, other);
  const siblingIndex = sibling == null ? -1 : indexAtTime(sibling.list, atMs);
  if (siblingIndex < 0) {
    return primary;
  }
  return removeKeyframe(
    primary,
    elementId,
    property,
    other,
    siblingIndex,
    bakeHz,
  );
}

/**
 * The element's own static value for a property, used to seed a track.
 *
 * Scale is stored in tenths — `renderElement` divides by 10 — so an unscaled
 * element seeds at 10, not 1. That constant is otherwise only visible as a bare
 * `interpolate(10, ...)` in the renderer.
 *
 * The mask's five read through `maskOf` rather than off `element.mask`
 * directly, and that is not defensiveness for its own sake: this value is
 * planted into a keyframe and then baked, so a `NaN` reaching it from a
 * hand-edited project would not throw — it would sit in a baked lane and put
 * the mask off-canvas at every frame after the one the user seeded. The read
 * guard resolves every field to a usable number, which is exactly its job.
 *
 * A mask property on a clip with no mask cannot reach here at all:
 * `animatableProperties` omits them, and `resolve` and `setTrackActive` both
 * gate on it.
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
    // Pixels, straight off the box — `size` is the sidebar's two Size fields
    // animated, so seeding from anything else would move the clip the instant
    // the stopwatch was clicked. Unlike `scale` there is no unit conversion:
    // what is stored is what the renderer draws at.
    case "size":
      return (lane === "x" ? any.width : any.height) ?? 0;
    case "maskPosition": {
      const mask = maskOf(element);
      const location = mask?.location ?? DEFAULT_MASK_LOCATION;
      return lane === "x" ? location.x : location.y;
    }
    case "maskSize": {
      const size = maskOf(element)?.size ?? DEFAULT_MASK_SIZE;
      return lane === "x" ? size.width : size.height;
    }
    case "maskRotation":
      return maskOf(element)?.rotation ?? DEFAULT_MASK_ROTATION;
    case "maskFeather":
      return maskOf(element)?.feather ?? DEFAULT_MASK_FEATHER;
    case "maskRoundness":
      return maskOf(element)?.roundness ?? DEFAULT_MASK_ROUNDNESS;
    // Seeded from what the clip is showing right now, which for a reveal
    // nobody has keyed is the whole text. Clicking the stopwatch therefore
    // plants "fully revealed" and changes nothing until a second keyframe
    // says otherwise — the same rule `size` states above.
    case "revealProgress":
      return revealOf(element)?.progress ?? DEFAULT_REVEAL_PROGRESS;
  }
}

/**
 * Add, remove or arm — whichever the playhead's frame calls for.
 *
 * The one op behind the sidebar's keyframe diamond, and the reason the diamond
 * can be a single control. Three states, three answers:
 *
 * | at the playhead        | what happens                                    |
 * |------------------------|-------------------------------------------------|
 * | not armed              | arm, seeding one keyframe here from the static  |
 * |                        | value                                           |
 * | armed, no key here     | add one carrying the value the clip is *already*|
 * |                        | showing, so the picture does not move           |
 * | armed, a key here      | remove it — and if that was the last, disarm and|
 * |                        | adopt its value as the static one               |
 *
 * `cursorMs` is an absolute timeline time, not the element-local ms every other
 * op in this file takes. Deriving it here rather than at the call site is
 * deliberate: the frame comparison needs the element anyway, and the panels have
 * each been writing `cursor - startTime` by hand with no clamp — which is how
 * arming a property with the playhead off the clip seeded a keyframe at a
 * negative time. `inSpan` is now the guard, and it declines.
 */
export function toggleKeyframe(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  cursorMs: number,
  fps: number,
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const found = resolve(doc, elementId, property, "x");
  if (found == null) {
    return doc;
  }

  const nav = keyframeNavAt(found.element, property, cursorMs, fps);
  if (!nav.inSpan) {
    // A keyframe outside the clip never plays. Refusing beats reporting success
    // for an edit with no visible effect.
    return doc;
  }

  const atMs = cursorMs - (found.element as any).startTime;
  const lanes = lanesOf(property);

  if (nav.mark !== "on") {
    // "off" and "empty" are the same job — *make sure there is a keyframe here*
    // — and they are one path rather than two because a track can be both:
    // switched off while still holding the curve the user drew, which is what
    // `setTrackActive` preserves on the way out. Arming that one seeds nothing
    // (it only fills empty lanes), so an `else if` would have left the click
    // with no keyframe to show for itself: the diamond stays hollow and the
    // clip jumps to wherever the old curve is.
    let next = doc;
    if (nav.mark === "off") {
      next = setTrackActive(doc, elementId, property, true, { atMs }, bakeHz);
    }

    for (const lane of lanes) {
      const laneFound = resolve(next, elementId, property, lane);
      if (laneFound == null) {
        continue;
      }
      // **Planted, not added.** `addToList` seats fresh ±100ms handles, which
      // re-shapes the curve on both sides of the new point — so dropping a
      // diamond mid-animation would silently change the motion either side of
      // it. `plantKeyframe` subdivides the existing segment exactly (de
      // Casteljau), so the curve is bit-for-bit the one that was there and the
      // user simply gains a point to grab. Outside the authored range it
      // appends the held end value, which is equally what was playing there.
      //
      // The empty-lane fallback is for a project authored before paired lanes
      // existed, where `x` can carry a curve and `y` nothing: there is no curve
      // to preserve, so the static value is what the renderer was showing.
      const planted =
        laneFound.list.length === 0
          ? addToList(
              laneFound.list,
              atMs,
              staticValueOf(laneFound.element, property, lane),
            )
          : plantKeyframe(laneFound.list, atMs);
      if (planted === laneFound.list) {
        continue;
      }
      next = withLane(next, elementId, property, lane, planted, bakeHz);
    }
    return next;
  }

  // `on`. The stored time is exact — `keyframeNavAt` reports the keyframe's own
  // `p[0]`, not the snapped playhead — so `indexAtTime`'s `===` is the right
  // lookup even for a keyframe the curve editor's Alt put off the frame grid.
  const target = nav.atMs;
  if (target == null) {
    return doc;
  }

  // Which lane actually carries it. Normally both do; a project authored before
  // `addKeyframePaired` existed can have it on one.
  let primary: Lane | null = null;
  let index = -1;
  const removed: Array<{ lane: Lane; value: number }> = [];
  for (const lane of lanes) {
    const laneFound = resolve(doc, elementId, property, lane);
    if (laneFound == null) {
      continue;
    }
    const at = indexAtTime(laneFound.list, target);
    if (at < 0) {
      continue;
    }
    removed.push({ lane, value: laneFound.list[at].p[1] });
    if (primary == null) {
      primary = lane;
      index = at;
    }
  }
  if (primary == null) {
    return doc;
  }

  const removedDoc = removeKeyframePaired(
    doc,
    elementId,
    property,
    primary,
    index,
    bakeHz,
  );
  if (removedDoc === doc) {
    return doc;
  }

  if (isTrackLive(removedDoc.elements[elementId], property)) {
    return removedDoc;
  }

  // That was the last one. Switch the track off and put the value it was
  // holding into the field the renderer now falls back to.
  let next = setTrackActive(
    removedDoc,
    elementId,
    property,
    false,
    undefined,
    bakeHz,
  );
  for (const { lane, value } of removed) {
    next = withStaticValue(next, elementId, property, lane, value);
  }
  return next;
}

/**
 * Write one lane's value back into the static field it keyframes.
 *
 * The exact inverse of `staticValueOf`, and it exists for one moment: the
 * removal of a property's **last** keyframe. `sampleBaked` on an empty lane
 * falls back to the static field, so without this the picture jumps to whatever
 * that field happened to hold — and for a `position` authored by dragging on the
 * preview it holds the *pre-drag* location, because that path writes keyframes
 * and not `location`.
 *
 * It is the symmetric half of `setTrackActive`'s seed, which exists so that
 * "the first thing the user does after enabling animation is not 'watch the
 * element jump'". Disabling it deserves the same.
 *
 * Mask and reveal go through their own ops rather than `setIn`, so the write
 * passes the validation `coerceMask` does — the read/write split those modules
 * are built around. `scale` is the one property with no static field at all
 * (an unscaled element is one whose scale track is off), so it declines; no
 * panel offers a scale diamond, so that branch is unreachable today and says so
 * rather than inventing a field.
 */
function withStaticValue(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: Lane,
  value: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null || !Number.isFinite(value)) {
    return doc;
  }

  // `setIn` allocates unconditionally — it has no decline-by-identity — so the
  // guard is here. The mask and reveal ops below already compare before writing.
  if (staticValueOf(element, property, lane) === value) {
    return doc;
  }

  const put = (path: string[]) => ({
    ...doc,
    elements: { ...doc.elements, [elementId]: setIn(element, path, value) },
  });

  switch (property) {
    case "position":
      // `setIn` walks the path, so it clones `location` and touches one axis —
      // the sibling is preserved without being read.
      return put(["location", lane === "x" ? "x" : "y"]);
    case "opacity":
      return put(["opacity"]);
    case "rotation":
      return put(["rotation"]);
    case "size":
      return put([lane === "x" ? "width" : "height"]);
    case "scale":
      return doc;

    case "maskPosition": {
      const at = maskOf(element)?.location ?? DEFAULT_MASK_LOCATION;
      return setClipMaskFields(doc, elementId, {
        location: { ...at, [lane === "x" ? "x" : "y"]: value },
      });
    }
    case "maskSize": {
      const size = maskOf(element)?.size ?? DEFAULT_MASK_SIZE;
      return setClipMaskFields(doc, elementId, {
        size: { ...size, [lane === "x" ? "width" : "height"]: value },
      });
    }
    case "maskRotation":
      return setClipMaskFields(doc, elementId, { rotation: value });
    case "maskFeather":
      return setClipMaskFields(doc, elementId, { feather: value });
    case "maskRoundness":
      return setClipMaskFields(doc, elementId, { roundness: value });

    case "revealProgress":
      return setClipTextRevealFields(doc, elementId, { progress: value });
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
  bakeHz: number = BAKE_HZ,
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
        nextTrack[bakedKeyOf(lane)] = bakeTrack(seeded, bakeHz);
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
 * The properties a clip animates that are its own — the conditional families
 * excluded.
 *
 * `animatableProperties` is a function of the element's *state*: a masked clip
 * offers five more, and a text clip with a reveal one more again. Both of those
 * belong to the thing that created them rather than to the clip's movement, so
 * this is where the two questions are separated rather than at each call site.
 */
function ownAnimatableProperties(element: TimelineElement): AnimatableProperty[] {
  return animatableProperties(element).filter(
    (property) => !isConditionalTrack(property),
  );
}

/**
 * Whether this clip carries any animation of its own.
 *
 * The exact condition `clearAnimation` declines on, written once so the two
 * cannot drift: the "None" tile in the preset grid highlights on this, and it
 * would be a lie the moment it disagreed with what the tile does.
 *
 * Mask tracks do not count, for the reason `clearAnimation` gives.
 */
export function hasAnimation(
  element: TimelineElement | null | undefined,
): boolean {
  if (element == null || (element as any).animation == null) {
    return false;
  }
  for (const property of ownAnimatableProperties(element)) {
    const track = (element as any).animation?.[property];
    if (track == null) {
      continue;
    }
    if (track.isActivate === true) {
      return true;
    }
    for (const lane of lanesOf(property)) {
      if (Array.isArray(track[lane]) && track[lane].length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Remove every keyframe this clip has of its own, and switch the tracks off.
 *
 * This is what the preset grid's "None" tile does, and it is deliberately not
 * `setTrackActive(..., false)` in a loop: switching a track off **keeps** its
 * keyframes, which is right for a stopwatch the user may click again and wrong
 * for a tile that says the clip has no animation. Both lanes are emptied,
 * authored (`x`/`y`) and baked (`ax`/`ay`) together — the invariant this whole
 * module exists to hold.
 *
 * **The conditional tracks are left alone.** `maskPosition` and its four
 * siblings are properties of the mask, and `revealProgress` is a property of a
 * text clip's reveal, not of the clip's movement; each exists only while the
 * thing that owns it does, each is seeded and removed with it, and neither is
 * something the preset grid can write. Clearing exactly what that grid *can*
 * write is the rule that keeps the tile honest — a "None" that also stopped a
 * typewriter would be claiming to have removed something it never applied.
 *
 * Declines by identity when there was nothing to clear, so a second click on
 * "None" costs no undo step.
 */
export function clearAnimation(
  doc: TimelineDocument,
  elementId: string,
  bakeHz: number = BAKE_HZ,
): TimelineDocument {
  const element = doc.elements[elementId] as any;
  if (element == null || !hasAnimation(element)) {
    return doc;
  }

  const animation: any = { ...element.animation };
  for (const property of ownAnimatableProperties(element)) {
    const track = animation[property];
    if (track == null || typeof track !== "object") {
      continue;
    }
    const next: any = { ...track, isActivate: false };
    for (const lane of lanesOf(property)) {
      next[lane] = [];
      // Baked from the now-empty list rather than assigned `[]` directly, so
      // there is one definition of what an empty lane bakes to.
      next[bakedKeyOf(lane)] = bakeTrack([], bakeHz);
    }
    animation[property] = next;
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: { ...element, animation } },
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


/**
 * Two baked lanes hold the same samples.
 *
 * `rebakeAnimations` has to decide whether it changed anything, and the only
 * honest answer comes from comparing the samples themselves — the arrays are
 * freshly allocated every time, so reference equality would report a change on
 * every call and cost an undo step for nothing. `Object.is` rather than `===`
 * because a `-0` slipping into a sample is a difference worth seeing.
 */
function bakedEqual(previous: unknown, next: Baked): boolean {
  if (!Array.isArray(previous) || previous.length !== next.length) {
    return false;
  }
  for (let i = 0; i < next.length; i++) {
    const a = previous[i];
    const b = next[i];
    if (!Array.isArray(a) || a.length !== b.length) {
      return false;
    }
    for (let j = 0; j < b.length; j++) {
      if (!Object.is(a[j], b[j])) {
        return false;
      }
    }
  }
  return true;
}

/** Rebake one element's lanes, or hand it back untouched. */
function rebakeElement(element: TimelineElement, hz: number): TimelineElement {
  const animation = (element as any).animation;
  if (animation == null || typeof animation !== "object") {
    return element;
  }

  let nextAnimation: any = null;

  for (const property of animatableProperties(element)) {
    const track = animation[property];
    if (track == null || typeof track !== "object") {
      continue;
    }

    let nextTrack: any = null;
    for (const lane of lanesOf(property)) {
      // A paired property's `y` may be absent on a document authored before
      // pairing existed, and `lanesOf` describes the type rather than the data.
      if (!Array.isArray(track[lane])) {
        continue;
      }
      const baked = bakeTrack(track[lane] as Keyframe[], hz);
      if (bakedEqual(track[bakedKeyOf(lane)], baked)) {
        continue;
      }
      nextTrack ??= { ...track };
      nextTrack[bakedKeyOf(lane)] = baked;
    }

    if (nextTrack != null) {
      nextAnimation ??= { ...animation };
      nextAnimation[property] = nextTrack;
    }
  }

  return nextAnimation == null
    ? element
    : ({ ...element, animation: nextAnimation } as TimelineElement);
}

/**
 * Re-derive every baked lane at a new sample rate.
 *
 * The baked arrays are a cache of the authored curves, so this touches `ax` and
 * `ay` and never `x` or `y` — nothing the user drew moves. What changes is how
 * finely the renderer can read it, which is why the project's frame rate is
 * what decides the rate (`keyframes.ts#bakeRateFor`).
 *
 * Declines by identity, like every op here, and that is what makes it safe to
 * call from the fps setter: a project with no animation, or one already baked
 * at this rate, produces no undo step at all.
 *
 * Deliberately *not* called from `normalizeDocument`. Walking every keyframe
 * array on every checkpoint to re-derive data that was written correctly when
 * it entered is the cost `normalizeAnimations` already declined to pay. The two
 * moments a rebake is actually needed are ingress — where `patchDocument` runs
 * it — and the instant the project's frame rate changes.
 */
export function rebakeAnimations(
  doc: TimelineDocument,
  hz: number,
): TimelineDocument {
  let changed = false;
  const elements: Record<string, TimelineElement> = {};

  for (const [id, element] of Object.entries(doc.elements)) {
    const next = rebakeElement(element, hz);
    elements[id] = next;
    if (next !== element) {
      changed = true;
    }
  }

  return changed ? { ...doc, elements } : doc;
}
