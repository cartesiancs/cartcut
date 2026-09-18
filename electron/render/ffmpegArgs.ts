/**
 * Pure construction of the FFmpeg argument list for the `render:v2` export.
 *
 * Video frames arrive on stdin as raw RGBA; the audio is re-derived here from
 * the timeline, one input per audible clip, delayed into place and mixed.
 *
 * The frame pipe used to carry PNG. Deflating a 1080p frame cost ~120 ms of
 * CPU only for FFmpeg to inflate it again two milliseconds later — about 60%
 * of export wall time — against ~3.6 ms for the raw round trip. `"png"` is
 * still reachable through `frameFormat` as a fallback, and its argument shape
 * is pinned by tests.
 *
 * This file is deliberately self-contained — importing
 * `apps/app/src/features/timeline/geometry.ts` would pull the renderer tree
 * into the Electron `tsc` build and move every emitted file. The three formulas
 * below are the same ones `geometry.ffmpegWindow` states, and
 * `ffmpegArgs.test.ts` imports both sides and asserts they agree, so the pair
 * cannot drift apart silently.
 *
 * Two bugs are fixed relative to the version this replaces:
 *
 *   - `-ss` was `trim.startTime * speed` and `adelay` was
 *     `startTime + trim.startTime`. Under the source-window model `trim` is
 *     already in source ms, so scaling it seeks to the wrong frame, and adding
 *     it to the delay pushed exported audio late by the trim amount.
 *   - `speed` never reached the audio graph at all, so a clip played at 2x
 *     exported with its audio at the original length, drifting further out of
 *     sync with every second.
 */

import { fileURLToPath } from "url";

import {
  type ExportSettings,
  audioOutputArgs,
  containerOutputArgs,
  resolveExportSettings,
  videoOutputArgs,
} from "./exportSettings";
import {
  envelopeFor,
  gainFromDb,
  volumeExprOf,
  type EnvelopePoint,
} from "./audioEnvelope";

/** One audible clip, reduced to what FFmpeg needs. */
export type AudioInput = {
  localpath: string;
  /** Source seek, in seconds. */
  ssSec: number;
  /** How much source to take, in seconds. */
  tSec: number;
  /** Where the clip lands on the output timeline, in whole ms. */
  delayMs: number;
  /** Playback rate; 1 means no tempo adjustment. */
  speed: number;
  /**
   * Linear output gain, a multiplier and not the element's `volumeDb`.
   * `1` means no attenuation and emits no filter stage at all.
   *
   * The clip's **static** level. When `envelope` is set this is the fallback
   * the envelope was drawn over, not what the clip plays at any given instant.
   */
  gain: number;
  /**
   * The clip's level envelope, in clip-local timeline ms, or absent.
   *
   * Absent is the overwhelmingly common case and the one that must cost
   * nothing: a clip with no envelope emits exactly the chain it emitted before
   * this field existed.
   */
  envelope?: EnvelopePoint[];
  /**
   * A file holding this clip's sound **already retimed** to the timeline, for a
   * clip carrying a speed ramp. Absent on every clip playing at a constant rate.
   *
   * FFmpeg cannot vary `atempo` over a clip (`speedStretch.ts` records the
   * measurement), so a ramp's audio is stretched before the spawn and arrives
   * as an ordinary 1x input. It covers exactly the clip's window, so it takes
   * no `-ss`, no `-t` and no tempo stage.
   */
  rendered?: { path: string; sampleRate: number; channels: 1 | 2 };
};

/** How the renderer serialises each frame onto stdin. */
export type FramePipeFormat = "rawvideo" | "png";

export const DEFAULT_FRAME_FORMAT: FramePipeFormat = "rawvideo";

export type RenderOptions = {
  videoDuration: number;
  /** Legacy mirror of `exportSettings.videoBitrate`; see `resolveExportSettings`. */
  videoBitrate: number;
  videoDestination: string;
  /** Absent on the HTTP/offscreen path, which still builds the flat shape. */
  exportSettings?: Partial<ExportSettings>;
  /** Absent on the legacy path, where the pipe rate falls back to 60. */
  fps?: number;
  /**
   * Frame size, required by `rawvideo`, which carries no dimensions of its
   * own. Absent only on legacy callers, which are pinned to `"png"`.
   */
  previewSize?: { w: number; h: number };
  /** Defaults to `rawvideo`; `png` keeps the pre-existing pipe shape. */
  frameFormat?: FramePipeFormat;
};

/**
 * Which pipe format a set of options actually resolves to.
 *
 * `rawvideo` needs `-s WxH` and FFmpeg errors out with "Video size not set"
 * without it, so options that carry no `previewSize` — the legacy and
 * HTTP/offscreen shapes — fall back to PNG rather than producing a command
 * that cannot run.
 */
export function frameFormatFor(options: RenderOptions): FramePipeFormat {
  const requested = options.frameFormat ?? DEFAULT_FRAME_FORMAT;
  if (requested !== "rawvideo") {
    return "png";
  }
  const size = options.previewSize;
  const usable =
    size != null &&
    Number.isFinite(size.w) &&
    Number.isFinite(size.h) &&
    size.w > 0 &&
    size.h > 0;
  return usable ? "rawvideo" : "png";
}

/** Bytes one `rawvideo` RGBA frame must be, exactly. */
export function frameByteLength(width: number, height: number): number {
  return width * height * 4;
}

function speedOf(element: any): number {
  const speed = element?.speed;
  return typeof speed === "number" && speed > 0 ? speed : 1;
}

/**
 * Whether a clip contributes audio to the mix.
 *
 * Hand-copied from `apps/app/src/features/timeline/audio.ts#isAudibleElement`,
 * for the reason stated in this file's header: importing the renderer tree
 * here would widen `rootDir` and relocate every emitted file. `ffmpegArgs.test`
 * imports both and asserts they agree over every element shape, so the copy
 * cannot drift without a test failing.
 *
 * `audioDetached` is what keeps a detach from getting louder. The mix below sums
 * its inputs at unity, so a video left audible alongside the audio clip that now
 * carries its sound would play that sound twice, 6 dB above where it was.
 */
export function isAudible(element: any): boolean {
  if (element?.filetype === "audio") {
    return true;
  }
  if (element?.filetype === "video") {
    return (
      (element.isExistAudio || false) === true &&
      element.audioDetached !== true
    );
  }
  return false;
}

/** Below this the clip is silent outright; see the renderer twin. */
export const MIN_VOLUME_DB = -60;

/**
 * A clip's linear output gain, 0..1.
 *
 * Hand-copied from `apps/app/src/features/timeline/audio.ts#gainOf`, for the
 * reason stated in this file's header, and kept in step the same way `isAudible`
 * is: `ffmpegArgs.test` imports both and asserts they agree — exactly, not
 * approximately, which is what the six-decimal rounding is for.
 *
 * Divergence here is the worst failure mode this file has. Preview and export
 * would play at different volumes, and nothing would say so until someone
 * listened to a delivered file.
 *
 * The export emits this linear number rather than FFmpeg's `volume=-6dB` form
 * on purpose. The dB form would have JS and FFmpeg's C each do their own
 * conversion, so the agreement test could only compare *inputs*; and the
 * -60 dB hard-zero would then need special-casing on both sides independently.
 * One shared number is one decision.
 */
export function gainOf(element: any): number {
  const raw = element?.volumeDb;
  const db = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return gainFromDb(clampVolumeDb(db));
}

/**
 * The ceiling, four doublings above unity.
 *
 * It was 0 dB while the preview could only write `HTMLMediaElement.volume`,
 * which caps at 1.0. The renderer routes a boosted clip through a WebAudio
 * `GainNode` now (`features/asset/audioGraph.ts`), so the two can agree above
 * unity and this is the twin of `audio.ts#MAX_VOLUME_DB`.
 */
export const MAX_VOLUME_DB = 12;

/** Twin of `audio.ts#clampVolumeDb`. */
export function clampVolumeDb(db: number): number {
  if (!Number.isFinite(db)) {
    return 0;
  }
  return Math.min(Math.max(db, MIN_VOLUME_DB), MAX_VOLUME_DB);
}

/**
 * `atempo` only accepts a factor in [0.5, 2.0], so anything outside that has to
 * be reached by chaining. Returns the factors in application order, or an empty
 * array when the clip plays at its natural rate.
 */
export function atempoChain(speed: number): number[] {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-9) {
    return [];
  }

  const factors: number[] = [];
  let remaining = speed;

  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) {
    factors.push(remaining);
  }

  return factors;
}

/**
 * How many samples an envelope's gain is held constant for.
 *
 * `volume=eval=frame` recomputes once per audio frame and applies one scalar to
 * the whole frame, so the frame size *is* the envelope's time resolution.
 * FFmpeg's default is 1024 samples, about 21 ms at 48 kHz, which is audible as
 * stepping on a fast fade. 256 samples is 5.33 ms and is not.
 *
 * `p=0` turns off padding the last frame with zeros, which would otherwise
 * append up to 255 samples of silence to every enveloped clip.
 */
const ENVELOPE_FRAME_SAMPLES = 256;

/**
 * Maps one input onto the export's channel layout at unity, whatever it arrived as.
 *
 * Left to itself FFmpeg does this conversion with swresample's matrix, which is
 * not the preview's. Measured against the bundled ffmpeg 9.0:
 *
 *   - a mono source upmixed to stereo lands at -3.01 dB on each side
 *     (`M_SQRT1_2`), where Chromium and QuickTime copy it to both at unity;
 *   - one mono clip anywhere in the project makes `amix` negotiate **mono** for
 *     the whole mix, so every stereo clip is folded down and spread back out,
 *     and a clip with sound only on the left comes out centred and 6 dB down;
 *   - a stereo clip in a mono export comes out 3 dB *louder*, because the float
 *     downmix sums both sides at `M_SQRT1_2` instead of averaging them.
 *
 * Naming the conversion on every input takes the choice away from negotiation.
 * `pan` drops a named channel the input does not have, so the stereo form is a
 * plain channel map for a stereo source and a copy of `FC` to both sides for a
 * mono one. The mono form's `<` renormalises over the channels present: a mono
 * source passes through, a stereo one becomes the mean of its two sides.
 *
 * A surround source is outside what one expression can serve. `FC` has to be
 * unity for a mono file and 0.707 for a 5.1 one, and `pan` cannot tell them
 * apart before it sees the stream; this keeps the mono answer, so a 5.1 file
 * exports its centre at unity and drops its surrounds.
 */
export function channelStageFor(channels: 1 | 2): string {
  return channels === 1
    ? "pan=mono|FC<FL+FR+FC"
    : "pan=stereo|FL=FL+FC|FR=FR+FC";
}

/**
 * Formats one clip's audio chain: layout, level, tempo correction, placement.
 *
 * The layout stage comes first and is always present; see `channelStageFor`.
 * It is linear, so it commutes with everything after it exactly as the static
 * level does.
 *
 * A static `volume` is a per-sample scalar multiply, so it commutes with both
 * `atempo` and `adelay` and the rendered samples are the same wherever it sits.
 * It goes first because `adelay` pads with silence (scaling that padding is
 * work spent on nothing, potentially minutes of it for a clip late in a long
 * timeline) and because it keeps the chain reading in the order this file
 * already holds: source-domain work before timeline placement. How loud, then
 * how fast, then where.
 *
 * The level stage is omitted entirely at unity, so a clip nobody has touched
 * the fader on carries no `volume` filter at all.
 *
 * **An envelope does not commute, and sits after `atempo` instead.** Its
 * breakpoints are clip-local *timeline* ms, and on a clip playing at a constant
 * rate `t` only means that once `atempo` has rewritten the timestamps: measured
 * against the bundled ffmpeg, `gte(t,1)` placed after `atempo=2` switches at
 * output 1.0 s, not at 0.5 s. Putting it first would mean multiplying every
 * breakpoint by `speed` to reach source time; putting it after `adelay` would
 * mean adding the clip's timeline offset to every one. After `atempo` and
 * before `adelay` is the one position where the numbers need no conversion at
 * all.
 *
 * On a **rendered** input none of that applies and the position is right for a
 * simpler reason: there is no tempo stage, because the stream arrived already
 * in timeline time. `t` is clip-local timeline seconds directly, with no filter
 * having to establish it. A ramp could never have worked the other way round:
 * one `atempo` factor cannot express a varying rate, so before this input
 * existed a ramped clip's breakpoints would have landed at the wrong instants
 * no matter where the stage sat.
 *
 * The envelope replaces the static stage rather than joining it. The curve was
 * drawn in absolute dB, so it already carries the level; multiplying by the
 * static gain as well would apply it twice.
 */
export function audioFilterFor(
  input: AudioInput,
  streamIndex: number,
  label: string,
  channels: 1 | 2,
): string {
  const stages: string[] = [channelStageFor(channels)];
  const envelope = input.envelope;
  const hasEnvelope = envelope != null && envelope.length > 0;

  // A gain that is missing or not a number reads as unity rather than being
  // interpolated: `volume=undefined` is not a command FFmpeg will run, and
  // failing the whole export over an absent field is a far worse answer than
  // playing the clip at the level it already had.
  if (!hasEnvelope && Number.isFinite(input.gain) && input.gain !== 1) {
    stages.push(`volume=${input.gain}`);
  }
  // A rendered input is already in timeline time: the ramp was applied sample
  // by sample before the spawn, and a tempo stage on top would retime it twice.
  if (input.rendered == null) {
    stages.push(
      ...atempoChain(input.speed).map(
        (factor) => `atempo=${Number(factor.toFixed(6))}`,
      ),
    );
  }
  if (hasEnvelope) {
    stages.push(`asetnsamples=n=${ENVELOPE_FRAME_SAMPLES}:p=0`);
    stages.push(`volume=eval=frame:volume='${volumeExprOf(envelope)}'`);
  }
  const delay = Math.round(input.delayMs);
  stages.push(`adelay=${delay}|${delay}`);

  return `[${streamIndex}:a]${stages.join(",")}[${label}]`;
}

/**
 * Reduce a timeline to its audible clips.
 *
 * `-t` is in *source* seconds because `-ss` is a source seek; the timeline
 * enters only through `delayMs`. After `atempo` the stream occupies
 * `tSec / speed` seconds of output, which is the clip's timeline span.
 *
 * A clip turned all the way down stays in this list, at `volume=0`. The mix
 * sums at unity, so its presence changes no other clip's level; keeping it
 * means audibility ("am I an input") and gain ("how loud") stay separate
 * questions, and the fader position never changes the shape of the command.
 */
export function collectAudioInputs(
  timeline: Record<string, any>,
  rendered?: ReadonlyMap<string, { path: string; sampleRate: number; channels: 1 | 2 }>,
): AudioInput[] {
  const inputs: AudioInput[] = [];

  for (const key in timeline) {
    if (!Object.prototype.hasOwnProperty.call(timeline, key)) {
      continue;
    }
    const element = timeline[key];
    if (!isAudible(element)) {
      continue;
    }

    // Read once, here, rather than inside `audioFilterFor`: the reduction is
    // where the document is still in hand, and the formatter should be a pure
    // function of this record.
    const envelope = envelopeFor(element);

    // Passed in rather than read from disk here, so this function stays a pure
    // reduction of the document and its suite needs no filesystem, the same
    // reason `missingInputs` takes an `exists` predicate.
    const retimed = rendered?.get(key);

    inputs.push({
      localpath: element.localpath,
      ssSec: element.trim.startTime / 1000,
      tSec: element.duration / 1000,
      delayMs: Math.max(0, element.startTime),
      speed: speedOf(element),
      gain: gainOf(element),
      ...(envelope != null ? { envelope } : {}),
      ...(retimed != null ? { rendered: retimed } : {}),
    });
  }

  return inputs;
}

/**
 * A clip's `localpath` as a filesystem path.
 *
 * The timeline stores these as `file://` URLs — that is what the renderer needs
 * to load media — and FFmpeg happily opens either form, so the distinction
 * never mattered until something wanted to *stat* one. `fs` does not know the
 * `file:` protocol, and a URL also percent-encodes spaces and non-ASCII, both
 * of which this project's own asset folder is full of.
 */
export function localFilePath(localpath: string): string {
  if (!/^file:\/\//i.test(localpath)) {
    return localpath;
  }
  try {
    return fileURLToPath(localpath);
  } catch {
    // Malformed enough that no interpretation is safe. Handing it back
    // unchanged means the caller reports it as missing, which it is.
    return localpath;
  }
}

/**
 * Audio inputs whose files are not there, as filesystem paths.
 *
 * `exists` is a parameter so this stays pure and testable — the same reason
 * every other predicate in this file takes its data rather than fetching it.
 *
 * Worth checking up front because of how badly the alternative fails. FFmpeg
 * cannot open a missing input, so it exits during startup — but the renderer
 * has already been told the session started and draws its way through the whole
 * timeline before anything notices. What the user finally sees is "FFmpeg
 * exited with code 1", preceded by one stack trace for every frame still in
 * flight, because each queued `sendFrame` rejects against the closed pipe at
 * once. None of it names the file.
 */
export function missingInputs(
  timeline: Record<string, any>,
  exists: (path: string) => boolean,
): string[] {
  const missing = new Set<string>();

  for (const input of collectAudioInputs(timeline)) {
    if (typeof input.localpath !== "string" || input.localpath === "") {
      // An audible clip with no file at all. FFmpeg would be handed `-i ""`.
      missing.add("(no file)");
      continue;
    }
    const path = localFilePath(input.localpath);
    if (!exists(path)) {
      missing.add(path);
    }
  }

  return [...missing];
}

/**
 * How long the output is allowed to run, in seconds.
 *
 * Not `videoDuration`, which is what this used to pass straight through. The
 * renderer writes `Math.round(duration * fps)` frames — one integer count that
 * every part of the export agrees on, derived in
 * `apps/app/src/features/export/frames.ts#frameCount` — and when that rounds
 * *up*, the last frame extends past `duration`. A 10.009s project at 60fps
 * produces 601 frames, which is 10.0167s of video, and `-t 10.009` cuts the
 * final frame off. Deriving the limit from the same count makes the two agree
 * by construction at every rate.
 *
 * The expression is duplicated across the process boundary rather than
 * imported, for the reason spelled out at the top of `exportSettings.ts`:
 * importing from `apps/app/src` would widen this build's `rootDir` and relocate
 * the whole compiled output. `ffmpegArgs.test.ts` imports both sides and
 * asserts they agree.
 */
function outputDurationSec(videoDuration: number, fps: number): number {
  const duration = Number(videoDuration);
  if (!(duration > 0) || !(fps > 0)) {
    return duration;
  }
  return Math.round(duration * fps) / fps;
}

/** The complete argument vector for the export process. */
export function buildFFmpegArgs(
  options: RenderOptions,
  timeline: Record<string, any>,
  rendered?: ReadonlyMap<
    string,
    { path: string; sampleRate: number; channels: 1 | 2 }
  >,
): string[] {
  const args: string[] = [];
  const filterComplex: string[] = [];
  const mapAudio: string[] = [];

  const settings = resolveExportSettings(options);

  // `renderTimeline` already produces frames at `options.fps`, so a literal 60
  // here would time-stretch the output whenever the project runs at any other
  // rate. Legacy callers carry no fps and keep the old behaviour.
  const inputFps = Number(options.fps) > 0 ? Number(options.fps) : 60;

  if (frameFormatFor(options) === "rawvideo") {
    const { w, h } = options.previewSize!;
    args.push(
      "-f",
      "rawvideo",
      // Both must precede `-i` or they are parsed as output options.
      "-pix_fmt",
      "rgba",
      "-s",
      `${w}x${h}`,
      "-r",
      `${inputFps}`,
      // ~500 MB/s overruns the default input queue, which then stalls with
      // "Thread message queue blocking".
      "-thread_queue_size",
      "512",
      "-i",
      "pipe:0",
    );
  } else {
    args.push(
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-r",
      `${inputFps}`,
      "-i",
      "pipe:0",
    );
  }

  const inputs = collectAudioInputs(timeline, rendered);

  inputs.forEach((input, index) => {
    if (input.rendered != null) {
      // No `-ss` and no `-t`: the file is exactly the clip's window, already
      // retimed. Seeking into it would cut the ramp, and a duration would cut
      // it short.
      args.push("-i", input.rendered.path);
    } else {
      args.push("-ss", `${input.ssSec}`);
      args.push("-t", `${input.tSec}`);
      args.push("-i", input.localpath);
    }

    const label = `audio${index}`;
    // Stream 0 is the PNG pipe, so clip inputs start at 1.
    filterComplex.push(audioFilterFor(input, index + 1, label, settings.channels));
    mapAudio.push(`[${label}]`);
  });

  if (mapAudio.length === 0) {
    // The silence has to match the shape the encoder was asked for, or the
    // resampler quietly undoes the chosen rate and layout.
    const layout = settings.channels === 1 ? "mono" : "stereo";
    filterComplex.push(
      `anullsrc=channel_layout=${layout}:sample_rate=${settings.sampleRate}:d=${options.videoDuration}[silent]`,
    );
    mapAudio.push(`[silent]`);
  }

  filterComplex.push(`[0:v]null[vout]`);

  if (mapAudio.length > 1) {
    // `normalize=0` is what makes the export as loud as the preview. The
    // default divides by the number of inputs that have not ended yet, and
    // `adelay` makes a clip late on the timeline an input from 0s, so a clip
    // split into three exported its first piece 9.5 dB down and one split into
    // ten 20 dB down, recovering only as pieces ended. The preview plays each
    // clip on its own element and the speakers sum them; `lib/recordMux.ts`
    // mixes with `normalize=0` for the same reason.
    filterComplex.push(
      `${mapAudio.join("")}amix=inputs=${mapAudio.length}:normalize=0[aout]`,
    );
  } else {
    filterComplex.push(`${mapAudio[0]}aresample=async=1[aout]`);
  }

  args.push("-filter_complex", filterComplex.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push(...videoOutputArgs(settings));
  args.push(...audioOutputArgs(settings));
  // State the output rate rather than letting it be inherited from the input
  // demuxer. The pipe is exactly constant-rate — the renderer hands over one
  // frame per `1/fps` and nothing else — so saying so leaves no room for a
  // muxer or an encoder to pick a timebase of its own and retime the result.
  args.push("-r", `${inputFps}`, "-fps_mode", "cfr");
  args.push("-t", `${outputDurationSec(options.videoDuration, inputFps)}`);
  args.push(...containerOutputArgs(settings));
  args.push(options.videoDestination);

  return args;
}
