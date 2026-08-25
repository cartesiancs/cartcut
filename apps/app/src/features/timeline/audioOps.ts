/**
 * Splitting a clip's audio onto a track of its own.
 *
 * The document-level half of `audio.ts`: that file decides what a detached
 * clip *is*, this one decides where it lands and what happens to the video it
 * came from. Both halves are one edit — the twin appears and the source falls
 * silent in the same document — so `withCheckpoint` records exactly one undo
 * step and a single Cmd+Z puts the project back, new track included.
 *
 * Nothing links the two clips afterwards. That is the feature, not an
 * omission: an audio clip you cannot drag away from its picture is not
 * detached, it is just drawn on another row.
 */

import type { TimelineElement } from "../../@types/timeline";
import { audioTwinOf, canDetachAudio } from "./audio";
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
