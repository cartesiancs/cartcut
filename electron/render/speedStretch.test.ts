/**
 * The stretcher, without FFmpeg anywhere near it.
 *
 * Three of these are the contract the export rests on: the output is exactly as
 * long as it was asked to be, a clip playing at its natural rate comes back
 * unchanged, and nothing here can produce a sample that is not a number. The
 * parity suite next door checks what it sounds like against the real binary.
 */

import { describe, expect, it } from "vitest";
import { stretchAudio, WINDOW_MS } from "./speedStretch";
import { prepareSpeedCurve, curveSourceAt } from "./speedCurve";
import { seededRandom } from "../../apps/app/src/features/timeline/testing";

const RATE = 48_000;

/** A steady tone, which a phase error shows up in immediately. */
function tone(seconds: number, hz: number, channels = 1): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * channels);
  for (let n = 0; n < frames; n++) {
    const value = Math.sin((2 * Math.PI * hz * n) / RATE);
    for (let c = 0; c < channels; c++) {
      out[n * channels + c] = value * (c === 0 ? 1 : 0.5);
    }
  }
  return out;
}

function noise(seconds: number, seed: number, channels = 1): Float32Array {
  const rand = seededRandom(seed);
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < out.length; i++) {
    out[i] = rand() * 2 - 1;
  }
  return out;
}

/** The map a constant rate gives: output ms `u` shows source ms `u * speed`. */
const atRate = (speed: number) => (outputMs: number) => outputMs * speed;

/** The map a ramp gives, anchored at source 0. */
function atRamp(points: Array<{ t: number; v: number }>) {
  const curve = prepareSpeedCurve(points);
  return (outputMs: number) => curveSourceAt(curve, 0, outputMs);
}

function rms(samples: Float32Array): number {
  let total = 0;
  for (const value of samples) {
    total += value * value;
  }
  return Math.sqrt(total / Math.max(1, samples.length));
}

describe("stretchAudio", () => {
  it("returns exactly the number of frames it was asked for", () => {
    const rand = seededRandom(3);
    const input = noise(2, 11);
    for (let i = 0; i < 40; i++) {
      const outputFrames = 1 + Math.floor(rand() * RATE * 2);
      const out = stretchAudio({
        input,
        channels: 1,
        sampleRate: RATE,
        sourceStartMs: 0,
        sourceAt: atRate(0.25 + rand() * 3.75),
        outputFrames,
      });
      expect(out.length).toBe(outputFrames);
    }
  });

  it("reconstructs the input at the natural rate", () => {
    // The overlap-add is normalised by its own accumulated window weight, so
    // this holds at the two ends as well as in the middle. Without that
    // normalisation the first and last half window fade in and out.
    const input = tone(1, 440);
    const out = stretchAudio({
      input,
      channels: 1,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: atRate(1),
      outputFrames: input.length,
    });
    let worst = 0;
    for (let i = 0; i < input.length; i++) {
      worst = Math.max(worst, Math.abs(out[i] - input[i]));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("reconstructs noise at the natural rate too, which a tone could hide", () => {
    const input = noise(0.5, 99);
    const out = stretchAudio({
      input,
      channels: 1,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: atRate(1),
      outputFrames: input.length,
    });
    let worst = 0;
    for (let i = 0; i < input.length; i++) {
      worst = Math.max(worst, Math.abs(out[i] - input[i]));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("keeps the channels together", () => {
    const input = tone(0.5, 300, 2);
    const out = stretchAudio({
      input,
      channels: 2,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: atRate(1),
      outputFrames: Math.floor(input.length / 2),
    });
    for (let frame = 0; frame < out.length / 2; frame++) {
      // The fixture's right channel is exactly half the left, and a per-channel
      // search offset would break that within a window of the first ramp.
      expect(out[frame * 2 + 1]).toBeCloseTo(out[frame * 2] * 0.5, 4);
    }
  });

  it("holds the level through a constant speed change", () => {
    const input = tone(2, 440);
    for (const speed of [0.25, 0.5, 2, 4]) {
      const outputFrames = Math.round(input.length / speed);
      const out = stretchAudio({
        input,
        channels: 1,
        sampleRate: RATE,
        sourceStartMs: 0,
        sourceAt: atRate(speed),
        outputFrames,
      });
      // A window that overlap-added without normalising would come out loud
      // where the overlap doubles up and quiet where it thins.
      expect(rms(out)).toBeCloseTo(rms(input), 1);
    }
  });

  it("holds the level through a ramp", () => {
    const input = tone(4, 440);
    const out = stretchAudio({
      input,
      channels: 1,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: atRamp([
        { t: 0, v: 0.25 },
        { t: 4000, v: 4 },
      ]),
      outputFrames: Math.round(RATE * 2),
    });
    expect(rms(out)).toBeCloseTo(rms(input), 1);

    // And the level is steady across the ramp rather than sagging in the middle
    // where the window spacing is least like the one it was designed for.
    const chunk = Math.floor(out.length / 8);
    for (let i = 0; i < 8; i++) {
      expect(rms(out.subarray(i * chunk, (i + 1) * chunk))).toBeGreaterThan(0.5);
    }
  });

  it("keeps the pitch while the rate changes, which is the whole reason for it", () => {
    // Counted by zero crossings, which needs no FFT and cannot be fooled by the
    // window: a resampler would move these in proportion to the rate.
    const input = tone(4, 1000);
    for (const speed of [0.5, 2]) {
      const outputFrames = Math.round(input.length / speed);
      const out = stretchAudio({
        input,
        channels: 1,
        sampleRate: RATE,
        sourceStartMs: 0,
        sourceAt: atRate(speed),
        outputFrames,
      });
      let crossings = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i - 1] <= 0 && out[i] > 0) {
          crossings++;
        }
      }
      const hz = (crossings * RATE) / out.length;
      expect(hz).toBeGreaterThan(900);
      expect(hz).toBeLessThan(1100);
    }
  });

  it("produces no NaN or Inf, for silence, DC or a source that runs out", () => {
    const cases: Array<[string, Float32Array, number]> = [
      ["silence", new Float32Array(RATE), RATE],
      ["dc", new Float32Array(RATE).fill(0.75), RATE],
      ["one frame", new Float32Array(1), 1000],
      ["asked past the end", tone(0.2, 440), RATE * 2],
    ];
    for (const [name, input, outputFrames] of cases) {
      const out = stretchAudio({
        input,
        channels: 1,
        sampleRate: RATE,
        sourceStartMs: 0,
        sourceAt: atRate(0.5),
        outputFrames,
      });
      expect(out.length).toBe(outputFrames);
      const bad = Array.from(out).findIndex((value) => !Number.isFinite(value));
      expect([name, bad]).toEqual([name, -1]);
    }
  });

  it("reads the source window the map names, to within a window", () => {
    // A burst at a known source instant has to land where the map puts it. This
    // is the property the whole export rests on, and the parity suite measures
    // the same thing against the delivered file.
    const seconds = 6;
    const input = new Float32Array(Math.round(seconds * RATE));
    const burstAtMs = 3000;
    const burstFrom = Math.round((burstAtMs / 1000) * RATE);
    for (let n = 0; n < RATE * 0.2; n++) {
      input[burstFrom + n] = Math.sin((2 * Math.PI * 1000 * n) / RATE);
    }

    const map = atRamp([
      { t: 0, v: 0.5 },
      { t: 6000, v: 3 },
    ]);
    // Where the burst lands on the output: the timeline instant whose source is
    // `burstAtMs`, found by walking the map.
    let expected = 0;
    while (map(expected) < burstAtMs && expected < 60_000) {
      expected += 0.1;
    }

    const outputFrames = Math.round((expected / 1000) * RATE) + RATE;
    const out = stretchAudio({
      input,
      channels: 1,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: map,
      outputFrames,
    });

    let loudest = 0;
    let at = 0;
    const step = Math.round(RATE * 0.01);
    for (let i = 0; i + step < out.length; i += step) {
      const level = rms(out.subarray(i, i + step));
      if (level > loudest) {
        loudest = level;
        at = i;
      }
    }
    expect(loudest).toBeGreaterThan(0.1);
    expect(Math.abs((at / RATE) * 1000 - expected)).toBeLessThan(WINDOW_MS * 2);
  });
});

describe("the search", () => {
  it("does not move the window when there is nothing to match", () => {
    // Silence correlates with everything equally, so every candidate scores the
    // same. Scanning from `-SEARCH_MS` and taking the first winner shifted the
    // analysis window back by the whole search radius on every frame of every
    // silent stretch; the map's own answer is the one to keep on a tie.
    //
    // Measured through the output: a burst preceded by silence has to start
    // where the map puts it, not `SEARCH_MS` early.
    const lead = Math.round(RATE * 0.5);
    const input = new Float32Array(RATE);
    for (let n = lead; n < lead + RATE * 0.2; n++) {
      input[n] = Math.sin((2 * Math.PI * 1000 * (n - lead)) / RATE);
    }

    const out = stretchAudio({
      input,
      channels: 1,
      sampleRate: RATE,
      sourceStartMs: 0,
      sourceAt: atRate(1),
      outputFrames: input.length,
    });

    const onsetOf = (samples: Float32Array): number => {
      const step = Math.round(RATE * 0.001);
      for (let i = 0; i + step < samples.length; i += step) {
        let energy = 0;
        for (let j = i; j < i + step; j++) {
          energy += samples[j] * samples[j];
        }
        if (Math.sqrt(energy / step) > 0.1) {
          return (i / RATE) * 1000;
        }
      }
      return -1;
    };

    // Within a millisecond of the source's own onset, which is far tighter
    // than the 5ms the tie-break used to cost.
    expect(Math.abs(onsetOf(out) - onsetOf(input))).toBeLessThan(1);
  });
});
