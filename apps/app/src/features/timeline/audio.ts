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
 * Silencing is the half that must not be forgotten. The preview plays every
 * audible clip and the export sums them at unity, so a detach that added a clip
 * without silencing its source would play that sound twice, 6 dB above where
 * it was. That is why `isAudibleElement` and `ffmpegArgs#isAudible` have to
 * agree, and why a test asserts they do.
 *
 * Pure and DOM-free. It imports the element types and one function, the
 * keyframe sampler, which the level envelope needs and which is itself pure.
 */

import {
  isAudibleElement,
  type AudioElementType,
  type TimelineElement,
  type VideoElementType,
} from "../../@types/timeline";
import { sampleTrack } from "../animation/keyframes";
import { withDerivedSpeed } from "./clipEdit";

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
 * Re-exported, not defined here. It moved to `@types/timeline.ts` when the
 * level gained a keyframe track, because `animatableProperties` has to ask the
 * same question and that file cannot import this one. Every existing import of
 * it keeps working, and the twin `electron/render/ffmpegArgs.ts#isAudible`
 * keeps pointing at the same function through `ffmpegArgs.test.ts`.
 */
export { isAudibleElement };

/**
 * The quietest level that is still a level. Anything at or below it is silence.
 *
 * Not a linear floor: `10 ** (-60 / 20)` is 0.001, which is plainly audible on
 * a loud source. When the user pulls the fader to the bottom they mean off, so
 * `gainOf` returns a hard zero here rather than the arithmetic answer.
 */
export const MIN_VOLUME_DB = -60;

/**
 * The loudest level. Four doublings above unity.
 *
 * This was 0 dB, and the reason was real: `HTMLMediaElement.volume` cannot
 * exceed 1.0, so the preview would have capped where the export did not and the
 * two would have disagreed without ever saying so. The note left here said that
 * raising it meant routing preview audio through a WebAudio `GainNode` first,
 * and that is what `features/asset/audioGraph.ts` now does.
 *
 * +12 rather than more because it is the range every NLE offers and because the
 * rubber band has to fit it: `levelLine.ts` maps the whole -60..+12 span onto a
 * band a few tens of pixels tall, and every decibel added above unity is taken
 * from the resolution of the range people actually work in.
 */
export const MAX_VOLUME_DB = 12;

/** Where unity sits. Exactly the level at which a clip is untouched. */
export const UNITY_VOLUME_DB = 0;

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
 * The linear multiplier for a level in dB.
 *
 * The renderer-side twin of `electron/render/ffmpegArgs.ts#gainFromDb`, kept in
 * step by `ffmpegArgs.test.ts` exactly as `isAudibleElement`/`isAudible` are.
 * If they drift, the preview and the export play at different volumes, the one
 * class of bug that is inaudible in testing and only shows up in what was
 * delivered.
 *
 * Two exact cases carry weight beyond the arithmetic:
 *
 *   - **unity is exactly `1`**, and the test is `db === 0` rather than
 *     `db >= MAX_VOLUME_DB`. It was the latter while the ceiling *was* unity,
 *     and widening the ceiling without narrowing this would have made every
 *     level from 0 dB up play at 1.0 and silently thrown the boost away. The
 *     exactness is load-bearing on its own: it lets `audioFilterFor` drop the
 *     `volume=` stage entirely, so a clip nobody has touched the fader on
 *     reaches FFmpeg with no level filter at all.
 *   - the floor is exactly `0`, per `MIN_VOLUME_DB`.
 *
 * Everything else is rounded to six decimals, and that is functional rather
 * than cosmetic. `applyIntent` writes `handle.volume` only when the value
 * changes, and it recomputes this every animation frame for every loaded clip;
 * a short, stable double makes that comparison stable. It also lets the FFmpeg
 * twin interpolate the number directly and be compared for exact equality,
 * instead of an approximate match that would wave through a real divergence.
 */
export function gainFromDb(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_VOLUME_DB) {
    return 0;
  }
  if (db === UNITY_VOLUME_DB) {
    return 1;
  }
  return Number((10 ** (db / 20)).toFixed(6));
}

/**
 * The linear multiplier for a clip's **static** level.
 *
 * Kept as its own function, and kept as the twin `ffmpegArgs.test.ts` compares,
 * because it is still the right answer everywhere there is no cursor in hand.
 * Where there is one, `gainAt` is the right answer and this one is stale by
 * however much the envelope moves.
 */
export function gainOf(element: TimelineElement | null | undefined): number {
  return gainFromDb(volumeDbOf(element));
}

/**
 * A live keyframe track, or `null`.
 *
 * The `isActivate` gate cannot be skipped, and this helper exists to make
 * forgetting it hard. `sampleTrack` answers off `ax` whenever `ax` exists, and
 * a track the user switched *off* still holds its curve, so without the gate a
 * disarmed envelope would go on playing and the fader would appear to do
 * nothing. The same helper is written out at `text/reveal.ts#activeTrack`,
 * `mask/sample.ts` and `renderer/fx/effectSample.ts`, three times on purpose.
 */
function activeTrack(element: TimelineElement, property: string): unknown {
  const track = (element as any)?.animation?.[property];
  return track != null && track.isActivate === true ? track : null;
}

/**
 * The level this clip plays at `cursorMs`, in dB.
 *
 * The contract `size` states, applied to sound: **a keyframed level behaves
 * exactly like the static field it keyframes.** The sampled value replaces
 * `volumeDb`, so `gainAt` below, the meter and the FFmpeg envelope all read one
 * number and none of them has to learn that an envelope exists.
 *
 * Clamped **at the read**, never in the curve. A curve is supposed to overshoot
 * between its keyframes the way every other curve in the app does, and clamping
 * where it is authored would destroy the shape the user can see in the editor.
 * `reveal.ts#sampledRevealProgress` and `mask/sample.ts` state the same rule.
 *
 * Deliberately **not** a field on `transform.ts#LocalSample`. That is what
 * `sampledBoxOf` answers from, and the selection outline, the eight grips, the
 * hit test and the mask's element-space mapping all read it. A level moves no
 * box, so putting it there would make five unrelated consumers carry it.
 */
export function volumeDbAt(
  element: TimelineElement | null | undefined,
  cursorMs: number,
): number {
  const fallback = volumeDbOf(element);
  if (element == null) {
    return fallback;
  }
  const track = activeTrack(element, "volumeDb");
  if (track == null) {
    return fallback;
  }
  return clampVolumeDb(
    sampleTrack(track as any, (element as any).startTime, cursorMs, fallback),
  );
}

/** The linear multiplier for a clip's level at `cursorMs`, envelope included. */
export function gainAt(
  element: TimelineElement | null | undefined,
  cursorMs: number,
): number {
  return gainFromDb(volumeDbAt(element, cursorMs));
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
  // The level envelope travels with the sound for the same reason the static
  // level does, and here it is required rather than merely tidy: after the
  // detach the video fails `isAudibleElement`, so its `volumeDb` track is an
  // orphan and `normalizeAnimation` deletes it on the next ingress. Leaving it
  // behind loses the curve silently, one save later. `detachAudio` strips it
  // from the source in the same transform.
  //
  // Cloned rather than shared: `cloneAnimation` would pull in every track, and
  // there is only ever one here.
  const envelope = (video as any).animation?.volumeDb;
  // The ramp travels with the sound for a reason nothing else here shares: a
  // twin left at the video's *mean* rate would play a straight 1.5x against a
  // picture that ramps, so the two drift apart inside the clip while starting
  // and ending together. That is lip sync going out by seconds with nothing
  // anywhere saying so. Copied rather than shared, so editing one clip's ramp
  // cannot reach the other, and `withDerivedSpeed` settles the twin's own
  // scalar rather than trusting the one copied below.
  const ramp =
    video.speedCurve == null
      ? null
      : video.speedCurve.map((point) => ({ t: point.t, v: point.v }));
  return withDerivedSpeed({
    ...(envelope != null
      ? { animation: { volumeDb: JSON.parse(JSON.stringify(envelope)) } }
      : {}),
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
    ...(ramp != null ? { speedCurve: ramp } : {}),
    // The level the user set is a property of the sound, so it travels with it.
    // `undefined` when the video was never touched, and `JSON.stringify` drops
    // an undefined field — so a detached clip stays indistinguishable from an
    // imported one in the saved project, which is the whole idea here.
    volumeDb: video.volumeDb,
    // Audio has no picture to place; `elementControl.addAudio` writes the same
    // zeroes and marks them "NOT USING".
    location: { x: 0, y: 0 },
    timelineOptions: { color: AUDIO_CLIP_COLOR },
  });
}
