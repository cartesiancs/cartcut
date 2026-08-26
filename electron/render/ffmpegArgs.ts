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
   * Linear output gain, 0..1 — a multiplier, not the element's `volumeDb`.
   * `1` means no attenuation and emits no filter stage at all.
   */
  gain: number;
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
 * `audioDetached` is what keeps a detach from getting louder. The mix below is
 * `amix`, whose default `normalize=1` divides by its input count, so a video
 * left audible alongside the audio clip that now carries its sound would both
 * double that clip and pull down every other clip in the project.
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
  if (db <= MIN_VOLUME_DB) {
    return 0;
  }
  if (db >= 0) {
    return 1;
  }
  return Number((10 ** (db / 20)).toFixed(6));
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
 * Formats one clip's audio chain: level, then tempo correction, then placement.
 *
 * `volume` is a per-sample scalar multiply, so it commutes with both `atempo`
 * and `adelay` and the rendered samples are the same wherever it sits. It goes
 * first because `adelay` pads with silence — scaling that padding is work spent
 * on nothing, potentially minutes of it for a clip late in a long timeline —
 * and because it keeps the chain reading in the order this file already holds:
 * source-domain work before timeline placement. How loud, then how fast, then
 * where.
 *
 * The stage is omitted entirely at unity, which is what makes a project nobody
 * has touched the faders on produce the exact command it produced before this
 * field existed.
 */
export function audioFilterFor(input: AudioInput, streamIndex: number, label: string): string {
  const stages: string[] = [];
  // A gain that is missing or not a number reads as unity rather than being
  // interpolated: `volume=undefined` is not a command FFmpeg will run, and
  // failing the whole export over an absent field is a far worse answer than
  // playing the clip at the level it already had.
  if (Number.isFinite(input.gain) && input.gain !== 1) {
    stages.push(`volume=${input.gain}`);
  }
  stages.push(
    ...atempoChain(input.speed).map(
      (factor) => `atempo=${Number(factor.toFixed(6))}`,
    ),
  );
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
 * A clip turned all the way down stays in this list. Dropping it would shrink
 * `amix=inputs=N`, and `amix` normalises by its declared input count — so
 * pulling one fader to the bottom would make every *other* clip in the project
 * louder. Audibility ("am I an input") and gain ("how loud") are kept strictly
 * apart, for the same reason `audioDetached` exists.
 */
export function collectAudioInputs(timeline: Record<string, any>): AudioInput[] {
  const inputs: AudioInput[] = [];

  for (const key in timeline) {
    if (!Object.prototype.hasOwnProperty.call(timeline, key)) {
      continue;
    }
    const element = timeline[key];
    if (!isAudible(element)) {
      continue;
    }

    inputs.push({
      localpath: element.localpath,
      ssSec: element.trim.startTime / 1000,
      tSec: element.duration / 1000,
      delayMs: Math.max(0, element.startTime),
      speed: speedOf(element),
      gain: gainOf(element),
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

/** The complete argument vector for the export process. */
export function buildFFmpegArgs(
  options: RenderOptions,
  timeline: Record<string, any>,
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

  const inputs = collectAudioInputs(timeline);

  inputs.forEach((input, index) => {
    args.push("-ss", `${input.ssSec}`);
    args.push("-t", `${input.tSec}`);
    args.push("-i", input.localpath);

    const label = `audio${index}`;
    // Stream 0 is the PNG pipe, so clip inputs start at 1.
    filterComplex.push(audioFilterFor(input, index + 1, label));
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
    filterComplex.push(
      `${mapAudio.join("")}amix=inputs=${mapAudio.length}[aout]`,
    );
  } else {
    filterComplex.push(`${mapAudio[0]}aresample=async=1[aout]`);
  }

  args.push("-filter_complex", filterComplex.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push(...videoOutputArgs(settings));
  args.push(...audioOutputArgs(settings));
  args.push("-t", `${options.videoDuration}`);
  args.push(...containerOutputArgs(settings));
  args.push(options.videoDestination);

  return args;
}
