/**
 * The screen recorder's finished takes, counted and removed. Plain `fs`, no
 * Electron.
 *
 * The folder is user-visible (`~/Movies/Cartcut Recordings`), so a user may
 * keep files of their own in it. Only names `recordingFilename` produces are
 * touched, each with its `.cartcut-input.json` beside it; the name is minted
 * here so the suite can hold the pattern against the function that writes it.
 */

import * as fsp from "fs/promises";
import path from "path";

import { inputLogPathFor } from "../recordInputFile";

/** `Cartcut 2026-09-03 16.42.10.mp4`: sortable, and legal on every platform. */
export function recordingFilename(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    "Cartcut ",
    when.getFullYear(),
    "-",
    pad(when.getMonth() + 1),
    "-",
    pad(when.getDate()),
    " ",
    pad(when.getHours()),
    ".",
    pad(when.getMinutes()),
    ".",
    pad(when.getSeconds()),
    ".mp4",
  ].join("");
}

const RECORDING_NAME = /^Cartcut \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.mp4$/;

export function isRecordingName(name: string): boolean {
  return RECORDING_NAME.test(name);
}

/** Each take in `dir`, as the files that belong to it: the mp4, then its log if present. */
async function takesIn(dir: string): Promise<{ files: string[]; bytes: number }[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    // No recording made yet: the folder is created on the first one.
    return [];
  }
  const takes: { files: string[]; bytes: number }[] = [];
  for (const name of names.filter(isRecordingName).sort()) {
    const video = path.join(dir, name);
    const videoStat = await fsp.lstat(video).catch(() => null);
    if (videoStat == null || !videoStat.isFile()) {
      continue;
    }
    const files = [video];
    let bytes = videoStat.size;
    const sidecar = inputLogPathFor(video);
    const sidecarStat = await fsp.lstat(sidecar).catch(() => null);
    if (sidecarStat?.isFile() === true) {
      files.push(sidecar);
      bytes += sidecarStat.size;
    }
    takes.push({ files, bytes });
  }
  return takes;
}

/** How many takes, and their size with their input logs. */
export async function summarizeRecordings(dir: string): Promise<{ files: number; bytes: number }> {
  let bytes = 0;
  const takes = await takesIn(dir);
  for (const take of takes) {
    bytes += take.bytes;
  }
  return { files: takes.length, bytes };
}

/**
 * Hand every take to `discard`, which main points at the Trash. A take whose
 * video could not go is counted as failed and keeps its input log.
 */
export async function removeRecordings(
  dir: string,
  discard: (file: string) => Promise<void>,
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const take of await takesIn(dir)) {
    const [video, ...rest] = take.files;
    try {
      await discard(video);
    } catch {
      failed += 1;
      continue;
    }
    removed += 1;
    for (const file of rest) {
      // The log without its video is useless, and a failure here leaves a few
      // kilobytes rather than a take.
      await discard(file).catch(() => {});
    }
  }
  return { removed, failed };
}
