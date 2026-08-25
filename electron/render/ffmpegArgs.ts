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

/** Formats one clip's audio chain: tempo correction, then placement. */
export function audioFilterFor(input: AudioInput, streamIndex: number, label: string): string {
  const stages = atempoChain(input.speed).map(
    (factor) => `atempo=${Number(factor.toFixed(6))}`,
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
    });
  }

  return inputs;
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
