/**
 * A template's sound in the delivered file, measured.
 *
 * The export used to hand FFmpeg the timeline with each template as one clip,
 * and a template clip is not audible, so music inside a template played in the
 * preview and was silent in the file. The exporter now hands it the timeline
 * with every template's own clips flattened in
 * (`template/compose.ts#expandTemplates`), and this runs that map through the
 * real `buildFFmpegArgs` and the bundled ffmpeg and reads the level back.
 *
 * It proves it measures something: the same project handed over unexpanded,
 * as it was before, has to come back silent.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFFmpegArgs } from "./ffmpegArgs";
// Reaching across the rootDir boundary is safe in a test file and nowhere else.
import { audioElement } from "../../apps/app/src/features/renderer/testing";
import { expandTemplates } from "../../apps/app/src/features/template/compose";
import { slotsOf } from "../../apps/app/src/features/template/slots";
import { createTemplateElement } from "../../apps/app/src/features/timeline/templateOps";

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
const RATE = 48000;
const FPS = 10;
const FRAME = { w: 16, h: 16 };
const DURATION_SEC = 6;

let dir = "";
let outputs = 0;

function run(args: string[], input?: Buffer): string {
  const result = spawnSync(FFMPEG!, args, {
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status}:\n${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout.toString("utf8");
}

const sine = () => path.join(dir, "sine.wav");

beforeAll(() => {
  if (FFMPEG == null) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-tplaudio-"));
  run([
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "10", "-c:a", "pcm_s16le", sine(),
  ]);
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** RMS per whole second of the first channel, `-Infinity` for silence. */
function levelsOf(file: string): number[] {
  const stdout = run([
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", file, "-map", "0:a",
    "-af", `asetnsamples=n=${RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:file=-`,
    "-f", "null", "-",
  ]);
  const seconds: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^lavfi\.astats\.1\.RMS_level=(.+)$/.exec(line);
    if (match != null) {
      seconds.push(match[1] === "-inf" ? -Infinity : Number(match[1]));
    }
  }
  return seconds;
}

function exported(timeline: Record<string, any>): number[] {
  const destination = path.join(dir, `out-${outputs++}.mov`);
  const args = buildFFmpegArgs(
    {
      videoDuration: DURATION_SEC,
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
  );
  const frames = Math.round(DURATION_SEC * FPS);
  run(["-hide_banner", "-loglevel", "error", ...args], Buffer.alloc(frames * FRAME.w * FRAME.h * 4));
  return levelsOf(destination);
}

/**
 * A project of one template clip, at 1s, whose bar is 3s long, holding 4s of
 * music: so the file should sound from 1s to 4s and nowhere else.
 */
function project() {
  const music = audioElement({
    key: "music",
    localpath: sine(),
    startTime: 0,
    duration: 4000,
    trim: { startTime: 0, endTime: 4000 },
    sourceDuration: 10_000,
  });
  const data = {
    id: "song",
    name: "Song",
    size: { w: 16, h: 16 },
    durationMs: 4000,
    elements: { music },
    slots: slotsOf({ music } as any),
  };
  const clip = {
    ...createTemplateElement({
      templateId: "song",
      name: "Song",
      durationMs: 3000,
      size: { w: 16, h: 16 },
      frame: FRAME,
    }),
    key: "tpl",
    trackId: "v",
    startTime: 1000,
  };
  return { timeline: { tpl: clip } as Record<string, any>, resolve: () => data as any };
}

describe.skipIf(FFMPEG == null)("a template's sound in the exported file", () => {
  it("sounds where the template's bar is, and nowhere else", () => {
    const { timeline, resolve } = project();
    const levels = exported(expandTemplates(timeline as any, resolve));
    expect(levels[0]).toBe(-Infinity);
    for (const second of [1, 2, 3]) {
      expect(levels[second]).toBeGreaterThan(-30);
    }
    // The music runs to 5s inside the template; the bar ends at 4s, so the
    // file holds no sound from there on (the mix may simply end there).
    expect(levels.slice(4).every((level) => level === -Infinity)).toBe(true);
  });

  it("sounds to the end of the music when the bar is as long as it", () => {
    // The other half of the claim above: with the bar long enough, the fifth
    // second does sound, so the silence above is the cut and not the mix.
    const { timeline, resolve } = project();
    const levels = exported(
      expandTemplates(
        { tpl: { ...timeline.tpl, duration: 4000 } } as any,
        resolve,
      ),
    );
    expect(levels[4]).toBeGreaterThan(-30);
  });

  it("was silent handed over unexpanded, which is what this fixed", () => {
    const { timeline } = project();
    const levels = exported(timeline);
    expect(levels.every((level) => level === -Infinity)).toBe(true);
  });
});
