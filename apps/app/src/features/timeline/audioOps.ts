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

import type { TimelineElement } from "../../@types/timeline";
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

  // Silencing the source is not a follow-up edit — it is the other half of
  // this one. `amix` normalises by its input count, so a document where both
  // the video and its twin are audible is not merely loud, it is quieter
  // everywhere else.
  return normalizeDocument({
    ...placed,
    elements: {
      ...placed.elements,
      [elementId]: { ...video, audioDetached: true },
    },
  });
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
