/**
 * The probe's failure paths against a fake child, then the real bundled
 * ffprobe against files the bundled ffmpeg makes.
 *
 * The real half checks against the arguments the fixtures were made with,
 * which share no code with the parser. Two fixtures differ only in frame rate
 * and must report different rates, so a probe that answered a constant would
 * fail.
 */

import { spawnSync, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_PROBE_OUTPUT_BYTES,
  probeArgs,
  probeMediaInfo,
  type ProbeDeps,
} from "./mediaInfoProbe";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn(() => true);
}

function fakeDeps(overrides: Partial<ProbeDeps> = {}) {
  const child = new FakeChild();
  const deps: ProbeDeps = {
    spawn: vi.fn(() => child as unknown as ChildProcess),
    stat: vi.fn(async () => ({ isFile: () => true })),
    timeoutMs: 1_000,
    ...overrides,
  };
  return { child, deps };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("probeMediaInfo, before anything is spawned", () => {
  it.each([
    ["a number", 42],
    ["an empty string", ""],
    ["a relative path", "movies/a.mp4"],
    ["a URL", "http://example.com/a.mp4"],
    ["a file URL", "file:///Users/me/a.mp4"],
    ["a path with a NUL", "/Users/me/a\0.mp4"],
  ])("refuses %s", async (_label, input) => {
    const { deps } = fakeDeps();
    await expect(probeMediaInfo("ffprobe", input, deps)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("reports a moved file as missing", async () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const { deps } = fakeDeps({
        stat: vi.fn(async () => {
          throw errno(code);
        }),
      });
      await expect(probeMediaInfo("ffprobe", "/a.mp4", deps)).resolves.toEqual({
        ok: false,
        reason: "missing",
      });
      expect(deps.spawn).not.toHaveBeenCalled();
    }
  });

  it("reports a file it may not read as unreadable", async () => {
    const { deps } = fakeDeps({
      stat: vi.fn(async () => {
        throw errno("EACCES");
      }),
    });
    await expect(probeMediaInfo("ffprobe", "/a.mp4", deps)).resolves.toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("refuses a directory", async () => {
    const { deps } = fakeDeps({
      stat: vi.fn(async () => ({ isFile: () => false })),
    });
    await expect(probeMediaInfo("ffprobe", "/Movies", deps)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("probeMediaInfo, around the child", () => {
  it("names the file behind a file: prefix, with only the file protocol allowed", () => {
    const args = probeArgs("/Users/me/it's #1.mp4");
    expect(args[args.length - 1]).toBe("file:/Users/me/it's #1.mp4");
    expect(args.join(" ")).toContain("-protocol_whitelist file");
    expect(args.join(" ")).toContain("-print_format json");
  });

  it("parses what a successful run prints", async () => {
    const { child, deps } = fakeDeps();
    const pending = probeMediaInfo("ffprobe", "/a.mp4", deps);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());

    const json = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 2 }],
    });
    // Split across chunks, the way a pipe delivers it.
    child.stdout.emit("data", Buffer.from(json.slice(0, 10)));
    child.stdout.emit("data", Buffer.from(json.slice(10)));
    child.emit("close", 0);

    const result = await pending;
    expect(result.ok && result.info.video?.codec).toBe("h264");
    expect(deps.spawn).toHaveBeenCalledWith("ffprobe", probeArgs("/a.mp4"));
  });

  it("reports a failed run, a crash and unparseable output as unreadable", async () => {
    for (const end of [
      (c: FakeChild) => c.emit("close", 1),
      (c: FakeChild) => c.emit("error", errno("ENOENT")),
      (c: FakeChild) => {
        c.stdout.emit("data", Buffer.from("not json"));
        c.emit("close", 0);
      },
    ]) {
      const { child, deps } = fakeDeps();
      const pending = probeMediaInfo("ffprobe", "/a.mp4", deps);
      await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
      end(child);
      await expect(pending).resolves.toEqual({ ok: false, reason: "unreadable" });
    }
  });

  it("kills a probe that never finishes", async () => {
    const { child, deps } = fakeDeps({ timeoutMs: 5 });
    await expect(probeMediaInfo("ffprobe", "/a.mp4", deps)).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("kills a probe whose output will not stop", async () => {
    const { child, deps } = fakeDeps();
    const pending = probeMediaInfo("ffprobe", "/a.mp4", deps);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());

    child.stdout.emit("data", Buffer.alloc(MAX_PROBE_OUTPUT_BYTES + 1));
    // A close after the kill must not turn the refusal into a parse attempt.
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: false, reason: "unreadable" });
    expect(child.kill).toHaveBeenCalled();
  });
});

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * The bundled binaries for this machine. Repeats `ffmpeg.ts`'s rule rather
 * than importing it, because that module reaches Electron.
 */
function binary(name: "ffmpeg" | "ffprobe"): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const file = path.join(
    REPO_ROOT,
    "bin",
    dir,
    process.platform === "win32" ? `${name}.exe` : name,
  );
  return fs.existsSync(file) ? file : null;
}

const FFMPEG = binary("ffmpeg");
const FFPROBE = binary("ffprobe");
const describeIf = FFMPEG == null || FFPROBE == null ? describe.skip : describe;

describeIf("probeMediaInfo against the bundled ffprobe", () => {
  let dir = "";
  const at = (name: string) => path.join(dir, name);

  const ffmpeg = (args: string[]) => {
    const result = spawnSync(FFMPEG!, ["-v", "error", "-y", ...args]);
    if (result.status !== 0) {
      throw new Error(result.stderr.toString());
    }
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-mediainfo-"));
    const video = (rate: number, out: string, sound: boolean) =>
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=320x180:rate=${rate}:duration=1`,
        ...(sound
          ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1"]
          : []),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        ...(sound ? ["-c:a", "aac", "-ac", "1", "-shortest"] : []),
        out,
      ]);

    // A quote, a hash and a space: the characters that break a path handed to
    // ffmpeg as a URL rather than behind `file:`.
    video(25, at("it's #1.mp4"), true);
    video(50, at("fifty.mp4"), false);
    // Counter-clockwise, as `-display_rotation` is.
    ffmpeg(["-display_rotation", "90", "-i", at("fifty.mp4"), "-c", "copy", at("turned.mp4")]);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=red@0.5:size=64x32,format=rgba",
      "-frames:v",
      "1",
      at("alpha.png"),
    ]);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads what the fixture was made with", async () => {
    const result = await probeMediaInfo(FFPROBE!, at("it's #1.mp4"));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { info } = result;

    expect(info.video).toMatchObject({
      codec: "h264",
      width: 320,
      height: 180,
      fps: 25,
      pixelFormat: "yuv420p",
      rotation: 0,
    });
    expect(info.audio).toHaveLength(1);
    expect(info.audio[0]).toMatchObject({
      codec: "aac",
      sampleRate: 44_100,
      channels: 1,
    });
    expect(Math.abs((info.durationMs ?? 0) - 1000)).toBeLessThan(100);
  });

  it("reports a different rate for a different file", async () => {
    const result = await probeMediaInfo(FFPROBE!, at("fifty.mp4"));
    expect(result.ok && result.info.video?.fps).toBe(50);
    expect(result.ok && result.info.audio).toEqual([]);
  });

  it("reads a rotation without changing the stored size", async () => {
    const result = await probeMediaInfo(FFPROBE!, at("turned.mp4"));
    expect(result.ok && result.info.video).toMatchObject({
      rotation: 270,
      width: 320,
      height: 180,
    });
  });

  it("reads a still", async () => {
    const result = await probeMediaInfo(FFPROBE!, at("alpha.png"));
    expect(result.ok && result.info.video).toMatchObject({
      codec: "png",
      pixelFormat: "rgba",
      width: 64,
      height: 32,
    });
  });

  it("says a missing file is missing and a folder is not a file", async () => {
    await expect(probeMediaInfo(FFPROBE!, at("gone.mp4"))).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
    await expect(probeMediaInfo(FFPROBE!, dir)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
