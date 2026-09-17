/**
 * The exported mix against the file it was cut from, measured.
 *
 * `ffmpegArgs.test.ts` pins the strings; this checks what they do. It runs the
 * **whole argv `buildFFmpegArgs` returns** through the bundled ffmpeg, frames
 * piped on stdin as the app pipes them, and reads the delivered file's level
 * per second and per channel with `astats`. The source's level is read the same
 * way from the source itself, so the only thing between the two numbers is the
 * export.
 *
 * Written against two defects that no string test could see:
 *
 *   - `amix` without `normalize=0` divides by the number of inputs that have
 *     not ended, and `adelay` makes a late clip an input from 0s. A clip split
 *     into three exported its first piece 9.5 dB down; into ten, 20 dB down.
 *   - Channel layout was left to negotiation. A mono source upmixed 3 dB down,
 *     and one mono clip in a project folded every stereo clip to mono.
 *
 * PCM in a `.mov`, so no lossy codec sits between the two measurements, and
 * ProRes for the picture because it is built into ffmpeg and a 16x16 frame
 * costs it nothing.
 *
 * ## It proves it is measuring something
 *
 * The last two cases take the argv this file checks, undo one fix each, and
 * require the measurement to move by the amount the defect is known to cost.
 * Without them a harness that measured the source twice would pass everything.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFFmpegArgs } from "./ffmpegArgs";
// Reaching across the rootDir boundary is safe in a test file and nowhere else.
import { audioElement } from "../../apps/app/src/features/renderer/testing";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Same rule as `audioEnvelope.parity.test.ts`, for the same reason. */
function ffmpegPath(): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join(
    REPO_ROOT,
    "bin",
    dir,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(binary) ? binary : null;
}

const FFMPEG = ffmpegPath();
const RATE = 48000;
const FPS = 10;
const FRAME = { w: 16, h: 16 };
/** Every source is this long, which is longer than any timeline below. */
const SOURCE_SEC = 10;
/** The PCM round trip agrees to a thousandth of a dB; the defects cost 3 to 20 dB. */
const TOLERANCE_DB = 0.1;

/**
 * The sources, as lavfi graphs. A 440 Hz sine at lavfi's default amplitude
 * (1/8), so nothing below ever sums past full scale.
 */
const SOURCES = {
  mono: "sine=frequency=440:sample_rate=48000",
  /** Stereo with sound on the left only, to show the image survives. */
  left:
    "sine=frequency=440:sample_rate=48000[l];" +
    "anullsrc=channel_layout=mono:sample_rate=48000[r];" +
    "[l][r]join=inputs=2:channel_layout=stereo",
  /** Stereo with the same sound on both sides. */
  dual:
    "sine=frequency=440:sample_rate=48000,asplit[l][r];" +
    "[l][r]join=inputs=2:channel_layout=stereo",
} as const;

type Source = keyof typeof SOURCES;

let dir = "";
let outputs = 0;

function run(args: string[], input?: Buffer): string {
  const result = spawnSync(FFMPEG!, args, {
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg exited ${result.status}:\n${result.stderr?.toString() ?? ""}`,
    );
  }
  return result.stdout.toString("utf8");
}

function sourcePath(source: Source): string {
  return path.join(dir, `${source}.wav`);
}

beforeAll(() => {
  if (FFMPEG == null) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-mix-"));
  for (const [name, graph] of Object.entries(SOURCES)) {
    run([
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", graph,
      "-t", `${SOURCE_SEC}`,
      "-c:a", "pcm_s16le",
      sourcePath(name as Source),
    ]);
  }
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One second of a file: RMS per channel in dBFS, `-Infinity` for silence. */
type Second = number[];

/** A file's level, one entry per whole second, one number per channel. */
function levelsOf(file: string): Second[] {
  const stdout = run([
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", file,
    "-map", "0:a",
    "-af",
    `asetnsamples=n=${RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:file=-`,
    "-f", "null", "-",
  ]);

  const seconds: Second[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("frame:")) {
      seconds.push([]);
      continue;
    }
    const match = /^lavfi\.astats\.(\d+)\.RMS_level=(.+)$/.exec(line);
    if (match != null && seconds.length > 0) {
      const value = match[2] === "-inf" ? -Infinity : Number(match[2]);
      seconds[seconds.length - 1][Number(match[1]) - 1] = value;
    }
  }
  return seconds;
}

/** A clip of `source`, taking `[fromMs, fromMs + lengthMs)` and placed at `atMs`. */
function clip(source: Source, atMs: number, fromMs: number, lengthMs: number) {
  return audioElement({
    localpath: sourcePath(source),
    startTime: atMs,
    duration: lengthMs,
    trim: { startTime: fromMs, endTime: fromMs + lengthMs },
    sourceDuration: SOURCE_SEC * 1000,
  });
}

function argsFor(
  clips: Record<string, any>,
  durationSec: number,
  channels: 1 | 2,
): string[] {
  return buildFFmpegArgs(
    {
      videoDuration: durationSec,
      videoBitrate: 1000,
      videoDestination: path.join(dir, `out-${outputs++}.mov`),
      fps: FPS,
      previewSize: FRAME,
      exportSettings: {
        container: "mov",
        videoCodec: "prores",
        audioCodec: "pcm_s16le",
        sampleRate: RATE,
        channels,
      },
    },
    clips,
  );
}

/** Runs an argv exactly as the exporter would, and measures what it wrote. */
function exported(args: string[], durationSec: number): Second[] {
  const frames = Math.round(durationSec * FPS);
  const pipe = Buffer.alloc(frames * FRAME.w * FRAME.h * 4);
  run(["-hide_banner", "-loglevel", "error", ...args], pipe);
  return levelsOf(args[args.length - 1]);
}

/** Rewrites the `-filter_complex` value, for the cases that undo a fix. */
function withFilter(args: string[], edit: (graph: string) => string): string[] {
  const at = args.indexOf("-filter_complex") + 1;
  const copy = args.slice();
  copy[at] = edit(copy[at]);
  if (copy[at] === args[at]) {
    throw new Error(`the edit changed nothing in ${args[at]}`);
  }
  // A fresh destination, so the two runs never read each other's file.
  copy[copy.length - 1] = path.join(dir, `out-${outputs++}.mov`);
  return copy;
}

/** `n` one-second pieces of the mono source, laid end to end. */
function pieces(n: number): Record<string, any> {
  const clips: Record<string, any> = {};
  for (let i = 0; i < n; i += 1) {
    clips[`p${i}`] = clip("mono", i * 1000, i * 1000, 1000);
  }
  return clips;
}

describe.skipIf(FFMPEG == null)("the exported mix, against its source", () => {
  /** The mono source's own level, which every assertion is relative to. */
  let source = 0;

  beforeAll(() => {
    const levels = levelsOf(sourcePath("mono"));
    source = levels[0][0];
    // The sources are what this file says they are.
    expect(source).toBeGreaterThan(-30);
    expect(levels[0]).toHaveLength(1);
    const left = levelsOf(sourcePath("left"))[0];
    expect(left[0]).toBeCloseTo(source, 2);
    expect(left[1]).toBe(-Infinity);
  });

  it.each([1, 3, 10])(
    "plays a clip cut into %i pieces at its source level throughout",
    (n) => {
      const levels = exported(argsFor(pieces(n), n, 2), n);
      expect(levels).toHaveLength(n);
      for (const [second, [l, r]] of levels.entries()) {
        expect(Math.abs(l - source), `second ${second}, left`).toBeLessThan(TOLERANCE_DB);
        expect(Math.abs(r - source), `second ${second}, right`).toBeLessThan(TOLERANCE_DB);
      }
    },
    30_000,
  );

  it("plays a mono clip at its source level on both sides", () => {
    const [[l, r]] = exported(argsFor({ a: clip("mono", 0, 0, 1000) }, 1, 2), 1);
    expect(Math.abs(l - source)).toBeLessThan(TOLERANCE_DB);
    expect(Math.abs(r - source)).toBeLessThan(TOLERANCE_DB);
  });

  it("keeps a stereo clip's image when a mono clip shares the project", () => {
    // Left to negotiation, the mono clip made the whole mix mono, and the
    // left-only clip came out on both sides at 6 dB down.
    const levels = exported(
      argsFor(
        { m: clip("mono", 0, 0, 1000), s: clip("left", 1000, 0, 1000) },
        2,
        2,
      ),
      2,
    );
    const [[monoL, monoR], [stereoL, stereoR]] = levels;
    expect(Math.abs(monoL - source)).toBeLessThan(TOLERANCE_DB);
    expect(Math.abs(monoR - source)).toBeLessThan(TOLERANCE_DB);
    expect(Math.abs(stereoL - source)).toBeLessThan(TOLERANCE_DB);
    expect(stereoR).toBe(-Infinity);
  });

  it("plays mono and stereo clips at their source level in a mono export", () => {
    // Left to swresample, the float downmix summed both sides at 0.707 and a
    // stereo clip came out 3 dB louder than it went in.
    const levels = exported(
      argsFor(
        { m: clip("mono", 0, 0, 1000), s: clip("dual", 1000, 0, 1000) },
        2,
        1,
      ),
      2,
    );
    expect(levels).toHaveLength(2);
    for (const [channel] of levels) {
      expect(Math.abs(channel - source)).toBeLessThan(TOLERANCE_DB);
    }
  });

  it("measures the input-count loss when normalize=0 is taken away", () => {
    // 20 * log10(3) is 9.54 dB, on the first piece, before any input ends.
    const args = argsFor(pieces(3), 3, 2);
    const undone = withFilter(args, (graph) => graph.replace(":normalize=0", ""));
    const [[l]] = exported(undone, 3);
    expect(source - l).toBeGreaterThan(9.4);
    expect(source - l).toBeLessThan(9.7);
  });

  it("measures the upmix loss when the layout stage is taken away", () => {
    // swresample upmixes mono at `M_SQRT1_2`, which is 3.01 dB.
    const args = argsFor({ a: clip("mono", 0, 0, 1000) }, 1, 2);
    const undone = withFilter(args, (graph) =>
      graph.replace("pan=stereo|FL=FL+FC|FR=FR+FC,", ""),
    );
    const [[l, r]] = exported(undone, 1);
    expect(source - l).toBeGreaterThan(2.9);
    expect(source - r).toBeGreaterThan(2.9);
  });
});
