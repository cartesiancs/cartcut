/**
 * Retiming a ramped clip's sound before FFmpeg is spawned.
 *
 * FFmpeg's graph cannot express a varying rate (`speedStretch.ts` records the
 * measurement), so a ramped clip's audio is decoded here, stretched here, and
 * handed back to FFmpeg as an ordinary input playing at 1x. That is the same
 * arrangement the picture already has: the v2 path composites every frame in
 * the renderer and FFmpeg's video branch is `[0:v]null`.
 *
 * Two things fall out of the sound arriving already in timeline time:
 *
 *  - the clip's chain carries **no `atempo`**, so the stage that used to
 *    establish what `t` meant is gone and the volume envelope's breakpoints are
 *    clip-local timeline seconds directly. `ffmpegArgs.ts#audioFilterFor`
 *    records which of its two cases each sentence of its ordering argument
 *    applies to;
 *  - the input needs no `-ss` and no `-t`. The file is exactly the clip's
 *    window and nothing else.
 *
 * **Failure is a refusal.** A decode that exits non-zero, a file that comes
 * back short, or a clip too long to hold in memory throws, and `ipcRenderV2`
 * throws it before the session id reaches the renderer. There is no fallback to
 * `atempo` at the mean rate: a ramp exported at a constant rate is wrong in a
 * way nobody hears until they watch it, and a silent clip is worse.
 */

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { channelStageFor, localFilePath } from "./ffmpegArgs";
import { speedCurveOf, curveSourceAt, curveSpanLength } from "./speedCurve";
import { MAX_PCM_BYTES, stretchAudio } from "./speedStretch";

/** One clip's retimed audio, already at 1x and already the right length. */
export type RenderedAudio = {
  /** A WAV file holding exactly the clip's timeline span. */
  path: string;
  sampleRate: number;
  channels: 1 | 2;
};

export type RenderedAudioSet = {
  /** Keyed by element id. Empty for every project with no ramps. */
  byElementId: Map<string, RenderedAudio>;
  /** The scratch directory these live in, to be removed with the session. */
  directory: string | null;
};

export const EMPTY_RENDERED_AUDIO: RenderedAudioSet = {
  byElementId: new Map(),
  directory: null,
};

/** Whether this clip's sound has to be retimed here rather than by FFmpeg. */
function needsRetiming(element: any): boolean {
  return speedCurveOf(element) != null;
}

/**
 * Decode exactly one clip's source window to interleaved f32.
 *
 * The layout stage runs here, so the PCM is already in the export's channel
 * layout and swresample never gets to choose the matrix. `audioFilterFor` keeps
 * its own copy of the stage, which is provably identity on a stream that
 * already has the target layout, so neither side needs a branch.
 */
function decodeWindow(
  ffmpegPath: string,
  localpath: string,
  ssSec: number,
  tSec: number,
  sampleRate: number,
  channels: 1 | 2,
): Promise<Float32Array> {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    `${ssSec}`,
    "-t",
    `${tSec}`,
    "-i",
    localFilePath(localpath),
    "-vn",
    "-af",
    channelStageFor(channels),
    "-f",
    "f32le",
    "-ar",
    `${sampleRate}`,
    "-ac",
    `${channels}`,
    "-",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const stderr: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PCM_BYTES) {
        // Refused rather than swallowed. Left to run this would exhaust the
        // main process partway through an export the user is watching.
        failed = true;
        child.kill("SIGKILL");
        reject(
          new Error(
            `Cannot export: the speed ramp on ${basename(
              localFilePath(localpath),
            )} covers more audio than can be retimed at once. Split the clip and try again.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (failed) {
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Cannot export: reading the audio of ${basename(
              localFilePath(localpath),
            )} failed (ffmpeg exited ${code}). ${stderr.join("").trim()}`.trim(),
          ),
        );
        return;
      }
      const buffer = Buffer.concat(chunks);
      // `Float32Array` over the buffer's own memory, so the samples are not
      // copied a second time. The byte offset matters: `Buffer.concat` may hand
      // back a view into a larger pool.
      resolve(
        new Float32Array(
          buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength - (buffer.byteLength % 4),
          ),
        ),
      );
    });
  });
}

/** A 32-bit float WAV header for `frames` frames. Sixteen bytes of extensible chunk. */
function wavHeader(frames: number, sampleRate: number, channels: number): Buffer {
  const blockAlign = channels * 4;
  const dataBytes = frames * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  // 3 is IEEE float. A ramped clip's samples come out of the stretcher as
  // floats and writing them as 16-bit integers here would add a quantisation
  // step no other clip in the mix pays.
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Retime every ramped clip in the timeline, or return an empty set.
 *
 * Every project without a ramp takes the early return and a zero-length loop,
 * which is the regression budget for this whole path.
 */
export async function prepareRenderedAudio(
  ffmpegPath: string,
  timeline: Record<string, any>,
  settings: { sampleRate: number; channels: 1 | 2 },
  scratchRoot: string = tmpdir(),
): Promise<RenderedAudioSet> {
  const ramped = Object.entries(timeline).filter(
    ([, element]) => isAudibleForRetime(element) && needsRetiming(element),
  );
  if (ramped.length === 0) {
    return EMPTY_RENDERED_AUDIO;
  }

  const directory = await mkdtemp(join(scratchRoot, "cartcut-ramp-"));
  const byElementId = new Map<string, RenderedAudio>();

  try {
    for (const [id, element] of ramped) {
      const curve = speedCurveOf(element)!;
      const trimStart = element.trim.startTime;
      const trimEnd = element.trim.endTime;
      // The clip's timeline span, the same number `spanLength` gives the
      // renderer, so the file is exactly as long as the mix expects the clip to
      // occupy and `adelay` places it to the sample.
      const spanMs = curveSpanLength(curve, trimStart, trimEnd);
      const outputFrames = Math.round((spanMs / 1000) * settings.sampleRate);
      if (!(outputFrames > 0)) {
        throw new Error(
          `Cannot export: the speed ramp on ${basename(
            localFilePath(element.localpath),
          )} leaves the clip no length.`,
        );
      }

      const input = await decodeWindow(
        ffmpegPath,
        element.localpath,
        trimStart / 1000,
        element.duration / 1000,
        settings.sampleRate,
        settings.channels,
      );

      const stretched = stretchAudio({
        input,
        channels: settings.channels,
        sampleRate: settings.sampleRate,
        sourceStartMs: trimStart,
        sourceAt: (outputMs) => curveSourceAt(curve, trimStart, outputMs),
        outputFrames,
      });

      const path = join(directory, `${id.replace(/[^\w.-]/g, "_")}.wav`);
      await writeFile(
        path,
        Buffer.concat([
          wavHeader(outputFrames, settings.sampleRate, settings.channels),
          Buffer.from(
            stretched.buffer,
            stretched.byteOffset,
            stretched.byteLength,
          ),
        ]),
      );

      byElementId.set(id, {
        path,
        sampleRate: settings.sampleRate,
        channels: settings.channels,
      });
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return { byElementId, directory };
}

/** Remove a session's scratch directory. Never throws; there is nothing to do. */
export async function dropRenderedAudio(set: RenderedAudioSet): Promise<void> {
  if (set.directory == null) {
    return;
  }
  await rm(set.directory, { recursive: true, force: true }).catch(() => {});
}

/**
 * The audibility test, restated.
 *
 * `ffmpegArgs.ts#isAudible` is not exported and is itself a hand copy; rather
 * than widen its surface, the two conditions that matter here are named
 * directly. A clip that is not in the mix is not worth retiming, and a video
 * whose sound has been detached is heard through its twin, which is ramped in
 * its own right.
 */
function isAudibleForRetime(element: any): boolean {
  if (element == null || typeof element !== "object") {
    return false;
  }
  if (element.filetype === "audio") {
    return typeof element.localpath === "string" && element.localpath !== "";
  }
  if (element.filetype === "video") {
    return (
      element.isExistAudio === true &&
      element.audioDetached !== true &&
      typeof element.localpath === "string" &&
      element.localpath !== ""
    );
  }
  return false;
}
