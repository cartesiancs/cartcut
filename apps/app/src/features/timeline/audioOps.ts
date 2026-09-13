/**
 * Document-level edits to how a clip sounds: splitting its audio onto a track
 * of its own, and setting how loud it plays.
 *
 * The document-level half of `audio.ts`: that file decides what a detached
 * clip *is* and what a level means, this one decides where the twin lands,
 * what happens to the video it came from, and how a level reaches an element.
 * Detaching is one edit — the twin appears and the source falls silent in the
 * same document — so `withCheckpoint` records exactly one undo step and a
 * single Cmd+Z puts the project back, new track included.
 *
 * Nothing links the two clips afterwards. That is the feature, not an
 * omission: an audio clip you cannot drag away from its picture is not
 * detached, it is just drawn on another row.
 */

import {
  animatableProperties,
  type TimelineElement,
} from "../../@types/timeline";
import {
  moveKeyframe,
  plantKeyframeAt,
  removeKeyframe,
  setTrackActive,
} from "../animation/keyframeOps";
import { spanLength } from "./geometry";
import { isTrackLive } from "./keyframeMarkers";
import { setIn } from "../../utils/immutable";
import { audioTwinOf, canDetachAudio, clampVolumeDb, volumeDbOf } from "./audio";
import { placeNewElement } from "./placement";
import { normalizeDocument, type TimelineDocument } from "./tracks";

/**
 * Move `elementId`'s sound onto its own audio clip.
 *
 * Returns the document **by identity** when there is nothing to detach, so a
 * menu click on a silent clip costs the user no undo step — the same contract
 * every op in `clipOps` holds.
 *
 * The row comes from `placeNewElement`, unchanged: it reuses the bottom-most
 * audio track whose slot is free and only appends a new one when none can take
 * the clip. So detaching five clips that do not overlap in time produces one
 * audio track, not five — and the very first audio track a project gets is
 * appended below everything else, which is where an audio row belongs.
 */
export function detachAudio(
  doc: TimelineDocument,
  elementId: string,
  newElementId: string,
  newTrackId: string,
): TimelineDocument {
  const video = doc.elements[elementId];
  if (!canDetachAudio(video)) {
    return doc;
  }

  const placed = placeNewElement(
    doc,
    newElementId,
    audioTwinOf(video),
    video.startTime,
    newTrackId,
  );

  // Silencing the source is not a follow-up edit, it is the other half of this
  // one. `amix` normalises by its input count, so a document where both the
  // video and its twin are audible is not merely loud, it is quieter
  // everywhere else.
  //
  // The level envelope goes with the sound, and stripping it here is the other
  // half again. `audioTwinOf` has already copied it onto the new clip; leaving
  // the original behind would make it an orphan, because a silenced video fails
  // `isAudibleElement` and `keyframes.ts#CONDITIONAL_TRACKS` says the track
  // only exists while that is true. It would then be invisible to the curve
  // editor and to `rebakeElement` while still riding along in every save, until
  // the next ingress deleted it without telling anyone.
  return normalizeDocument({
    ...placed,
    elements: {
      ...placed.elements,
      [elementId]: silenced(video),
    },
  });
}

/**
 * The video, minus its sound and minus the curve that shaped it.
 *
 * The `animation` block is rebuilt rather than spread-and-deleted so a video
 * that never had a level envelope comes back with the block it arrived with, by
 * identity where possible. A video always carries unconditional tracks, so
 * unlike an audio clip its block is never emptied by this.
 */
function silenced(video: TimelineElement): TimelineElement {
  const next: any = { ...(video as any), audioDetached: true };
  const animation = next.animation;
  if (animation != null && "volumeDb" in animation) {
    const { volumeDb: _dropped, ...rest } = animation;
    next.animation = rest;
  }
  return next as TimelineElement;
}

/**
 * Detach every clip in `elementIds` that has audio to give, as one edit.
 *
 * Clips with nothing to detach are skipped rather than refused, so a mixed
 * selection — two videos with sound, a caption, a silent clip — does the
 * obvious thing. A selection where *nothing* can be detached leaves `doc`
 * untouched by identity.
 */
export function detachAudioFrom(
  doc: TimelineDocument,
  elementIds: string[],
  idGen: () => string,
): TimelineDocument {
  let next = doc;
  for (const elementId of elementIds) {
    // Only spend ids on clips that will actually use them, so a mixed
    // selection does not leave gaps in whatever the generator counts.
    if (!canDetachAudio(next.elements[elementId] as TimelineElement)) {
      continue;
    }
    next = detachAudio(next, elementId, idGen(), idGen());
  }
  return next;
}

/**
 * Set how loud a clip plays, in dB.
 *
 * Returns the document **by identity** when the clip already sits at that
 * level, which matters more here than for most ops: `number-input` fires on
 * every mousemove, so a scrub that wanders back across its starting value
 * would otherwise record a step for standing still. `GestureCommit` reads the
 * identity to mean "nothing happened" and commits nothing.
 *
 * The comparison is against `volumeDbOf`, not the raw field. A clip with no
 * `volumeDb` *is* at 0 dB, so setting it to 0 has to decline rather than stamp
 * a redundant `volumeDb: 0` onto every clip the user clicks — which would grow
 * the saved project and make "untouched" unrepresentable.
 *
 * A clip whose level is **keyframed** still has this static field, and setting
 * it still means something: it is the value the envelope falls back to before
 * the track's first sample and wherever the track is switched off. It is not
 * what the clip plays at a cursor while the track is live, which is
 * `audio.ts#volumeDbAt`. `withStaticValue` calls through here for exactly that
 * reason, when the last keyframe of an envelope is removed.
 *
 * The clamp lives here rather than in the panel because `number-input` ignores
 * `min`/`max` entirely — the `max="100"` on the opacity field has never done
 * anything — so clamping at the one place every caller passes through is what
 * actually keeps the store in range, whether the value came from a drag, from
 * a typed number, or from `update_clip`.
 */
export function setVolumeDb(
  doc: TimelineDocument,
  elementId: string,
  db: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }
  // Only clips that make a sound have a level to set. A text clip with a
  // `volumeDb` would be a field nothing reads.
  if (element.filetype !== "audio" && element.filetype !== "video") {
    return doc;
  }
  if (!Number.isFinite(db)) {
    return doc;
  }

  const next = clampVolumeDb(db);
  if (volumeDbOf(element) === next) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: setIn(element, ["volumeDb"], next),
    },
  };
}

/**
 * Shift a clip's whole level envelope by `deltaDb`.
 *
 * What dragging the rubber band does on a clip that already has keyframes: the
 * shape the user drew is theirs, and a drag on the line means "all of it,
 * louder", not "flatten it to here". Premiere, Resolve and Final Cut all read
 * it that way.
 *
 * On a clip with **no** envelope this declines, by identity. The caller wants
 * `setVolumeDb` there, and quietly arming a track instead would turn a drag on
 * an ordinary clip into a keyframe nobody asked for.
 *
 * Each keyframe is clamped on its own, so a curve dragged into the ceiling
 * flattens against it rather than being refused. That is what a fader does and
 * it is recoverable: dragging back down restores the shape of everything that
 * did not hit the stop, which is the part the user can still see.
 */
export function offsetLevelEnvelope(
  doc: TimelineDocument,
  elementId: string,
  deltaDb: number,
  bakeHz?: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null || !Number.isFinite(deltaDb) || deltaDb === 0) {
    return doc;
  }
  const track = (element as any).animation?.volumeDb;
  if (track == null || track.isActivate !== true || !Array.isArray(track.x)) {
    return doc;
  }

  let next = doc;
  for (let index = 0; index < track.x.length; index++) {
    const keyframe = track.x[index];
    const tMs = keyframe?.p?.[0];
    const db = keyframe?.p?.[1];
    if (typeof tMs !== "number" || typeof db !== "number") {
      continue;
    }
    const moved = clampVolumeDb(db + deltaDb);
    if (moved === db) {
      continue;
    }
    // Through `moveKeyframe` rather than by rewriting `p`, so the baked lane is
    // re-baked in the same transform. The API this replaced left baking to the
    // caller and the delete path forgot it.
    next = moveKeyframe(next, elementId, "volumeDb", "x", index, tMs, moved, bakeHz)
      .doc;
  }
  return next;
}

/**
 * Move one level keyframe to a new time and level.
 *
 * Times are element-local timeline ms and are **not** snapped to the frame
 * grid. `frames.ts#isFrameLocked` exempts audio from it because frame alignment
 * is a picture constraint: an edge between two frame instants shows one frame
 * of whatever is behind it, and sound has no frames. A gain change is heard at
 * the instant it happens, so quantizing it would move the fade off the word it
 * was drawn against. The curve editor's `dragKeyframe.ts` does not know the
 * frame rate either, so both ways in agree.
 */
export function moveLevelKeyframe(
  doc: TimelineDocument,
  elementId: string,
  index: number,
  tMs: number,
  db: number,
  bakeHz?: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null || !Number.isFinite(tMs) || !Number.isFinite(db)) {
    return doc;
  }
  // Inside the clip, for the reason `toggleKeyframe` clamps: a keyframe past
  // the end never plays, so letting a drag put one there reports success for an
  // edit with no audible effect.
  const span = spanLength(element);
  const at = Math.min(Math.max(tMs, 0), span);
  return moveKeyframe(
    doc,
    elementId,
    "volumeDb",
    "x",
    index,
    at,
    clampVolumeDb(db),
    bakeHz,
  ).doc;
}

/**
 * Put a level keyframe on the curve at `tMs`, arming the track if need be.
 *
 * **Planted, not added**, when the track is already live: `plantKeyframe`
 * subdivides the curve exactly, so dropping a point into the middle of a fade
 * cannot re-shape the parts either side of it. That is what an editor means by
 * adding a point to a rubber band, and it is what `toggleKeyframe` does for
 * every other property.
 *
 * On a track that is off, arming seeds a keyframe at `tMs` from the static
 * level and there is nothing to preserve, so the seed *is* the new point.
 */
export function addLevelKeyframe(
  doc: TimelineDocument,
  elementId: string,
  tMs: number,
  bakeHz?: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null || !Number.isFinite(tMs)) {
    return doc;
  }
  if (!animatableProperties(element).includes("volumeDb")) {
    return doc;
  }

  const span = spanLength(element);
  const at = Math.min(Math.max(tMs, 0), span);
  const track = (element as any).animation?.volumeDb;
  const live = track != null && track.isActivate === true;

  if (!live) {
    return setTrackActive(doc, elementId, "volumeDb", true, { atMs: at }, bakeHz);
  }
  return plantKeyframeAt(doc, elementId, "volumeDb", "x", at, bakeHz);
}

/**
 * Remove one level keyframe, and disarm the track when it was the last.
 *
 * Disarming writes the removed value back as the static level, which is
 * `toggleKeyframe`'s rule: without it the clip jumps to whatever `volumeDb`
 * happened to hold before the envelope was drawn, which for a clip that was
 * only ever keyframed is 0 dB, so deleting the last point of a fade-out would
 * make it suddenly loud.
 */
export function removeLevelKeyframe(
  doc: TimelineDocument,
  elementId: string,
  index: number,
  bakeHz?: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  const track = (element as any)?.animation?.volumeDb;
  if (track == null || !Array.isArray(track.x) || track.x[index] == null) {
    return doc;
  }
  const held = track.x[index]?.p?.[1];
  const next = removeKeyframe(doc, elementId, "volumeDb", "x", index, bakeHz);
  if (next === doc) {
    return doc;
  }
  if (isTrackLive(next.elements[elementId], "volumeDb")) {
    return next;
  }
  const settled =
    typeof held === "number"
      ? setVolumeDb(next, elementId, clampVolumeDb(held))
      : next;
  return setTrackActive(settled, elementId, "volumeDb", false, undefined, bakeHz);
}
