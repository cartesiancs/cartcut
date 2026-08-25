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
 * The quietest level that is still a level. Anything at or below it is silence.
 *
 * Not a linear floor: `10 ** (-60 / 20)` is 0.001, which is plainly audible on
 * a loud source. When the user pulls the fader to the bottom they mean off, so
 * `gainOf` returns a hard zero here rather than the arithmetic answer.
 */
export const MIN_VOLUME_DB = -60;

/**
 * The loudest level, and it is unity.
 *
 * No boost, because `HTMLMediaElement.volume` cannot exceed 1.0: the preview
 * would cap where the export did not, and the two would disagree without ever
 * saying so. Raising this ceiling means routing preview audio through a
 * WebAudio `GainNode` first.
 */
export const MAX_VOLUME_DB = 0;

/** What a clip that has never been touched plays at. */
export const DEFAULT_VOLUME_DB = 0;

/** Pin a level into the representable range. */
export function clampVolumeDb(db: number): number {
  if (!Number.isFinite(db)) {
    return DEFAULT_VOLUME_DB;
  }
  return Math.min(Math.max(db, MIN_VOLUME_DB), MAX_VOLUME_DB);
}

/**
 * The level this clip is authored at, in dB.
 *
 * Defaulted *and* clamped, so a field absent from an old project, a `null`
 * element mid-undo, and a hand-edited `.ngt` carrying `"-6"` or `-100` all
 * produce something the preview and the export can agree on. Reading through
 * this rather than the raw field is what keeps "no field" and "0 dB" the same
 * clip.
 */
export function volumeDbOf(
  element: TimelineElement | null | undefined,
): number {
  const db = (element as { volumeDb?: unknown } | null | undefined)?.volumeDb;
  if (typeof db !== "number") {
    return DEFAULT_VOLUME_DB;
  }
  return clampVolumeDb(db);
}

/**
 * The linear multiplier for a clip's level, 0..1.
 *
 * The renderer-side twin of `electron/render/ffmpegArgs.ts#gainOf`, kept in
 * step by `ffmpegArgs.test.ts` exactly as `isAudibleElement`/`isAudible` are.
 * If they drift, the preview and the export play at different volumes — the
 * one class of bug that is inaudible in testing and only shows up in what was
 * delivered.
 *
 * Two exact cases carry weight beyond the arithmetic:
 *
 *   - unity is exactly `1`, which is what lets `audioFilterFor` drop the
 *     `volume=` stage entirely and produce, for a project nobody has touched
 *     the faders on, byte-identical FFmpeg commands to the ones from before
 *     this field existed;
 *   - the floor is exactly `0`, per `MIN_VOLUME_DB`.
 *
 * Everything between is rounded to six decimals, and that is functional rather
 * than cosmetic. `applyIntent` writes `handle.volume` only when the value
 * changes, and it recomputes this every animation frame for every loaded clip;
 * a short, stable double makes that comparison stable. It also lets the FFmpeg
 * twin interpolate the number directly and be compared for exact equality,
 * instead of an approximate match that would wave through a real divergence.
 */
export function gainOf(element: TimelineElement | null | undefined): number {
  const db = volumeDbOf(element);
  if (db <= MIN_VOLUME_DB) {
    return 0;
  }
  if (db >= MAX_VOLUME_DB) {
    return 1;
  }
  return Number((10 ** (db / 20)).toFixed(6));
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
    // The level the user set is a property of the sound, so it travels with it.
    // `undefined` when the video was never touched, and `JSON.stringify` drops
    // an undefined field — so a detached clip stays indistinguishable from an
    // imported one in the saved project, which is the whole idea here.
    volumeDb: video.volumeDb,
    // Audio has no picture to place; `elementControl.addAudio` writes the same
    // zeroes and marks them "NOT USING".
    location: { x: 0, y: 0 },
    timelineOptions: { color: AUDIO_CLIP_COLOR },
  };
}
