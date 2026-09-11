/**
 * The FFmpeg arguments for reversing a window of a video, and how big a bite
 * to take at a time. Pure — no spawn, no Electron — so the suite can pin it.
 *
 * **Why in chunks.** FFmpeg's `reverse` filter holds every frame of its input
 * in memory before it can emit the first one. The footage this app is used on
 * is 3600x2338 at 120fps: 12.6MB a frame decoded, **1.5GB a second**. Reversing
 * a ten-second window in one pass asks for fifteen gigabytes. So the window is
 * cut into chunks sized to a memory budget, each chunk is reversed on its own,
 * and the reversed chunks are joined last-first — the standard way round, and
 * bounded by the budget whatever the clip's length.
 *
 * The cut is one decode through the `segment` muxer, with a keyframe forced at
 * every boundary, rather than one `-ss`/`-t` seek per chunk. Seeking N times
 * would decide each boundary N times, independently, and a frame on a boundary
 * could land in both chunks or in neither — a stutter at every join that no
 * single frame of the output would reveal.
 *
 * libx264 throughout, not `h264_videotoolbox`: VideoToolbox refuses this
 * machine's own 3600x2338 whatever the level tables say (see the recorder notes
 * in CLAUDE.md), and a reversal that fails on exactly the footage it is most
 * needed for is not worth the speed.
 */

/** Bump to invalidate every cached reversal, e.g. when the encode changes. */
export const RECIPE_VERSION = 1;

/** Decoded frames the `reverse` filter may hold at once, in bytes. */
export const FRAME_BUDGET_BYTES = 512 * 1024 * 1024;

export const MIN_CHUNK_SEC = 0.25;
export const MAX_CHUNK_SEC = 10;

/** Frame rates the output is clocked at — the project's own range. */
const MIN_FPS = 1;
const MAX_FPS = 240;

export type ReverseStage = "split" | "reverse" | "audio" | "join";

/**
 * How many seconds of this picture fit in the budget once decoded.
 *
 * yuv420p is 1.5 bytes a pixel. 3600x2338@120 gives about a third of a
 * second; 1080p30 about five and a half.
 */
export function chunkSecondsFor(
  width: number,
  height: number,
  fps: number,
  budgetBytes = FRAME_BUDGET_BYTES,
): number {
  const frameBytes = Math.max(1, width) * Math.max(1, height) * 1.5;
  const rate = fps > 0 ? fps : 30;
  const seconds = budgetBytes / (frameBytes * rate);
  return Math.min(MAX_CHUNK_SEC, Math.max(MIN_CHUNK_SEC, seconds));
}

/**
 * The rate to clock the output at, from ffprobe's two rational strings.
 *
 * `r_frame_rate` first: it is the stream's nominal rate. A variable-rate
 * screen recording can report a nonsense value there (`1000/1`), so anything
 * outside the project's 1..240 falls through to `avg_frame_rate`, then to 30.
 */
export function outputFps(
  rFrameRate: string | undefined,
  avgFrameRate: string | undefined,
): number {
  for (const candidate of [rFrameRate, avgFrameRate]) {
    const rate = parseRate(candidate);
    if (rate >= MIN_FPS && rate <= MAX_FPS) {
      return Math.round(rate * 1000) / 1000;
    }
  }
  return 30;
}

function parseRate(rate: string | undefined): number {
  if (rate == null) {
    return 0;
  }
  const [num, den] = rate.split("/");
  const n = Number(num);
  const d = den == null ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return 0;
  }
  return n / d;
}

const sec = (value: number) => value.toFixed(3);

/**
 * The shared encode. `-crf 16` because every frame is encoded twice — once
 * cut, once reversed — and generation loss compounds; `veryfast` because the
 * user is watching a progress bar.
 */
function encode(fps: number): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
  ];
}

/**
 * Cut `[fromSec, fromSec + lenSec)` of the source into chunks of `chunkSec`.
 *
 * `-fps_mode cfr` because a screen recording is variable-rate: a still page
 * produces no frames at all, and a reversed variable-rate stream would carry
 * its gaps in the wrong places. The crop drops an odd last row or column,
 * which yuv420p cannot represent and libx264 refuses outright.
 */
export function splitArgs(options: {
  source: string;
  fromSec: number;
  lenSec: number;
  fps: number;
  chunkSec: number;
  pattern: string;
}): string[] {
  const { source, fromSec, lenSec, fps, chunkSec, pattern } = options;
  return [
    "-y",
    "-ss",
    sec(fromSec),
    "-t",
    sec(lenSec),
    "-i",
    source,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    "crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    ...encode(fps),
    "-force_key_frames",
    `expr:gte(t,n_forced*${chunkSec})`,
    "-f",
    "segment",
    "-segment_format",
    "mp4",
    "-segment_time",
    String(chunkSec),
    "-reset_timestamps",
    "1",
    pattern,
  ];
}

/**
 * Reverse one chunk.
 *
 * A one-second GOP on the way out: the user's sources carry keyframes eight
 * seconds apart, and a reversed copy that inherited that would make every
 * scrub across it a full GOP walk, the problem proxies were built to solve.
 */
export function reverseChunkArgs(
  input: string,
  output: string,
  fps: number,
): string[] {
  return [
    "-y",
    "-i",
    input,
    "-an",
    "-vf",
    "reverse",
    ...encode(fps),
    "-g",
    String(Math.max(1, Math.round(fps))),
    "-f",
    "mp4",
    output,
  ];
}

/**
 * The window's sound, reversed whole. Audio is small — ten minutes of 48kHz
 * stereo is a couple of hundred megabytes as floats — so it needs no chunks.
 */
export function audioArgs(
  source: string,
  fromSec: number,
  lenSec: number,
  output: string,
): string[] {
  return [
    "-y",
    "-ss",
    sec(fromSec),
    "-t",
    sec(lenSec),
    "-i",
    source,
    "-vn",
    "-map",
    "0:a:0",
    "-af",
    "areverse",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-f",
    "mp4",
    output,
  ];
}

/**
 * Join the reversed chunks, already in play order, with the reversed sound.
 *
 * Stream copy: every chunk came out of the same encoder settings, so the concat
 * demuxer can butt them together without a third generation. The format is
 * stated because the caller writes to a `.part` name FFmpeg cannot infer from.
 */
export function joinArgs(
  listPath: string,
  audioPath: string | null,
  output: string,
): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    ...(audioPath == null ? [] : ["-i", audioPath]),
    "-map",
    "0:v:0",
    ...(audioPath == null ? [] : ["-map", "1:a:0"]),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

/**
 * A concat-demuxer list. Single quotes in a path are closed, escaped and
 * reopened — the demuxer's own quoting rule — because a macOS screen recording
 * is routinely called something with an apostrophe in it.
 */
export function concatList(paths: readonly string[]): string {
  return paths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n")
    .concat("\n");
}

/**
 * How much of the whole each stage is worth. Cutting and reversing both
 * decode and encode every frame, so they share the bar; sound and the stream
 * copy are small. Without sound its slice goes to the two big stages.
 */
export function stageWeights(
  hasAudio: boolean,
): Record<ReverseStage, number> {
  return hasAudio
    ? { split: 0.45, reverse: 0.45, audio: 0.05, join: 0.05 }
    : { split: 0.475, reverse: 0.475, audio: 0, join: 0.05 };
}

const ORDER: ReverseStage[] = ["split", "reverse", "audio", "join"];

/** The overall fraction, 0..1, `stageFraction` of the way through `stage`. */
export function overallFraction(
  weights: Record<ReverseStage, number>,
  stage: ReverseStage,
  stageFraction: number,
): number {
  let done = 0;
  for (const s of ORDER) {
    if (s === stage) {
      break;
    }
    done += weights[s];
  }
  const within = Math.min(1, Math.max(0, stageFraction));
  return Math.min(1, done + weights[stage] * within);
}
