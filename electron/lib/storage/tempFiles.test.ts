import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import { removeSweeps, summarizeSweeps, type Sweep } from "./tempFiles";

/**
 * Against a real filesystem, the `autosaveCache.test.ts` choice: what can go
 * wrong here is a delete that reaches a file it should not, and a mocked `fs`
 * would only say which functions were called.
 */

let root: string;
let outside: string;

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

async function write(relative: string, size: number, base = root): Promise<string> {
  const file = path.join(base, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(size, 1));
  return file;
}

/** Date every write under `target` back by `ms`, children before their folder. */
async function age(target: string, ms: number): Promise<void> {
  const stat = await fsp.lstat(target);
  if (stat.isDirectory()) {
    for (const name of await fsp.readdir(target)) {
      await age(path.join(target, name), ms);
    }
  }
  const when = new Date(NOW - ms);
  await fsp.utimes(target, when, when);
}

const exists = (relative: string) => fs.existsSync(path.join(root, relative));

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-sweep-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-outside-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
});

describe("removeSweeps", () => {
  it("removes the entries whose names match and nothing beside them", async () => {
    await write("cartcut-record-a/video.h264", 100);
    await write("cartcut-record-b/mic.pcm", 50);
    await write("other-app-x/data.bin", 10);
    await write("cartcut-recorder-notes.txt", 5);

    const sweeps: Sweep[] = [{ root, match: (name) => name.startsWith("cartcut-record-") }];
    const result = await removeSweeps(sweeps, { nowMs: NOW });

    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(exists("cartcut-record-a")).toBe(false);
    expect(exists("cartcut-record-b")).toBe(false);
    expect(exists("other-app-x/data.bin")).toBe(true);
    expect(exists("cartcut-recorder-notes.txt")).toBe(true);
  });

  it("leaves an entry still being written and removes the same entry gone quiet", async () => {
    // The two halves differ only in one nested file's time, so the rule is
    // shown to read the newest write under the entry and not the folder's own.
    const sweeps: Sweep[] = [
      { root, match: (name) => name.startsWith("cartcut-ramp-"), minAgeMs: HOUR },
    ];

    await write("cartcut-ramp-live/deep/clip.wav", 10);
    await write("cartcut-ramp-dead/deep/clip.wav", 10);
    await age(path.join(root, "cartcut-ramp-live"), 2 * HOUR);
    await age(path.join(root, "cartcut-ramp-dead"), 2 * HOUR);
    const now = new Date(NOW);
    await fsp.utimes(path.join(root, "cartcut-ramp-live/deep/clip.wav"), now, now);

    const result = await removeSweeps(sweeps, { nowMs: NOW });

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(exists("cartcut-ramp-live/deep/clip.wav")).toBe(true);
    expect(exists("cartcut-ramp-dead")).toBe(false);
  });

  it("never touches an entry named in keep, however old", async () => {
    const active = path.dirname(await write("cartcut-record-active/video.h264", 10));
    await write("cartcut-record-crashed/video.h264", 10);
    await age(active, 5 * HOUR);

    const sweeps: Sweep[] = [{ root, match: (name) => name.startsWith("cartcut-record-") }];
    const result = await removeSweeps(sweeps, { nowMs: NOW, keep: [active + path.sep] });

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(exists("cartcut-record-active/video.h264")).toBe(true);
    expect(exists("cartcut-record-crashed")).toBe(false);
  });

  it("finds partials at any depth and takes a matching folder whole", async () => {
    await write("supertonic-3/rev1/onnx/model.onnx", 40);
    await write("supertonic-3/rev1/onnx/model.onnx.part", 30);
    await write("abc.mp4", 20);
    await write("abc.mp4.tmp/frame-0001.png", 15);
    await write("abc.mp4.tmp/frame-0002.png", 15);
    await age(root, 2 * HOUR);

    const sweeps: Sweep[] = [
      {
        root,
        match: (name) => name.endsWith(".part") || name.endsWith(".tmp"),
        recursive: true,
        minAgeMs: HOUR,
      },
    ];
    const result = await removeSweeps(sweeps, { nowMs: NOW });

    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(exists("supertonic-3/rev1/onnx/model.onnx.part")).toBe(false);
    expect(exists("supertonic-3/rev1/onnx/model.onnx")).toBe(true);
    expect(exists("abc.mp4.tmp")).toBe(false);
    expect(exists("abc.mp4")).toBe(true);
  });

  it("removes a link without following it", async () => {
    const precious = await write("footage.mp4", 500, outside);
    await fsp.symlink(outside, path.join(root, "cartcut-record-link"));

    const sweeps: Sweep[] = [{ root, match: (name) => name.startsWith("cartcut-record-") }];

    expect(await summarizeSweeps(sweeps, { nowMs: NOW })).toEqual({ bytes: 0 });
    expect(await removeSweeps(sweeps, { nowMs: NOW })).toEqual({ removed: 1, failed: 0 });
    expect(exists("cartcut-record-link")).toBe(false);
    expect(fs.existsSync(precious)).toBe(true);
  });

  it("declines quietly when no folder exists", async () => {
    const sweeps: Sweep[] = [
      { root: path.join(root, "missing"), match: () => true },
      { root: path.join(root, "also-missing"), match: () => true, recursive: true },
    ];

    expect(await summarizeSweeps(sweeps, { nowMs: NOW })).toEqual({ bytes: 0 });
    expect(await removeSweeps(sweeps, { nowMs: NOW })).toEqual({ removed: 0, failed: 0 });
  });
});

describe("summarizeSweeps", () => {
  it("counts exactly what removeSweeps then frees", async () => {
    await write("transcripts/a.json", 120);
    await write("transcripts/b.json", 80);
    await write("cartcut-stt-1.wav", 300);
    await write("cartcut-stt-fresh.wav", 999);
    await write("keep.txt", 7);
    await age(path.join(root, "cartcut-stt-1.wav"), 2 * HOUR);

    const sweeps: Sweep[] = [
      { root: path.join(root, "transcripts"), match: () => true },
      { root, match: (name) => name.startsWith("cartcut-stt-"), minAgeMs: HOUR },
    ];

    const before = await summarizeSweeps(sweeps, { nowMs: NOW });
    await removeSweeps(sweeps, { nowMs: NOW });
    const after = await summarizeSweeps(sweeps, { nowMs: NOW });

    expect(before).toEqual({ bytes: 120 + 80 + 300 });
    expect(after).toEqual({ bytes: 0 });
    expect(exists("cartcut-stt-fresh.wav")).toBe(true);
    expect(exists("keep.txt")).toBe(true);
  });

  it("counts an entry two sweeps both match once", async () => {
    await write("proxies/x.mp4.part", 64);
    await age(root, 2 * HOUR);

    const sweeps: Sweep[] = [
      { root: path.join(root, "proxies"), match: () => true },
      { root: path.join(root, "proxies"), match: (name) => name.endsWith(".part"), minAgeMs: HOUR },
    ];

    expect(await summarizeSweeps(sweeps, { nowMs: NOW })).toEqual({ bytes: 64 });
    expect(await removeSweeps(sweeps, { nowMs: NOW })).toEqual({ removed: 1, failed: 0 });
  });
});
