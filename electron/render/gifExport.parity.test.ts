/**
 * A GIF export, run for real.
 *
 * `ffmpegArgs.test.ts` and `exportSettings.test.ts` pin the strings; this runs
 * the **whole argv `buildFFmpegArgs` returns** through the bundled ffmpeg, fed
 * raw RGBA frames on stdin exactly as the renderer feeds them, and reads the
 * GIF back with ffprobe and ffmpeg's own decoder: its size, its frame count,
 * how long it plays, and that its pictures are the ones that went in. Both
 * palette modes run, since only one of them is exercised by a short export.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFFmpegArgs } from "./ffmpegArgs";
import { gifFilterGraph, gifPlan, normalizeExportSettings } from "./exportSettings";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The bundled binaries for this machine, by the rule `electron/lib/ffmpeg.ts` uses. */
function binary(name: "ffmpeg" | "ffprobe"): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const file = path.join(REPO_ROOT, "bin", dir, process.platform === "win32" ? `${name}.exe` : name);
  return fs.existsSync(file) ? file : null;
}

const FFMPEG = binary("ffmpeg");
const FFPROBE = binary("ffprobe");

const SIZE = { w: 640, h: 360 };
const FPS = 30;
const DURATION = 1;

/**
 * One second of frames: a grey ground with a red square crossing it, so each
 * frame differs from the last and a GIF that froze or dropped frames shows.
 */
function frames(): Buffer {
  const count = DURATION * FPS;
  const frame = SIZE.w * SIZE.h * 4;
  const out = Buffer.alloc(count * frame);
  for (let n = 0; n < count; n++) {
    const left = Math.round((n / count) * (SIZE.w - 120));
    for (let y = 0; y < SIZE.h; y++) {
      for (let x = 0; x < SIZE.w; x++) {
        const at = n * frame + (y * SIZE.w + x) * 4;
        const square = x >= left && x < left + 120 && y >= 120 && y < 240;
        out[at] = square ? 230 : 64;
        out[at + 1] = square ? 30 : 64;
        out[at + 2] = square ? 30 : 64;
        out[at + 3] = 255;
      }
    }
  }
  return out;
}

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-gif-export-"));
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function run(bin: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(bin, args, { input, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${path.basename(bin)} exited ${result.status}:\n${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout;
}

function probe(file: string) {
  const json = JSON.parse(
    run(FFPROBE!, [
      "-v", "error", "-count_frames",
      "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration,format_name",
      "-of", "json", file,
    ]).toString(),
  );
  return {
    streams: json.streams as { codec_name: string; width: number; height: number; nb_read_frames: string }[],
    format: json.format as { format_name: string; duration: string },
  };
}

/** The decoded GIF's frames, as RGB24. */
function decode(file: string, w: number, h: number): Buffer[] {
  const raw = run(FFMPEG!, ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = w * h * 3;
  const out: Buffer[] = [];
  for (let at = 0; at + size <= raw.length; at += size) {
    out.push(raw.subarray(at, at + size));
  }
  return out;
}

function pixel(frame: Buffer, w: number, x: number, y: number): number[] {
  const at = (y * w + x) * 3;
  return [frame[at], frame[at + 1], frame[at + 2]];
}

describe.skipIf(FFMPEG == null || FFPROBE == null)("a GIF export through the bundled ffmpeg", () => {
  const options = (destination: string) => ({
    videoDuration: DURATION,
    videoBitrate: 0,
    videoDestination: destination,
    fps: FPS,
    previewSize: SIZE,
    exportSettings: normalizeExportSettings({ videoCodec: "gif", gifFps: 15, gifWidth: 320 }),
  });

  /** Runs `args` with the frames on stdin and checks what comes out. */
  function check(file: string, args: string[]) {
    run(FFMPEG!, ["-v", "error", "-y", ...args], frames());

    expect(fs.readFileSync(file).subarray(0, 6).toString("latin1")).toBe("GIF89a");
    const { streams, format } = probe(file);
    // A picture and nothing else: no sound, which GIF cannot carry.
    expect(streams).toHaveLength(1);
    expect(format.format_name).toBe("gif");
    expect(streams[0]).toMatchObject({ codec_name: "gif", width: 320, height: 180 });
    // 15 frames for a second at 15 fps, each held for its share of the second.
    expect(Number(streams[0].nb_read_frames)).toBe(15);
    expect(Number(format.duration)).toBeCloseTo(1, 1);

    const decoded = decode(file, 320, 180);
    expect(decoded).toHaveLength(15);
    const red = (rgb: number[]) => rgb[0] > 180 && rgb[1] < 80 && rgb[2] < 80;
    const grey = (rgb: number[]) => Math.max(...rgb.map((c) => Math.abs(c - 64))) <= 8;
    // The ground stays grey and the square stays red through the palette, and
    // the square crosses: on the left in the first frame (source frame 0, at
    // x 0 to 60 once halved) and on the right in the last (source frame 28,
    // at x 243 to 303), so these are the frames that went in, in order.
    expect(grey(pixel(decoded[0], 320, 300, 20))).toBe(true);
    expect(red(pixel(decoded[0], 320, 15, 90))).toBe(true);
    expect(grey(pixel(decoded[0], 320, 270, 90))).toBe(true);
    expect(red(pixel(decoded[14], 320, 270, 90))).toBe(true);
    expect(grey(pixel(decoded[14], 320, 15, 90))).toBe(true);
  }

  it("writes a looping GIF of the right size, rate and pictures with one palette", () => {
    const file = path.join(dir, "global.gif");
    const args = buildFFmpegArgs(options(file), {});
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("stats_mode=single");
    check(file, args);
  });

  it("writes the same GIF, one palette a frame, once the budget is spent", () => {
    const file = path.join(dir, "streamed.gif");
    const args = buildFFmpegArgs(options(file), {});
    const settings = normalizeExportSettings({ videoCodec: "gif", gifFps: 15, gifWidth: 320 });
    const streamed = gifFilterGraph({
      ...gifPlan(settings, { fps: FPS, size: SIZE, durationSec: DURATION }),
      globalPalette: false,
    });
    expect(streamed).toContain("stats_mode=single");
    args[args.indexOf("-filter_complex") + 1] = streamed;
    check(file, args);
  });
});
