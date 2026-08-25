/**
 * Which clips make a sound, and how a video's sound becomes a clip of its own.
 *
 * A video used to carry its audio as a single boolean: the `<video>` handle
 * played its own track in the preview, and the FFmpeg export added the same
 * file a second time as an audio input. Neither could be moved, cut or delayed
 * independently of the picture — so "detach audio" had nowhere to put its
 * result.
 *
 * The answer is not to extract a WAV. An `audio` element pointing at the
 * *video file* is already a complete, valid clip: `geometry` treats video and
 * audio as one `DynamicElement`, `collectAudioInputs` reads the same four
 * fields from both, and `audioPeaks` decodes video files for their waveform.
 * So detaching is a pure rename of where the sound lives — no disk, no ffmpeg,
 * no wait — and the video is silenced by a flag rather than by losing anything.
 *
 * Silencing is the half that must not be forgotten. `buildFFmpegArgs` mixes
 * with `amix`, whose default `normalize=1` divides the output by the number of
 * inputs, so a detach that added a clip without silencing its source would not
 * merely double that clip — it would quietly halve every other clip in the
 * project. Keeping the audible count constant is the whole reason
 * `isAudibleElement` and `ffmpegArgs#isAudible` have to agree, and why a test
 * asserts they do.
 *
 * Pure and DOM-free; this module imports nothing but the element types.
 */

import type {
  AudioElementType,
  TimelineElement,
  VideoElementType,
} from "../../@types/timeline";

/**
 * The colour a detached clip gets on the timeline.
 *
 * The same green `elementControl.addAudio` gives an imported audio file, so a
 * detached clip is indistinguishable from one the user dragged in — which is
 * the point: after the split it *is* just an audio clip.
 */
export const AUDIO_CLIP_COLOR = "rgb(133, 179, 59)";

/**
 * Whether this clip contributes sound.
 *
 * The renderer-side twin of `electron/render/ffmpegArgs.ts#isAudible`. The two
 * cannot be one function — `electron/` may not import from `apps/app/src`
 * without moving the whole main-process build — so they are kept in step by
 * `ffmpegArgs.test.ts`, which imports both and asserts they agree. If they ever
 * drift, the preview and the export make different sounds.
 */
export function isAudibleElement(element: TimelineElement): boolean {
  if (element == null) {
    return false;
  }
  if (element.filetype === "audio") {
    return true;
  }
  if (element.filetype === "video") {
    return element.isExistAudio === true && element.audioDetached !== true;
  }
  return false;
}

/**
 * Whether "detach audio" has anything to do to this clip.
 *
 * Three ways to have nothing to do: it is not a video, its source file carries
 * no audio stream at all, or its audio has already been detached. Each is a
 * reason to leave the document untouched rather than to record an undo step —
 * and, in the UI, a reason not to offer the menu item in the first place.
 */
export function canDetachAudio(
  element: TimelineElement | undefined | null,
): element is VideoElementType {
  return (
    element != null &&
    element.filetype === "video" &&
    element.isExistAudio === true &&
    element.audioDetached !== true
  );
}

/**
 * The audio clip that carries `video`'s sound.
 *
 * Every field that decides *when* the clip plays — `startTime`, `duration`,
 * `trim`, `sourceDuration`, `speed` — is copied verbatim, so the twin occupies
 * exactly `spanOf(video)` and satisfies `duration === trim.endTime -
 * trim.startTime` by construction. `localpath` and `blob` point at the same
 * file, which is what makes this free: the waveform cache, the `Audio()` handle
 * and the FFmpeg input all resolve it the way they already do.
 *
 * `trackId` and `priority` are placeholders. `placeNewElement` chooses the row
 * and `normalizeDocument` derives the rank; this function does not know about
 * either, which is what keeps it testable on its own.
 *
 * `parentId` is deliberately *not* carried over. It is a spatial transform
 * parent, and an audio element has no `location` worth transforming — so the
 * link would name a group that could never mean anything to this clip.
 */
export function audioTwinOf(video: VideoElementType): AudioElementType {
  return {
    filetype: "audio",
    key: video.key,
    localpath: video.localpath,
    blob: video.blob,
    trackId: video.trackId,
    priority: video.priority,
    startTime: video.startTime,
    duration: video.duration,
    trim: { startTime: video.trim.startTime, endTime: video.trim.endTime },
    sourceDuration: video.sourceDuration,
    speed: video.speed,
    // Audio has no picture to place; `elementControl.addAudio` writes the same
    // zeroes and marks them "NOT USING".
    location: { x: 0, y: 0 },
    timelineOptions: { color: AUDIO_CLIP_COLOR },
  };
}
