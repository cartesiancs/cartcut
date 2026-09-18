/**
 * A ramped clip through the **whole** export argv, on the bundled FFmpeg.
 *
 * `speedStretch.parity.test.ts` measures the WAV the pre-pass writes.
 * `ffmpegArgs.test.ts` pins the argv it produces. Neither runs the two
 * together, and the e2e spec that renders a ramp uses the frame-index
 * instrument, which is silent: nothing was exercising the case this feature
 * exists for, a clip with **sound** that ramps, all the way to a delivered file.
 *
 * So this builds a real source, runs `prepareRenderedAudio` on it, hands the
 * result to `buildFFmpegArgs`, pipes frames on stdin as the app does, and
 * measures the file that comes out with `silencedetect`, which shares no code
 * with any of it.
 *
 * `audioMix.parity.test.ts` is the model, down to the PCM in a `.mov` so no
 * lossy codec sits between the two measurements.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFFmpegArgs } from "./ffmpegArgs";
import { prepareRenderedAudio, type RenderedAudioSet } from "./renderedAudio";
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
const RATE = 48_000;
const FPS = 10;
const FRAME = { w: 16, h: 16 };
const SOURCE_MS = 8000;
/** 300ms of tone at each of these source instants, silence between. */
const BURSTS_MS = [500, 3000, 5500, 7500];
const BURST_MS = 300;

/** Slow in, fast out, so one export covers both directions. */
const RAMP: SpeedPoint[] = [
  { t: 0, v: 1 },
  { t: 3000, v: 0.4 },
  { t: 5500, v: 3 },
  { t: SOURCE_MS, v: 1 },
];

let dir = "";
let source = "";

function run(args: string[], input?: Buffer) {
  const result = spawnSync(FFMPEG as string, args, {
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stderr: result.stderr?.toString("utf8") ?? "",
    stdout: result.stdout ?? Buffer.alloc(0),
  };
}

beforeAll(() => {
  if (FFMPEG == null) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-ramped-mix-"));
  source = path.join(dir, "bursts.wav");
  const gate = BURSTS_MS.map(
    (at) => `between(t,${at / 1000},${(at + BURST_MS) / 1000})`,
  ).join("+");
  const built = run([
    "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi",
    "-i", `sine=frequency=1000:sample_rate=${RATE}:duration=${SOURCE_MS / 1000}`,
    "-af", `volume=eval=frame:volume='${gate}'`,
    "-c:a", "pcm_s16le",
    source,
  ]);
  if (built.status !== 0) {
    throw new Error(`fixture build failed: ${built.stderr}`);
  }
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One audible clip, ramped or not, as the timeline holds it. */
function timelineWith(points: SpeedPoint[] | null, startTime = 0) {
  return {
    a: {
      filetype: "audio",
      localpath: source,
      startTime,
      duration: SOURCE_MS,
      trim: { startTime: 0, endTime: SOURCE_MS },
      sourceDuration: SOURCE_MS,
      speed:
        points == null
          ? 1
          : SOURCE_MS / curveSpanLength(prepareSpeedCurve(points), 0, SOURCE_MS),
      ...(points != null ? { speedCurve: points } : {}),
      volumeDb: 0,
    },
  } as Record<string, any>;
}

/** Runs the real argv with frames on stdin, and returns the delivered path. */
function exportWith(
  timeline: Record<string, any>,
  rendered: RenderedAudioSet,
  durationSec: number,
  name: string,
): string {
  const destination = path.join(dir, `${name}.mov`);
  const args = buildFFmpegArgs(
    {
      videoDuration: durationSec,
      videoBitrate: 1000,
      videoDestination: destination,
      fps: FPS,
      previewSize: FRAME,
      exportSettings: {
        container: "mov",
        videoCodec: "prores",
        audioCodec: "pcm_s16le",
        sampleRate: RATE,
        channels: 1,
      },
    } as any,
    timeline,
    rendered.byElementId,
  );
  const frames = Math.round(durationSec * FPS);
  const pipe = Buffer.alloc(frames * FRAME.w * FRAME.h * 4);
  const result = run(["-hide_banner", "-loglevel", "error", ...args], pipe);
  if (result.status !== 0) {
    throw new Error(`export failed: ${result.stderr}`);
  }
  return destination;
}

/**
 * Where the loud stretches begin, in output ms, by FFmpeg's own detector.
 *
 * Each onset is a `silence_end` that a later `silence_start` closes. The pairing
 * is what drops the last one: at EOF the detector closes its books with a
 * `silence_end` for the trailing silence, which is not an onset and which made
 * every case here count five bursts in a file that has four.
 */
function burstStarts(file: string): number[] {
  const result = run([
    "-nostdin", "-hide_banner",
    "-i", file,
    "-af", "silencedetect=noise=-40dB:d=0.05",
    "-f", "null", "-",
  ]);
  const ends = [...result.stderr.matchAll(/silence_end: ([0-9.]+)/g)].map(
    (match) => Number(match[1]) * 1000,
  );
  const starts = [...result.stderr.matchAll(/silence_start: ([0-9.]+)/g)].map(
    (match) => Number(match[1]) * 1000,
  );
  return ends.filter((at) => starts.some((start) => start > at));
}

describe.skipIf(FFMPEG == null)("a ramped clip with sound, exported", () => {
  it("lands every burst where the ramp's integral puts it", async () => {
    const timeline = timelineWith(RAMP);
    const rendered = await prepareRenderedAudio(
      FFMPEG as string,
      timeline,
      { sampleRate: RATE, channels: 1 },
      dir,
    );
    expect(rendered.byElementId.has("a")).toBe(true);

    const curve = prepareSpeedCurve(RAMP);
    const spanMs = curveSpanLength(curve, 0, SOURCE_MS);
    const file = exportWith(timeline, rendered, spanMs / 1000, "ramped");

    const found = burstStarts(file);
    const wanted = BURSTS_MS.map((at) => curveSpanLength(curve, 0, at));
    expect(found.length).toBe(wanted.length);
    found.forEach((at, index) => {
      expect(Math.abs(at - wanted[index])).toBeLessThan(WINDOW_MS * 2);
    });
  });

  it("carries the clip's timeline offset, which adelay still owns", async () => {
    // The pre-pass writes the clip's window and nothing else, so where the clip
    // sits is still `adelay`'s job. A pre-pass that had baked the offset in
    // would double it, and this is the only place that would show.
    const offsetMs = 2000;
    const timeline = timelineWith(RAMP, offsetMs);
    const rendered = await prepareRenderedAudio(
      FFMPEG as string,
      timeline,
      { sampleRate: RATE, channels: 1 },
      dir,
    );
    const curve = prepareSpeedCurve(RAMP);
    const spanMs = curveSpanLength(curve, 0, SOURCE_MS);
    const file = exportWith(
      timeline,
      rendered,
      (offsetMs + spanMs) / 1000,
      "ramped-late",
    );

    const found = burstStarts(file);
    const wanted = BURSTS_MS.map(
      (at) => offsetMs + curveSpanLength(curve, 0, at),
    );
    expect(found.length).toBe(wanted.length);
    found.forEach((at, index) => {
      expect(Math.abs(at - wanted[index])).toBeLessThan(WINDOW_MS * 2);
    });
  });

  it("is unchanged for a clip with no ramp", async () => {
    // The regression budget for the whole pre-pass: a project nobody has ramped
    // takes an empty map, no extra spawn, and the argv it always had.
    const timeline = timelineWith(null);
    const rendered = await prepareRenderedAudio(
      FFMPEG as string,
      timeline,
      { sampleRate: RATE, channels: 1 },
      dir,
    );
    expect(rendered.byElementId.size).toBe(0);
    expect(rendered.directory).toBeNull();

    const file = exportWith(timeline, rendered, SOURCE_MS / 1000, "plain");
    const found = burstStarts(file);
    expect(found.length).toBe(BURSTS_MS.length);
    found.forEach((at, index) => {
      expect(Math.abs(at - BURSTS_MS[index])).toBeLessThan(30);
    });
  });

  it("the measurement disagrees when the ramp is not applied", async () => {
    // Prove the harness measures something: the same source exported flat, held
    // to the ramped expectation, has to fail loudly.
    const timeline = timelineWith(null);
    const rendered = await prepareRenderedAudio(
      FFMPEG as string,
      timeline,
      { sampleRate: RATE, channels: 1 },
      dir,
    );
    const file = exportWith(timeline, rendered, SOURCE_MS / 1000, "flat");

    const curve = prepareSpeedCurve(RAMP);
    const wanted = BURSTS_MS.map((at) => curveSpanLength(curve, 0, at));
    const found = burstStarts(file);
    const worst = found.reduce(
      (most, at, index) => Math.max(most, Math.abs(at - wanted[index])),
      0,
    );
    expect(worst).toBeGreaterThan(WINDOW_MS * 10);
  });
});
