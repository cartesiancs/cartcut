/**
 * Writing the `.cartcut-input.json` beside a finished recording.
 *
 * Main writes it because main collected it, and because **main owns the
 * directory**: the same rule `lib/autosaveCache.ts` holds, where the renderer
 * names a key and never a path. Nothing in this pipeline lets another process
 * choose where bytes land.
 *
 * The packing below is a **hand copy** of
 * `apps/app/src/features/record/inputLog.ts#encodeInputLog`, which `electron/`
 * may not import (`.tsconfig` pins `rootDir` to `electron/`, and one such import
 * relocates the whole build out of `main/`). `recordInputFile.test.ts` pins the
 * copy against the original the way `mcp/tools/tools.test.ts` pins its enums:
 * a suite, not a comment, because a silent drift here means zooms in the wrong
 * places on every future recording.
 */

import * as fsp from "fs/promises";
import log from "electron-log";

/** Must match `inputLog.ts#INPUT_LOG_VERSION`. Pinned by the suite. */
export const INPUT_LOG_VERSION = 1;

export type CursorSample = { t: number; x: number; y: number };
export type PointerMark = { t: number; x: number; y: number; kind: string };

export type InputLogInput = {
  capture: { width: number; height: number; fps: number };
  durationMs: number;
  cursor: readonly CursorSample[];
  pointer: readonly PointerMark[];
};

/** Exported for the suite; the format and nothing else. */
export function encodeInputLog(input: InputLogInput): string {
  return JSON.stringify({
    version: INPUT_LOG_VERSION,
    capture: input.capture,
    durationMs: input.durationMs,
    cursor: input.cursor.map((sample) => [
      Math.round(sample.t),
      Math.round(sample.x),
      Math.round(sample.y),
    ]),
    pointer: input.pointer.map((mark) => [
      Math.round(mark.t),
      Math.round(mark.x),
      Math.round(mark.y),
      mark.kind,
    ]),
  });
}

/** `Cartcut 2026-09-27 16.42.10.mp4` -> `… .cartcut-input.json`. */
export function inputLogPathFor(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, "") + ".cartcut-input.json";
}

/**
 * Write it, and answer `null` rather than failing the take.
 *
 * A recording that reached the mux is the thing the user spent their time on.
 * Losing the zoom plan because a disk was full is a disappointment; losing the
 * recording to the same cause would be unforgivable, so this swallows and logs.
 */
export async function writeInputLog(
  videoPath: string,
  input: InputLogInput,
): Promise<string | null> {
  const target = inputLogPathFor(videoPath);
  try {
    await fsp.writeFile(target, encodeInputLog(input), "utf8");
    return target;
  } catch (error) {
    log.warn("[record] could not write the input log", target, error);
    return null;
  }
}
