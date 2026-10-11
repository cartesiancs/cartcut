import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import {
  isRecordingName,
  recordingFilename,
  removeRecordings,
  summarizeRecordings,
} from "./recordingFiles";

let dir: string;

const TAKE_A = "Cartcut 2026-09-03 16.42.10.mp4";
const LOG_A = "Cartcut 2026-09-03 16.42.10.cartcut-input.json";
const TAKE_B = "Cartcut 2026-10-01 09.05.00.mp4";

async function write(name: string, size: number): Promise<void> {
  await fsp.writeFile(path.join(dir, name), Buffer.alloc(size, 1));
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

/** A stand-in for the Trash: records each file and removes it. */
function recordingTrash(failOn: string | null = null) {
  const discarded: string[] = [];
  const discard = async (file: string) => {
    if (failOn != null && path.basename(file) === failOn) {
      throw new Error("held open");
    }
    discarded.push(path.basename(file));
    await fsp.rm(file);
  };
  return { discarded, discard };
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-recordings-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("isRecordingName", () => {
  it("accepts every name recordingFilename mints", () => {
    for (const when of [
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 11, 31, 23, 59, 59),
      new Date(2031, 5, 9, 7, 8, 9),
    ]) {
      expect(isRecordingName(recordingFilename(when))).toBe(true);
    }
  });

  it("refuses the user's own files, the input log and near misses", () => {
    for (const name of [
      "holiday.mp4",
      "Cartcut notes.txt",
      LOG_A,
      "Cartcut 2026-09-03 16.42.10.mov",
      "Cartcut 2026-09-03 16.42.10 copy.mp4",
      "cartcut 2026-09-03 16.42.10.mp4",
    ]) {
      expect(isRecordingName(name)).toBe(false);
    }
  });
});

describe("summarizeRecordings", () => {
  it("counts takes, with their input logs in the size but not as files", async () => {
    await write(TAKE_A, 1000);
    await write(LOG_A, 40);
    await write(TAKE_B, 500);
    await write("holiday.mp4", 9999);

    expect(await summarizeRecordings(dir)).toEqual({ files: 2, bytes: 1000 + 40 + 500 });
  });

  it("reads a folder that was never created as empty", async () => {
    expect(await summarizeRecordings(path.join(dir, "missing"))).toEqual({ files: 0, bytes: 0 });
  });
});

describe("removeRecordings", () => {
  it("discards each take and its log, and nothing else in the folder", async () => {
    await write(TAKE_A, 10);
    await write(LOG_A, 10);
    await write(TAKE_B, 10);
    await write("holiday.mp4", 10);
    await write("Cartcut notes.txt", 10);
    const trash = recordingTrash();

    expect(await removeRecordings(dir, trash.discard)).toEqual({ removed: 2, failed: 0 });
    expect(trash.discarded.sort()).toEqual([LOG_A, TAKE_A, TAKE_B].sort());
    expect(exists("holiday.mp4")).toBe(true);
    expect(exists("Cartcut notes.txt")).toBe(true);
  });

  it("counts a take that cannot go, keeps its log, and still discards the rest", async () => {
    await write(TAKE_A, 10);
    await write(LOG_A, 10);
    await write(TAKE_B, 10);
    const trash = recordingTrash(TAKE_A);

    expect(await removeRecordings(dir, trash.discard)).toEqual({ removed: 1, failed: 1 });
    expect(exists(TAKE_A)).toBe(true);
    expect(exists(LOG_A)).toBe(true);
    expect(exists(TAKE_B)).toBe(false);
  });
});
