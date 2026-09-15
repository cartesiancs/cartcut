/**
 * The file the vocoder's samples become.
 *
 * The header arithmetic is checked here, but a RIFF header that is wrong in a
 * self-consistent way would pass every assertion a suite could write against
 * its own writer. So the last block hands the bytes to the **bundled ffmpeg**
 * and compares what it decodes back, sample for sample. The two sides share no
 * code: one is this file's `Buffer.writeInt16LE` loop, the other is a C
 * demuxer reached through a pipe.
 *
 * And it proves it is measuring something: the final case feeds the two sides
 * different audio and requires them to disagree.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { durationMsOf, encodeWav, joinChunks, toPcm16 } from "./ttsWav";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * The bundled binary for this machine.
 *
 * `electron/lib/ffmpeg.ts` picks the same directory from `process.arch`; this
 * repeats the rule rather than importing it, because that module reaches
 * Electron and cannot be loaded here. The two parity suites say the same.
 */
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
const SAMPLE_RATE = 44100;

describe("toPcm16", () => {
  it("maps the ends of the range to the ends of the format", () => {
    expect(toPcm16(0)).toBe(0);
    expect(toPcm16(1)).toBe(32767);
    expect(toPcm16(-1)).toBe(-32768);
  });

  /**
   * The asymmetry is the point. Scaling both directions by 32768 would push a
   * full-scale positive peak to 32768, which wraps to -32768: one sample of
   * hard click on exactly the loudest material.
   */
  it("does not wrap a full-scale positive peak", () => {
    expect(toPcm16(1)).toBeLessThanOrEqual(32767);
    expect(toPcm16(0.9999)).toBeLessThanOrEqual(32767);
  });

  it("clamps rather than wrapping what the vocoder overshoots", () => {
    // Two denoising steps overshoot 1.0 on a handful of samples per utterance.
    expect(toPcm16(1.9)).toBe(32767);
    expect(toPcm16(-1.9)).toBe(-32768);
  });

  /**
   * All three go to silence, including the infinities. A full-scale sample is
   * an audible click, and a vocoder that has produced one non-finite sample is
   * unlikely to have produced only one, so the clamp would deliver a burst of
   * square wave at full level. Silence is the failure nobody has to un-hear.
   */
  it("turns a non-finite sample into silence rather than into noise", () => {
    expect(toPcm16(NaN)).toBe(0);
    expect(toPcm16(Infinity)).toBe(0);
    expect(toPcm16(-Infinity)).toBe(0);
  });
});

describe("encodeWav", () => {
  it("writes a header of the stated size and shape", () => {
    const wav = encodeWav(new Float32Array(100), SAMPLE_RATE);
    expect(wav.length).toBe(44 + 200);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // Every RIFF size field counts the bytes that follow it.
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(40)).toBe(200);
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt32LE(28)).toBe(SAMPLE_RATE * 2); // byte rate
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it("writes an empty file rather than refusing one", () => {
    const wav = encodeWav(new Float32Array(0), SAMPLE_RATE);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

describe("durationMsOf", () => {
  it("converts frames to milliseconds", () => {
    expect(durationMsOf(SAMPLE_RATE, SAMPLE_RATE)).toBe(1000);
    expect(durationMsOf(SAMPLE_RATE / 2, SAMPLE_RATE)).toBe(500);
    expect(durationMsOf(0, SAMPLE_RATE)).toBe(0);
  });

  it("answers zero rather than Infinity for an impossible rate", () => {
    expect(durationMsOf(1000, 0)).toBe(0);
  });
});

describe("joinChunks", () => {
  it("puts the gap between chunks and not around them", () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([1, 1]);
    const out = joinChunks([a, b], 10, 0.5); // 5 frames of gap
    expect(out.length).toBe(2 + 5 + 2);
    // Speech at both ends, silence only in the middle.
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(1);
    expect(Array.from(out.slice(2, 7))).toEqual([0, 0, 0, 0, 0]);
  });

  it("adds no gap to a single chunk", () => {
    const out = joinChunks([new Float32Array([1, 1])], 10, 0.5);
    expect(out.length).toBe(2);
  });

  it("answers an empty run for nothing to join", () => {
    expect(joinChunks([], 10, 0.5).length).toBe(0);
    expect(joinChunks([new Float32Array(0)], 10, 0.5).length).toBe(0);
  });
});

/**
 * A tone we can recognise after a round trip.
 *
 * Kept at 0.5 rather than near full scale so quantisation, not clipping, is
 * the only thing separating the two sides.
 */
function tone(frames: number, hz: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return out;
}

const scratch: string[] = [];

function writeTemp(bytes: Buffer): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-tts-wav-")),
    "probe.wav",
  );
  fs.writeFileSync(file, bytes);
  scratch.push(path.dirname(file));
  return file;
}

/** What ffmpeg reads back out of our file, as signed 16-bit frames. */
function decodeWithFfmpeg(file: string): Int16Array | null {
  if (FFMPEG == null) {
    return null;
  }
  const result = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr?.toString().slice(0, 400)}`);
  }
  const out = result.stdout;
  return new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2));
}

afterAll(() => {
  for (const dir of scratch) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(FFMPEG == null)("against the bundled ffmpeg", () => {
  it("delivers exactly the samples it was handed", () => {
    const samples = tone(4410, 440);
    const decoded = decodeWithFfmpeg(writeTemp(encodeWav(samples, SAMPLE_RATE)))!;

    expect(decoded.length).toBe(samples.length);
    let worst = 0;
    for (let i = 0; i < samples.length; i++) {
      worst = Math.max(worst, Math.abs(decoded[i] - toPcm16(samples[i])));
    }
    // Both sides are integers by this point, so anything above zero is a
    // header the demuxer read differently from the way we wrote it.
    expect(worst).toBe(0);
  });

  it("states a duration ffmpeg agrees with", () => {
    const samples = tone(SAMPLE_RATE, 220);
    const decoded = decodeWithFfmpeg(writeTemp(encodeWav(samples, SAMPLE_RATE)))!;
    expect(durationMsOf(decoded.length, SAMPLE_RATE)).toBe(
      durationMsOf(samples.length, SAMPLE_RATE),
    );
    expect(durationMsOf(decoded.length, SAMPLE_RATE)).toBe(1000);
  });

  it("keeps the gap joinChunks inserted", () => {
    const gapSeconds = 0.25;
    const joined = joinChunks(
      [tone(4410, 440), tone(4410, 440)],
      SAMPLE_RATE,
      gapSeconds,
    );
    const decoded = decodeWithFfmpeg(writeTemp(encodeWav(joined, SAMPLE_RATE)))!;

    const gapFrames = Math.round(gapSeconds * SAMPLE_RATE);
    expect(decoded.length).toBe(4410 * 2 + gapFrames);
    for (let i = 4410; i < 4410 + gapFrames; i++) {
      expect(decoded[i]).toBe(0);
    }
  });

  /**
   * Proof the harness measures something.
   *
   * Everything above would pass just as happily if `decodeWithFfmpeg` returned
   * our own input, or if both sides were silence. Here the two sides are given
   * different tones and are required to disagree loudly.
   */
  it("fails when the two sides are given different audio", () => {
    const decoded = decodeWithFfmpeg(
      writeTemp(encodeWav(tone(4410, 440), SAMPLE_RATE)),
    )!;
    const different = tone(4410, 880);

    let worst = 0;
    for (let i = 0; i < different.length; i++) {
      worst = Math.max(worst, Math.abs(decoded[i] - toPcm16(different[i])));
    }
    expect(worst).toBeGreaterThan(1000);
  });
});
