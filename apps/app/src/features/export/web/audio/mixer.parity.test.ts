/**
 * The browser export's mix against the desktop export's, sample by sample.
 *
 * The reference is the bundled ffmpeg running the desktop export's own audio
 * chain: the exact `-ss`, `-t` and `-i` per clip from `collectAudioInputs`,
 * the exact filter strings from `audioFilterFor`, and the same `amix`. The
 * subject is `AudioMix` over a port that hands it the same source samples. The
 * two share no DSP code, so agreement means the arithmetic matches, not that
 * one copy was compared with itself.
 *
 * Sources are 32-bit float WAVs, so no quantisation sits between the sides.
 *
 * ## It proves it is measuring something
 *
 * The last case moves one clip by ten milliseconds on one side only and
 * requires the comparison to fail by a wide margin.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  audioFilterFor,
  collectAudioInputs,
} from "../../../../../../../electron/render/ffmpegArgs";
import { prepareRenderedAudio } from "../../../../../../../electron/render/renderedAudio";
import { addKeyframe, setTrackActive } from "../../../animation/keyframeOps";
import { audioElement } from "../../../renderer/testing";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../../../timeline/tracks";
import { planAudio } from "./audioPlan";
import { AudioMix, type PcmChunk, type PcmPort } from "./mixer";

const REPO_ROOT = path.resolve(__dirname, "../../../../../../..");

function ffmpegPath(): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join(REPO_ROOT, "bin", dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return fs.existsSync(binary) ? binary : null;
}

const FFMPEG = ffmpegPath();
const SOURCE_SEC = 8;

const SOURCES = {
  mono: { graph: "sine=frequency=440:sample_rate=48000", channels: 1, rate: 48000 },
  left: {
    graph:
      "sine=frequency=330:sample_rate=48000[l];" +
      "anullsrc=channel_layout=mono:sample_rate=48000[r];" +
      "[l][r]join=inputs=2:channel_layout=stereo",
    channels: 2,
    rate: 48000,
  },
  cd: { graph: "sine=frequency=550:sample_rate=44100", channels: 1, rate: 44100 },
} as const;
type Source = keyof typeof SOURCES;

let dir = "";

function run(args: string[]): Buffer {
  const result = spawnSync(FFMPEG!, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status}:\n${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout;
}

const sourcePath = (source: Source) => path.join(dir, `${source}.wav`);

beforeAll(() => {
  if (FFMPEG == null) {
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-webmix-"));
  for (const [name, { graph }] of Object.entries(SOURCES)) {
    run([
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", graph,
      "-t", `${SOURCE_SEC}`,
      "-c:a", "pcm_f32le",
      sourcePath(name as Source),
    ]);
  }
});

afterAll(() => {
  if (dir !== "") {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Interleaved f32 into planes. */
function planar(buffer: Buffer, channels: number): Float32Array[] {
  const samples = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength - (buffer.byteLength % 4)),
  );
  const frames = Math.floor(samples.length / channels);
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      planes[c][i] = samples[i * channels + c];
    }
  }
  return planes;
}

/** The source's own samples, as a decoder would hand them over: in 1000-frame chunks. */
function filePort(): PcmPort {
  const cache = new Map<string, { planes: Float32Array[]; rate: number }>();
  const load = (localpath: string) => {
    let entry = cache.get(localpath);
    if (entry == null) {
      const source = (Object.keys(SOURCES) as Source[]).find((name) => sourcePath(name) === localpath)!;
      const { channels, rate } = SOURCES[source];
      const raw = run(["-nostdin", "-hide_banner", "-loglevel", "error", "-i", localpath, "-f", "f32le", "-"]);
      entry = { planes: planar(raw, channels), rate };
      cache.set(localpath, entry);
    }
    return entry;
  };
  return {
    async *read(localpath, fromSec, durationSec): AsyncGenerator<PcmChunk> {
      const { planes, rate } = load(localpath);
      const from = Math.round(fromSec * rate);
      const to = Math.min(planes[0].length, from + Math.round(durationSec * rate));
      for (let at = from; at < to; at += 1000) {
        const end = Math.min(to, at + 1000);
        yield { planes: planes.map((plane) => plane.slice(at, end)), sampleRate: rate };
      }
    },
  };
}

/**
 * The desktop export's audio chain, run by ffmpeg, as planar f32. A ramped
 * clip goes through the desktop pre-pass first (`prepareRenderedAudio`) and
 * enters as the WAV it writes, exactly as `buildFFmpegArgs` takes it.
 */
async function desktopMix(timeline: Record<string, any>, rate: number, channels: 1 | 2, totalSec: number) {
  const rendered = await prepareRenderedAudio(FFMPEG!, timeline, { sampleRate: rate, channels }, dir);
  const inputs = collectAudioInputs(timeline, rendered.byElementId);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  const chains: string[] = [];
  const labels: string[] = [];
  inputs.forEach((input, index) => {
    if (input.rendered != null) {
      args.push("-i", input.rendered.path);
    } else {
      args.push("-ss", `${input.ssSec}`, "-t", `${input.tSec}`, "-i", input.localpath);
    }
    chains.push(audioFilterFor(input, index, `audio${index}`, channels));
    labels.push(`[audio${index}]`);
  });
  chains.push(
    labels.length > 1
      ? `${labels.join("")}amix=inputs=${labels.length}:normalize=0[aout]`
      : `${labels[0]}aresample=async=1[aout]`,
  );
  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[aout]",
    "-ar", `${rate}`, "-ac", `${channels}`,
    "-t", `${totalSec}`,
    "-f", "f32le", "-",
  );
  return planar(run(args), channels);
}

async function webMix(timeline: Record<string, any>, rate: number, channels: 1 | 2, totalSec: number) {
  const mix = new AudioMix(planAudio(timeline), filePort(), {
    sampleRate: rate,
    channels,
    totalFrames: Math.round(totalSec * rate),
  });
  const planes = Array.from({ length: channels }, () => [] as number[]);
  for (;;) {
    // An odd block size, so clip edges and envelope blocks fall inside blocks.
    const block = await mix.next(4801);
    if (block == null) {
      break;
    }
    block.forEach((plane, c) => planes[c].push(...plane));
  }
  await mix.close();
  return planes.map((plane) => Float32Array.from(plane));
}

/** The largest absolute difference over the frames both sides have. */
function worstDifference(a: Float32Array[], b: Float32Array[]): number {
  let worst = 0;
  for (let c = 0; c < a.length; c++) {
    const n = Math.min(a[c].length, b[c].length);
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(a[c][i] - b[c][i]));
    }
  }
  return worst;
}

/** Residual power against signal power, in dB. */
function residualDb(reference: Float32Array[], subject: Float32Array[], skip = 0): number {
  let signal = 0;
  let error = 0;
  for (let c = 0; c < reference.length; c++) {
    const n = Math.min(reference[c].length, subject[c].length);
    for (let i = skip; i < n - skip; i++) {
      signal += reference[c][i] ** 2;
      error += (reference[c][i] - subject[c][i]) ** 2;
    }
  }
  return 10 * Math.log10(error / signal);
}

function rmsDb(plane: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += plane[i] ** 2;
  }
  return 10 * Math.log10(sum / (to - from));
}

function placedDocument(overrides: Record<string, any> = {}) {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("a1", "audio", 0), createTrack("a2", "audio", 1)],
    elements: {
      tone: audioElement({
        trackId: "a1",
        localpath: sourcePath("mono"),
        startTime: 500,
        duration: 3000,
        trim: { startTime: 1000, endTime: 4000 },
        sourceDuration: SOURCE_SEC * 1000,
        ...overrides.tone,
      }),
      side: audioElement({
        trackId: "a2",
        localpath: sourcePath("left"),
        startTime: 2000,
        duration: 2500,
        trim: { startTime: 0, endTime: 2500 },
        sourceDuration: SOURCE_SEC * 1000,
        volumeDb: -9,
        ...overrides.side,
      } as any),
    },
  });
}

describe.skipIf(FFMPEG == null)("AudioMix against the desktop export's ffmpeg graph", () => {
  it("places, levels and sums two clips to the sample, in stereo", async () => {
    const timeline = placedDocument().elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 2, 5);
    const subject = await webMix(timeline, 48000, 2, 5);
    expect(subject[0].length).toBe(5 * 48000);
    expect(worstDifference(reference, subject)).toBeLessThan(1e-6);
  });

  it("folds stereo to mono as the mean, and keeps a mono clip at unity", async () => {
    const timeline = placedDocument().elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 1, 5);
    const subject = await webMix(timeline, 48000, 1, 5);
    expect(worstDifference(reference, subject)).toBeLessThan(1e-6);
  });

  it("follows a keyframed level in 256-sample steps, as volume=eval=frame does", async () => {
    let doc = placedDocument();
    doc = setTrackActive(doc, "tone", "volumeDb", true, { atMs: 0 }, 60);
    doc = addKeyframe(doc, "tone", "volumeDb", "x", 0, 0, 0, 60);
    doc = addKeyframe(doc, "tone", "volumeDb", "x", 2000, -30, 0, 60);
    const timeline = doc.elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 2, 5);
    const subject = await webMix(timeline, 48000, 2, 5);
    // Measured at 3.4e-8: float rounding, nothing more.
    expect(worstDifference(reference, subject)).toBeLessThan(1e-6);
  });

  it("resamples a 44.1kHz clip into a 48kHz mix as closely as swresample does", async () => {
    const timeline = placedDocument({ tone: { localpath: sourcePath("cd") } }).elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 2, 5);
    const subject = await webMix(timeline, 48000, 2, 5);
    // Two different filters, so agreement is residual power, with the first
    // and last 10ms (the filters' edges) aside. Measured at -96 dB.
    expect(residualDb(reference, subject, 480)).toBeLessThan(-80);
  });

  it("retimes a 2x clip to the same length and level as atempo, pitch kept", async () => {
    const timeline = placedDocument({
      tone: { speed: 2, duration: 3000, trim: { startTime: 1000, endTime: 4000 } },
      side: { volumeDb: -60 },
    }).elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 2, 4);
    const subject = await webMix(timeline, 48000, 2, 4);
    // The clip sounds from 0.5s for 1.5s. Compare the level of each 250ms
    // inside it, and the silence after it.
    for (let start = 0.75; start < 1.75; start += 0.25) {
      const from = Math.round(start * 48000);
      const to = from + 12000;
      expect(Math.abs(rmsDb(reference[0], from, to) - rmsDb(subject[0], from, to))).toBeLessThan(0.5);
    }
    expect(rmsDb(subject[0], Math.round(2.1 * 48000), Math.round(3.9 * 48000))).toBe(-Infinity);
  });

  it("retimes a speed ramp exactly as the desktop pre-pass does", async () => {
    const timeline = placedDocument({
      tone: {
        speed: 1.44,
        duration: 3000,
        trim: { startTime: 1000, endTime: 4000 },
        speedCurve: [
          { t: 1000, v: 1 },
          { t: 4000, v: 2 },
        ],
      },
    }).elements as Record<string, any>;
    const reference = await desktopMix(timeline, 48000, 2, 5);
    const subject = await webMix(timeline, 48000, 2, 5);
    // Same stretch, same samples in: the decode and the float WAV are all
    // that sit between the sides.
    expect(worstDifference(reference, subject)).toBeLessThan(1e-5);
  });

  it("is a harness that can disagree: a clip ten milliseconds late fails it", async () => {
    const reference = await desktopMix(placedDocument().elements as Record<string, any>, 48000, 2, 5);
    const moved = placedDocument({ tone: { startTime: 510 } }).elements as Record<string, any>;
    const subject = await webMix(moved, 48000, 2, 5);
    expect(worstDifference(reference, subject)).toBeGreaterThan(0.05);
  });
});
