/**
 * The reversal run for real, against the bundled ffmpeg.
 *
 * The unit tests in `reverseRecipe.test.ts` pin the arguments; this pins what
 * they *do*. A reversed file that is a frame short, or that repeats or drops a
 * frame at every chunk boundary, looks fine at a glance and plays with a
 * stutter nobody can place — so the check is frame by frame: decode the source
 * window and the output to raw greyscale, and require that output frame `i` is
 * closest to source frame `N-1-i` and to no other.
 *
 * The memory budget is forced down to one byte so a one-second window is cut
 * into four chunks, which is what puts the chunk boundaries under test.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CancelledError, probeMedia, reverseWindow } from "./reversePipeline";

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

const W = 64;
const H = 48;
const FRAME = W * H;

let dir = "";
let withSound = "";
let silent = "";

/** Every frame of `args`' input as raw greyscale, one Buffer per frame. */
function frames(inputArgs: string[]): Buffer[] {
  const out = spawnSync(
    FFMPEG!,
    ["-v", "error", ...inputArgs, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.status !== 0) {
    throw new Error(out.stderr.toString());
  }
  const all = out.stdout as Buffer;
  const list: Buffer[] = [];
  for (let at = 0; at + FRAME <= all.length; at += FRAME) {
    list.push(all.subarray(at, at + FRAME));
  }
  return list;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

/** The index of the source frame `frame` looks most like. */
function closest(frame: Buffer, source: Buffer[]): number {
  let best = 0;
  let bestDiff = Infinity;
  source.forEach((candidate, index) => {
    const diff = meanAbsDiff(frame, candidate);
    if (diff < bestDiff) {
      best = index;
      bestDiff = diff;
    }
  });
  return best;
}

beforeAll(() => {
  if (FFMPEG == null) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-reverse-"));
  withSound = path.join(dir, "it's sound.mp4");
  silent = path.join(dir, "silent.mp4");

  // Every frame a flat, different grey: `16 + 3N`, rising through the sixty
  // frames and staying inside video range (16..235). Two fixtures were wrong
  // before this one, and both failed the test while the pipeline was right:
  //  - `testsrc2` at 64x48 changes by under one grey level between neighbouring
  //    frames, less than the encoder's own noise, so "closest frame" was a coin
  //    toss between neighbours;
  //  - a wrapping `37N mod 256` left video range, so everything under 16 decoded
  //    as 0 and everything over 235 as 255, and four frames were "the same".
  // Flat frames encode almost exactly, so a duplicate or a drop at a chunk
  // boundary is now the only thing that can move the answer.
  const make = (out: string, sound: boolean) => {
    const result = spawnSync(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `nullsrc=size=${W}x${H}:rate=30:duration=2,geq=lum='16+3*N':cb=128:cr=128`,
      ...(sound
        ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"]
        : []),
      "-c:v",
      "libx264",
      // A long GOP, like the user's sources, so the cut has to decode through.
      "-g",
      "60",
      "-pix_fmt",
      "yuv420p",
      ...(sound ? ["-c:a", "aac", "-shortest"] : []),
      out,
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr.toString());
    }
  };
  make(withSound, true);
  make(silent, false);
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describeIf("reverseWindow, against the bundled ffmpeg", () => {
  it("plays the window's frames in exactly the opposite order", async () => {
    const out = path.join(dir, "reversed.mp4");
    const stages = new Set<string>();
    let last = 0;
    let monotonic = true;

    await reverseWindow({
      ffmpeg: FFMPEG!,
      ffprobe: FFPROBE!,
      source: withSound,
      fromMs: 500,
      toMs: 1500,
      outPath: out,
      workDir: path.join(dir, "work"),
      frameBudgetBytes: 1,
      onProgress: (fraction, stage) => {
        stages.add(stage);
        if (fraction < last - 1e-9) {
          monotonic = false;
        }
        last = fraction;
      },
    });

    const source = frames(["-ss", "0.5", "-t", "1", "-i", withSound]);
    const reversed = frames(["-i", out]);

    expect(source.length).toBe(30);
    expect(reversed.length).toBe(source.length);
    const n = reversed.length;
    const mismatches = reversed
      .map((frame, i) => ({ i, got: closest(frame, source), want: n - 1 - i }))
      .filter(({ got, want }) => got !== want);
    expect(mismatches).toEqual([]);

    expect([...stages]).toEqual(["split", "reverse", "audio", "join"]);
    expect(monotonic).toBe(true);
    expect(last).toBeCloseTo(1);
    expect(fs.existsSync(path.join(dir, "work"))).toBe(false);
  });

  it("carries the window's sound, and runs as long as the window", async () => {
    const out = path.join(dir, "reversed-sound.mp4");
    await reverseWindow({
      ffmpeg: FFMPEG!,
      ffprobe: FFPROBE!,
      source: withSound,
      fromMs: 0,
      toMs: 1000,
      outPath: out,
      workDir: path.join(dir, "work-sound"),
    });
    const info = await probeMedia(FFPROBE!, out);
    expect(info.hasAudio).toBe(true);
    expect(info.durationMs).toBeGreaterThan(950);
    expect(info.durationMs).toBeLessThan(1100);
  });

  it("makes a silent file from a silent source", async () => {
    const out = path.join(dir, "reversed-silent.mp4");
    await reverseWindow({
      ffmpeg: FFMPEG!,
      ffprobe: FFPROBE!,
      source: silent,
      fromMs: 200,
      toMs: 1200,
      outPath: out,
      workDir: path.join(dir, "work-silent"),
    });
    expect((await probeMedia(FFPROBE!, out)).hasAudio).toBe(false);
  });

  it("stops on abort, says so, and leaves no scratch behind", async () => {
    const out = path.join(dir, "cancelled.mp4");
    const work = path.join(dir, "work-cancel");
    const controller = new AbortController();

    const run = reverseWindow({
      ffmpeg: FFMPEG!,
      ffprobe: FFPROBE!,
      source: withSound,
      fromMs: 0,
      toMs: 2000,
      outPath: out,
      workDir: work,
      frameBudgetBytes: 1,
      signal: controller.signal,
      onProgress: (_fraction, stage) => {
        if (stage === "reverse") {
          controller.abort();
        }
      },
    });

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(fs.existsSync(work)).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("refuses an empty window before spawning anything", async () => {
    await expect(
      reverseWindow({
        ffmpeg: FFMPEG!,
        ffprobe: FFPROBE!,
        source: silent,
        fromMs: 1000,
        toMs: 1000,
        outPath: path.join(dir, "never.mp4"),
        workDir: path.join(dir, "work-never"),
      }),
    ).rejects.toThrow(/Nothing to reverse/);
  });
});
