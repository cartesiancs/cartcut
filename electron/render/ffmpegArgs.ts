/**
 * Pure construction of the FFmpeg argument list for the `render:v2` export.
 *
 * Video frames arrive as a PNG stream on stdin; the audio is re-derived here
 * from the timeline, one input per audible clip, delayed into place and mixed.
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

export type RenderOptions = {
  videoDuration: number;
  videoBitrate: number;
  videoDestination: string;
};

function speedOf(element: any): number {
  const speed = element?.speed;
  return typeof speed === "number" && speed > 0 ? speed : 1;
}

/** Whether a clip contributes audio to the mix. */
export function isAudible(element: any): boolean {
  if (element?.filetype === "audio") {
    return true;
  }
  if (element?.filetype === "video") {
    return (element.isExistAudio || false) === true;
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

  args.push("-f", "image2pipe", "-vcodec", "png", "-r", "60", "-i", "pipe:0");

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
    filterComplex.push(
      `anullsrc=channel_layout=stereo:sample_rate=44100:d=${options.videoDuration}[silent]`,
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
  args.push(
    "-c:a",
    "aac",
    "-c:v",
    "libx264",
    "-t",
    `${options.videoDuration}`,
    "-b:v",
    `${options.videoBitrate}k`,
    "-pix_fmt",
    "yuv420p",
    options.videoDestination,
  );

  return args;
}
