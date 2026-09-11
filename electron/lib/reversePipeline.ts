/**
 * Running a reversal: probe, cut, reverse each chunk, reverse the sound, join.
 *
 * No Electron in here — the binaries are parameters — so
 * `reversePipeline.test.ts` can run the real thing against the bundled ffmpeg
 * and check the frames come out in the opposite order. `reverse.ts` is the thin
 * layer that knows where the binaries and the cache are.
 *
 * FFmpeg is spawned directly, never through `fluent-ffmpeg`, whose parser
 * cannot read this ffmpeg's `-formats` output (CLAUDE.md, "Known rough
 * edges"). Progress comes from `-progress pipe:1` rather than from scraping
 * stderr for `time=`: it is a stable key=value format, one field per line, and
 * it leaves stderr to carry the error message a failure needs.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import {
  audioArgs,
  chunkSecondsFor,
  concatList,
  joinArgs,
  outputFps,
  overallFraction,
  reverseChunkArgs,
  splitArgs,
  stageWeights,
  type ReverseStage,
} from "./reverseRecipe";

/** Thrown when a run is aborted, so callers can tell it from a failure. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export type MediaInfo = {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  hasAudio: boolean;
};

/** What ffprobe says about a file's first video stream and its length. */
export async function probeMedia(
  ffprobe: string,
  file: string,
): Promise<MediaInfo> {
  const out = await collect(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height,r_frame_rate,avg_frame_rate:format=duration",
    "-of",
    "json",
    file,
  ]);

  const parsed = JSON.parse(out) as {
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video") ?? {};
  const seconds = Number(parsed.format?.duration);

  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: outputFps(video.r_frame_rate, video.avg_frame_rate),
    durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

export type ReverseWindowOptions = {
  ffmpeg: string;
  ffprobe: string;
  /** Absolute OS path of the source. */
  source: string;
  /** The window to reverse, in source ms. */
  fromMs: number;
  toMs: number;
  /** Where the finished file goes. Written in place; rename it yourself. */
  outPath: string;
  /** Scratch space, created empty and removed afterwards whatever happens. */
  workDir: string;
  /** Overrides the memory budget — the suite uses it to force many chunks. */
  frameBudgetBytes?: number;
  onProgress?: (fraction: number, stage: ReverseStage) => void;
  signal?: AbortSignal;
};

/** Reverse `[fromMs, toMs)` of `source` into `outPath`. */
export async function reverseWindow(
  options: ReverseWindowOptions,
): Promise<void> {
  const { ffmpeg, ffprobe, source, fromMs, toMs, outPath, workDir, signal } =
    options;

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(`Nothing to reverse between ${fromMs}ms and ${toMs}ms.`);
  }

  const fromSec = fromMs / 1000;
  const lenSec = (toMs - fromMs) / 1000;

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const info = await probeMedia(ffprobe, source);
    const chunkSec = chunkSecondsFor(
      info.width,
      info.height,
      info.fps,
      options.frameBudgetBytes,
    );
    const weights = stageWeights(info.hasAudio);
    const report = (stage: ReverseStage, fraction: number) =>
      options.onProgress?.(overallFraction(weights, stage, fraction), stage);

    report("split", 0);
    await runFfmpeg(
      ffmpeg,
      splitArgs({
        source,
        fromSec,
        lenSec,
        fps: info.fps,
        chunkSec,
        pattern: path.join(workDir, "seg_%05d.mp4"),
      }),
      { signal, onTimeSec: (s) => report("split", s / lenSec) },
    );

    // Zero-padded, so a lexical sort is play order.
    const segments = fs
      .readdirSync(workDir)
      .filter((name) => /^seg_\d+\.mp4$/.test(name))
      .sort();
    if (segments.length === 0) {
      throw new Error("FFmpeg produced no frames for this range.");
    }

    const reversed: string[] = [];
    for (let k = 0; k < segments.length; k++) {
      const output = path.join(workDir, `rev_${k}.mp4`);
      await runFfmpeg(
        ffmpeg,
        reverseChunkArgs(path.join(workDir, segments[k]), output, info.fps),
        {
          signal,
          onTimeSec: (s) =>
            report("reverse", (k + Math.min(1, s / chunkSec)) / segments.length),
        },
      );
      reversed.push(output);
      report("reverse", (k + 1) / segments.length);
    }

    let audio: string | null = null;
    if (info.hasAudio) {
      audio = path.join(workDir, "audio.m4a");
      await runFfmpeg(ffmpeg, audioArgs(source, fromSec, lenSec, audio), {
        signal,
        onTimeSec: (s) => report("audio", s / lenSec),
      });
    }

    // The last chunk of the source is the first of the output.
    const list = path.join(workDir, "list.txt");
    fs.writeFileSync(list, concatList([...reversed].reverse()));

    await runFfmpeg(ffmpeg, joinArgs(list, audio, outPath), {
      signal,
      onTimeSec: (s) => report("join", s / lenSec),
    });
    report("join", 1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Spawn ffmpeg, report output time in seconds, and kill it on abort.
 *
 * SIGKILL rather than a polite `q` on stdin: a reversal holds up to the whole
 * memory budget in frames, and the point of cancelling is to get it back now.
 * The partial output is the caller's to delete — `reverseWindow` removes its
 * scratch directory in a `finally`.
 */
export function runFfmpeg(
  bin: string,
  args: string[],
  options: { onTimeSec?: (seconds: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const { onTimeSec, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const child = spawn(bin, [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-nostats",
      ...args,
    ]);

    let err = "";
    let pending = "";

    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        // `out_time_us` is microseconds; `N/A` before the first frame.
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match != null && onTimeSec != null) {
          onTimeSec(Number(match[1]) / 1e6);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      // The tail only: the reason for a failure is at the end.
      err = (err + chunk.toString()).slice(-4000);
    });

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new CancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(err.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/** Run a binary to completion and hand back its stdout. */
function collect(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
    );
  });
}
