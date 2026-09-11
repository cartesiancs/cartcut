/**
 * Reversing a video clip, as a pair of document edits.
 *
 * The slow half — making a file of the clip's window played backwards — is
 * `electron/lib/reverse.ts`, driven by `features/reverse/reverseSession.ts`.
 * What lives here is the instant half: pointing the clip at that file, and
 * pointing it back.
 *
 * **The clip's `localpath` is swapped for the reversed file.** That is the
 * whole design, and it is why nothing downstream needed to change: the preview
 * decodes `localpath`, the export's audio reads `-i localpath`, the filmstrip
 * and the waveform key on `localpath`, and `loadedAssetStore` drops a decoder
 * whose path changed. A `reversed: true` flag that every one of those had to
 * consult would have been six features' worth of edits, and the one anybody
 * forgot would play forwards in silence.
 *
 * The reversed file covers exactly the clip's trim window `[from, to]`, so the
 * clip becomes `trim = [0, duration]` over it and **its timeline span does not
 * change** — nothing next to it moves. The original is remembered in
 * `reversed`, and a source time `r` in the new file is `to - r` in the old one.
 * That mapping is what makes `unreverse` exact, instant, and correct after the
 * reversed clip has been split or trimmed inside its window.
 *
 * Keyframes, transitions, speed, blend, grade, mask and mirror are left alone.
 * They are all in timeline time or are properties of the picture; reversal is
 * a property of the media.
 */

import type {
  ReversedFrom,
  TimelineElement,
  VideoElementType,
} from "../../@types/timeline";
import { hasValidTrim } from "./geometry";
import type { TimelineDocument } from "./tracks";

/** What the clip looked like when its reversal was started. */
export type ReverseSnapshot = {
  localpath: string;
  trim: { startTime: number; endTime: number };
};

/** The finished reversed file, as main reports it. */
export type ReverseResult = {
  localpath: string;
  durationMs: number;
  hasAudio: boolean;
};

function isVideo(
  element: TimelineElement | undefined | null,
): element is VideoElementType {
  return element?.filetype === "video";
}

/** Whether this clip currently plays a reversed copy of its source. */
export function isReversed(
  element: TimelineElement | undefined | null,
): boolean {
  return isVideo(element) && element.reversed != null;
}

/**
 * Whether a reversal can be started on this clip: a forward video clip with a
 * sound trim window. Audio clips are deliberately excluded — the feature is
 * "reverse the video", and a clip's own sound is reversed with it.
 */
export function isReversible(
  element: TimelineElement | undefined | null,
): boolean {
  return isVideo(element) && element.reversed == null && hasValidTrim(element);
}

/** The state `applyReverse` will insist is unchanged when the file lands. */
export function reverseSnapshotOf(
  element: TimelineElement | undefined | null,
): ReverseSnapshot | null {
  if (!isReversible(element)) {
    return null;
  }
  const video = element as VideoElementType;
  return {
    localpath: video.localpath,
    trim: { startTime: video.trim.startTime, endTime: video.trim.endTime },
  };
}

/**
 * Point a clip at its reversed file.
 *
 * Declines by identity when the clip is gone, is not a forward video clip, or
 * no longer matches `expected` — a reversal takes seconds to minutes, and a
 * clip trimmed or relinked in the meantime covers a different window than the
 * file does. Applying it anyway would put the wrong footage on screen with
 * nothing to say so.
 */
export function applyReverse(
  doc: TimelineDocument,
  elementId: string,
  expected: ReverseSnapshot,
  result: ReverseResult,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isReversible(element)) {
    return doc;
  }
  const video = element as VideoElementType;
  if (
    video.localpath !== expected.localpath ||
    video.trim.startTime !== expected.trim.startTime ||
    video.trim.endTime !== expected.trim.endTime
  ) {
    return doc;
  }
  if (
    typeof result.localpath !== "string" ||
    result.localpath === "" ||
    result.localpath === video.localpath ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs <= 0
  ) {
    return doc;
  }

  const reversed: ReversedFrom = {
    localpath: video.localpath,
    from: video.trim.startTime,
    to: video.trim.endTime,
    sourceDuration: video.sourceDuration,
    isExistAudio: video.isExistAudio,
  };

  const next: VideoElementType = {
    ...video,
    localpath: result.localpath,
    // `duration` is untouched, so the span is too. The file is the window, so
    // the window within it starts at zero.
    trim: { startTime: 0, endTime: video.duration },
    // A re-encode can come back a frame short of the window it was cut from.
    // Padding the recorded length keeps the trim inside it; the decoder simply
    // holds its last frame for that final fraction of a frame.
    sourceDuration: Math.max(result.durationMs, video.duration),
    isExistAudio: result.hasAudio,
    reversed,
  };

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  };
}

/**
 * Put a reversed clip back on its forward source. No FFmpeg: `reversed` holds
 * everything needed, and the trim maps back through `to - r`.
 *
 * Declines by identity for a clip that is not reversed.
 */
export function unreverse(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isVideo(element) || element.reversed == null) {
    return doc;
  }

  const { reversed, ...rest } = element;
  const length = element.duration;

  // `to - r` for both ends, swapped because the direction is. Clamped only for
  // the case `applyReverse` padded for — a trim reaching into the fraction of
  // a frame past the window — so the duration invariant always holds.
  let startTime = Math.max(0, reversed.to - element.trim.endTime);
  let endTime = startTime + length;
  if (endTime > reversed.sourceDuration) {
    endTime = reversed.sourceDuration;
    startTime = Math.max(0, endTime - length);
  }

  const next: VideoElementType = {
    ...(rest as VideoElementType),
    localpath: reversed.localpath,
    trim: { startTime, endTime },
    sourceDuration: reversed.sourceDuration,
    isExistAudio: reversed.isExistAudio,
  };

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  };
}

/** `unreverse` over a selection, as one document. */
export function unreverseMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
): TimelineDocument {
  return elementIds.reduce(
    (accumulated, id) => unreverse(accumulated, id),
    doc,
  );
}
