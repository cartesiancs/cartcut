/**
 * Reversed copies of clip windows, cached in `userData/reversed`.
 *
 * The same arrangement as proxies (`proxy.ts`), and for its reasons: derived
 * media lives beside the app, not beside the user's footage, and it is keyed by
 * the source's *identity* — path, size, mtime — plus the window and the recipe
 * version, so a file edited in place can never serve stale frames.
 *
 * A cache hit is what makes undo cheap. Undoing a reversal puts the clip back
 * on its forward source in the document; redoing it, or reversing the same
 * window again, finds the file already here and costs nothing.
 *
 * Nothing here knows about the timeline, and the pipeline itself is in
 * `reversePipeline.ts`, which has no Electron in it so it can be tested.
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { ffmpegConfig } from "./ffmpeg";
import { probeMedia, reverseWindow } from "./reversePipeline";
import { RECIPE_VERSION, type ReverseStage } from "./reverseRecipe";

export type ReverseRequest = {
  /** Absolute OS path of the source. */
  source: string;
  /** The window to reverse, in source ms. */
  fromMs: number;
  toMs: number;
};

export type ReverseOutput = {
  /** Absolute OS path of the reversed file. */
  path: string;
  durationMs: number;
  hasAudio: boolean;
};

export function reverseDir(): string {
  return path.join(app.getPath("userData"), "reversed");
}

/** A stable file name for "this window of this exact file, this recipe". */
export function reverseKey(
  source: string,
  sizeBytes: number,
  mtimeMs: number,
  fromMs: number,
  toMs: number,
): string {
  return createHash("sha1")
    .update(
      [
        source,
        sizeBytes,
        Math.round(mtimeMs),
        Math.round(fromMs),
        Math.round(toMs),
        RECIPE_VERSION,
      ].join(" "),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * The reversed file for this window, made if it is not already cached.
 *
 * Written to a `.part` name and renamed into place, so an interrupted run can
 * never leave a truncated file that the next call would take for a finished
 * one.
 */
export async function ensureReversed(
  request: ReverseRequest,
  onProgress?: (fraction: number, stage: ReverseStage) => void,
  signal?: AbortSignal,
): Promise<ReverseOutput> {
  const { source, fromMs, toMs } = request;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error(`Source file not found: ${source}`);
  }

  const dir = reverseDir();
  const key = reverseKey(source, stat.size, stat.mtimeMs, fromMs, toMs);
  const outPath = path.join(dir, `${key}.mp4`);

  if (!fs.existsSync(outPath)) {
    fs.mkdirSync(dir, { recursive: true });
    const partPath = `${outPath}.part`;
    try {
      await reverseWindow({
        ffmpeg: ffmpegConfig.FFMPEG_PATH,
        ffprobe: ffmpegConfig.FFPROBE_PATH,
        source,
        fromMs,
        toMs,
        outPath: partPath,
        workDir: `${outPath}.tmp`,
        onProgress,
        signal,
      });
      fs.renameSync(partPath, outPath);
    } catch (error) {
      fs.rmSync(partPath, { force: true });
      throw error;
    }
  }

  const info = await probeMedia(ffmpegConfig.FFPROBE_PATH, outPath);
  return { path: outPath, durationMs: info.durationMs, hasAudio: info.hasAudio };
}
