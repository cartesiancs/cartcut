/**
 * The ramp measured against the bundled FFmpeg, on a real file.
 *
 * `speedStretch.test.ts` proves the stretcher's arithmetic. This proves the
 * thing that actually ships: a ramped clip decoded by the real binary, retimed
 * by the real pre-pass, written to a real WAV, and measured by an FFmpeg filter
 * that shares no code with any of it. What it checks is the one property the
 * export rests on, that a sound at a known **source** instant comes out at the
 * **timeline** instant the ramp's integral puts it at.
 *
 * The last case hands the detector a different ramp's predictions and requires
 * it to fail. Without it a harness that silently measured an un-retimed file
 * would pass everything above.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareRenderedAudio } from "./renderedAudio";
import { curveSpanLength, prepareSpeedCurve, type SpeedPoint } from "./speedCurve";
import { WINDOW_MS } from "./speedStretch";

const REPO_ROOT = path.resolve(__dirname, "../..");

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
const SOURCE_MS = 12_000;
/** Bursts at these source instants, each 400ms of 1kHz tone. */
const BURSTS_MS = [1000, 4000, 7000, 10_000];
const BURST_MS = 400;

let scratch = "";
let sourceFile = "";

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(FFMPEG as string, args, { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

/**
 * A twelve-second file: silence with four 1kHz bursts at known instants.
 *
 * Built as one `volume` expression rather than as a concat, so the burst edges
 * are exact sample boundaries and nothing in the fixture can drift.
 */
function buildSource(destination: string): void {
  const gate = BURSTS_MS.map(
    (at) => `between(t,${at / 1000},${(at + BURST_MS) / 1000})`,
  ).join("+");
  const result = run([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:sample_rate=48000:duration=${SOURCE_MS / 1000}`,
    "-af",
    `volume=eval=frame:volume='${gate}'`,
    "-c:a",
    "pcm_s16le",
    destination,
  ]);
  if (result.status !== 0) {
    throw new Error(`fixture build failed: ${result.stderr}`);
  }
}

/** Where the loud stretches start and end in a file, by FFmpeg's own detector. */
function detectBursts(file: string): Array<{ start: number; end: number }> {
  const result = run([
    "-hide_banner",
    "-i",
    file,
    "-af",
    "silencedetect=noise=-40dB:d=0.05",
    "-f",
    "null",
    "-",
  ]);
  const text = result.stderr;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of text.matchAll(/silence_end: ([0-9.]+)/g)) {
    starts.push(Number(match[1]) * 1000);
  }
  for (const match of text.matchAll(/silence_start: ([0-9.]+)/g)) {
    ends.push(Number(match[1]) * 1000);
  }
  // A leading silence ends where the first burst begins; the silence that
  // follows it begins where that burst ends.
  const bursts: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const end = ends.find((value) => value > starts[i]);
    if (end != null) {
      bursts.push({ start: starts[i], end });
    }
  }
  return bursts;
}

/**
 * How long a file actually is, by decoding it and counting the bytes.
 *
 * Not ffmpeg's `time=` line, which was the first attempt: it is printed to a
 * hundredth of a second, so it reported every one of these files as up to 10ms
 * wrong and the assertion below could never have been tighter than the
 * rounding. Not `ffprobe -count_samples` either, which version 9 has dropped.
 *
 * Decoding to raw floats and counting reads the payload rather than the header
 * this pre-pass wrote, so a `data` chunk that claims more samples than the file
 * carries fails here rather than in somebody's export.
 */
function decodedFrames(file: string, channels: number): number {
  const result = spawnSync(
    FFMPEG as string,
    ["-v", "error", "-i", file, "-f", "f32le", "-"],
    { maxBuffer: 1 << 28 },
  );
  if (result.status !== 0) {
    throw new Error(`could not decode ${file}: ${result.stderr}`);
  }
  return result.stdout.length / (4 * channels);
}

function durationMs(file: string, channels = 1, rate = 48_000): number {
  return (decodedFrames(file, channels) / rate) * 1000;
}

/** A ramped clip covering the whole fixture, as the timeline would hold it. */
function rampedTimeline(points: SpeedPoint[]) {
  return {
    a: {
      filetype: "audio",
      localpath: sourceFile,
      startTime: 0,
      duration: SOURCE_MS,
      trim: { startTime: 0, endTime: SOURCE_MS },
      sourceDuration: SOURCE_MS,
      speed: 1,
      speedCurve: points,
    },
  };
}

/** Where the ramp says each burst edge lands on the timeline. */
function predict(points: SpeedPoint[]): Array<{ start: number; end: number }> {
  const curve = prepareSpeedCurve(points);
  return BURSTS_MS.map((at) => ({
    start: curveSpanLength(curve, 0, at),
    end: curveSpanLength(curve, 0, at + BURST_MS),
  }));
}

describe.skipIf(FFMPEG == null)("the ramp pre-pass, against the bundled FFmpeg", () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-ramp-parity-"));
    sourceFile = path.join(scratch, "bursts.wav");
    buildSource(sourceFile);
  });

  afterAll(() => {
    if (scratch !== "") {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  const shapes: Array<[string, SpeedPoint[]]> = [
    [
      "a ramp up",
      [
        { t: 0, v: 1 },
        { t: SOURCE_MS, v: 2 },
      ],
    ],
    [
      "a ramp down",
      [
        { t: 0, v: 2 },
        { t: SOURCE_MS, v: 0.5 },
      ],
    ],
    [
      "a slow middle",
      [
        { t: 0, v: 2 },
        { t: SOURCE_MS / 2, v: 0.25 },
        { t: SOURCE_MS, v: 2 },
      ],
    ],
    [
      "the full range",
      [
        { t: 0, v: 0.25 },
        { t: SOURCE_MS, v: 4 },
      ],
    ],
  ];

  it.each(shapes)("delivers %s at exactly the length the ramp asks for", async (_name, points) => {
    const set = await prepareRenderedAudio(
      FFMPEG as string,
      rampedTimeline(points),
      { sampleRate: 48_000, channels: 1 },
      scratch,
    );
    const rendered = set.byElementId.get("a");
    expect(rendered).toBeDefined();

    const want = curveSpanLength(prepareSpeedCurve(points), 0, SOURCE_MS);
    // To under a millisecond. The synthesis hop is fixed and the caller states
    // the frame count, so this is exact by construction rather than measured
    // luck; it is pinned because losing it means the clip slides in the mix.
    expect(Math.abs(durationMs(rendered!.path) - want)).toBeLessThan(1);

    fs.rmSync(set.directory as string, { recursive: true, force: true });
  });

  it.each(shapes)("puts every burst of %s where the ramp's integral says", async (_name, points) => {
    const set = await prepareRenderedAudio(
      FFMPEG as string,
      rampedTimeline(points),
      { sampleRate: 48_000, channels: 1 },
      scratch,
    );
    const rendered = set.byElementId.get("a")!;

    const found = detectBursts(rendered.path);
    const wanted = predict(points);
    expect(found.length).toBe(wanted.length);

    found.forEach((burst, index) => {
      // One analysis window of slack, which is the resolution a WSOLA edge has:
      // the segment carrying the burst's onset may be placed up to half a window
      // either side of the ideal instant.
      expect(Math.abs(burst.start - wanted[index].start)).toBeLessThan(WINDOW_MS);
      expect(Math.abs(burst.end - wanted[index].end)).toBeLessThan(WINDOW_MS);
    });

    fs.rmSync(set.directory as string, { recursive: true, force: true });
  });

  it("agrees with atempo where both are defined, at a constant rate", async () => {
    // The one case FFmpeg can also express. A constant curve is rejected as
    // flat, so this uses the shallowest ramp that is not: the two should land
    // within a window of each other everywhere.
    const nearly: SpeedPoint[] = [
      { t: 0, v: 2 },
      { t: SOURCE_MS, v: 2.000001 },
    ];
    const set = await prepareRenderedAudio(
      FFMPEG as string,
      rampedTimeline(nearly),
      { sampleRate: 48_000, channels: 1 },
      scratch,
    );
    const ours = set.byElementId.get("a")!.path;

    const theirs = path.join(scratch, "atempo.wav");
    const built = run([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourceFile,
      "-af",
      "atempo=2.0",
      "-c:a",
      "pcm_s16le",
      theirs,
    ]);
    expect(built.status).toBe(0);

    const mine = detectBursts(ours);
    const reference = detectBursts(theirs);
    expect(mine.length).toBe(reference.length);
    mine.forEach((burst, index) => {
      expect(Math.abs(burst.start - reference[index].start)).toBeLessThan(
        WINDOW_MS,
      );
    });

    fs.rmSync(set.directory as string, { recursive: true, force: true });
  });

  it("the detector disagrees when handed another ramp's predictions", async () => {
    const points: SpeedPoint[] = [
      { t: 0, v: 1 },
      { t: SOURCE_MS, v: 2 },
    ];
    const set = await prepareRenderedAudio(
      FFMPEG as string,
      rampedTimeline(points),
      { sampleRate: 48_000, channels: 1 },
      scratch,
    );
    const found = detectBursts(set.byElementId.get("a")!.path);
    const wrong = predict([
      { t: 0, v: 2 },
      { t: SOURCE_MS, v: 0.5 },
    ]);

    const worst = found.reduce(
      (most, burst, index) =>
        Math.max(most, Math.abs(burst.start - wrong[index].start)),
      0,
    );
    expect(worst).toBeGreaterThan(WINDOW_MS * 10);

    fs.rmSync(set.directory as string, { recursive: true, force: true });
  });
});
