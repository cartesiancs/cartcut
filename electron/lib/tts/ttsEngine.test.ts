/**
 * The tensor plumbing, against fake sessions.
 *
 * No model is loaded here. The point of injecting the sessions is that the
 * order of the graphs, the shapes handed to each one, the denoising loop's
 * step accounting and the cancel checks are all decidable without 400MB of
 * weights, and so can be checked on any machine in milliseconds.
 *
 * What this cannot check is whether the numbers mean anything. That is what
 * the opt-in integration suite does, against the real model.
 */

import { describe, expect, it, vi } from "vitest";

import {
  seededRandom,
  synthesize,
  TtsCancelledError,
  type SessionLike,
  type SynthesisDeps,
  type TensorFactory,
  type TtsConfig,
  type VoiceStyle,
} from "./ttsEngine";
import type { UnicodeIndexer } from "./ttsText";

/** The real `tts.json`'s shapes, which decide the latent's size. */
const CONFIG: TtsConfig = {
  ae: { sample_rate: 44100, base_chunk_size: 512 },
  ttl: { latent_dim: 24, chunk_compress_factor: 6 },
};

/** Every character a tagged English sentence needs. */
function indexer(): UnicodeIndexer {
  const table = new Array<number>(65536).fill(-1);
  Array.from("<>/enkoabcdefghijklmnpqrstuvwxyz .,!?'\"-").forEach((c, i) => {
    table[c.charCodeAt(0)] = i + 1;
  });
  return table;
}

function style(): VoiceStyle {
  return {
    ttl: { data: new Float32Array(8), dims: [1, 2, 4] },
    dp: { data: new Float32Array(8), dims: [1, 2, 4] },
  };
}

/**
 * A tensor that only remembers what it was given.
 *
 * The factory is injected precisely so a suite can use plain objects where the
 * app uses `ort.Tensor`, which is a native constructor.
 */
const tensor: TensorFactory = {
  float32: (data, dims) => ({ kind: "float32", data, dims }),
  int64: (data, dims) => ({ kind: "int64", data, dims }),
};

type Recorded = { name: string; feeds: Record<string, unknown> };

/**
 * Sessions that answer with correctly shaped zeros and record what they saw.
 *
 * `durationSeconds` drives the latent's length, so a test can ask for a short
 * or long utterance without any real inference.
 */
function fakeSessions(durationSeconds = 0.5) {
  const calls: Recorded[] = [];

  const record = (name: string, reply: (feeds: any) => any): SessionLike => ({
    run: async (feeds) => {
      calls.push({ name, feeds });
      return reply(feeds);
    },
  });

  const sessions = {
    durationPredictor: record("dp", () => ({
      duration: { data: Float32Array.from([durationSeconds]), dims: [1] },
    })),
    textEncoder: record("enc", () => ({
      text_emb: { data: new Float32Array(4), dims: [1, 2, 2] },
    })),
    vectorEstimator: record("est", (feeds: any) => ({
      // Same shape back, which is what the real graph does.
      denoised_latent: {
        data: new Float32Array(feeds.noisy_latent.data.length),
        dims: feeds.noisy_latent.dims,
      },
    })),
    vocoder: record("voc", (feeds: any) => ({
      wav_tts: {
        data: new Float32Array(feeds.latent.dims[2] * 512),
        dims: [1, feeds.latent.dims[2] * 512],
      },
    })),
  };

  return { sessions, calls };
}

function deps(overrides: Partial<SynthesisDeps> = {}): SynthesisDeps {
  const { sessions } = fakeSessions();
  return {
    sessions,
    tensor,
    config: CONFIG,
    indexer: indexer(),
    style: style(),
    random: seededRandom(1),
    ...overrides,
  };
}

const options = {
  lang: "en" as const,
  totalStep: 4,
  speed: 1.05,
  gapSeconds: 0.3,
};

describe("seededRandom", () => {
  it("repeats itself for a seed and differs across seeds", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const draw = (r: () => number) => [r(), r(), r(), r()];

    const first = draw(a);
    expect(draw(b)).toEqual(first);
    expect(draw(c)).not.toEqual(first);
  });

  it("stays inside the unit interval", () => {
    const random = seededRandom(123);
    for (let i = 0; i < 5000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("synthesize", () => {
  it("runs the four graphs in the order the model expects", async () => {
    const { sessions, calls } = fakeSessions();
    await synthesize("Hello there.", deps({ sessions }), options);

    // Duration first (it decides the latent's length), then the encoder, then
    // the estimator once per step, then the vocoder exactly once.
    expect(calls.map((c) => c.name)).toEqual([
      "dp",
      "enc",
      "est",
      "est",
      "est",
      "est",
      "voc",
    ]);
  });

  it("runs the estimator once per denoising step", async () => {
    for (const totalStep of [1, 4, 8]) {
      const { sessions, calls } = fakeSessions();
      await synthesize("Hi.", deps({ sessions }), { ...options, totalStep });
      expect(calls.filter((c) => c.name === "est").length).toBe(totalStep);
    }
  });

  it("counts the steps from zero up to total, once each", async () => {
    const { sessions, calls } = fakeSessions();
    await synthesize("Hi.", deps({ sessions }), { ...options, totalStep: 4 });

    const steps = calls
      .filter((c) => c.name === "est")
      .map((c) => (c.feeds.current_step as any).data[0]);
    expect(steps).toEqual([0, 1, 2, 3]);

    const totals = calls
      .filter((c) => c.name === "est")
      .map((c) => (c.feeds.total_step as any).data[0]);
    expect(totals).toEqual([4, 4, 4, 4]);
  });

  it("gives the duration predictor and the encoder the same tokens", async () => {
    const { sessions, calls } = fakeSessions();
    await synthesize("Hello there.", deps({ sessions }), options);

    const dp = calls.find((c) => c.name === "dp")!;
    const enc = calls.find((c) => c.name === "enc")!;
    expect((dp.feeds.text_ids as any).data).toEqual(
      (enc.feeds.text_ids as any).data,
    );
    expect((dp.feeds.text_ids as any).kind).toBe("int64");
    expect((dp.feeds.text_mask as any).kind).toBe("float32");
  });

  it("uses each voice vector on the graph that takes it", async () => {
    const { sessions, calls } = fakeSessions();
    await synthesize("Hi.", deps({ sessions }), options);

    // The duration predictor takes style_dp; everything else takes style_ttl.
    expect(calls.find((c) => c.name === "dp")!.feeds).toHaveProperty("style_dp");
    expect(calls.find((c) => c.name === "enc")!.feeds).toHaveProperty(
      "style_ttl",
    );
    expect(calls.find((c) => c.name === "est")!.feeds).toHaveProperty(
      "style_ttl",
    );
  });

  /**
   * Speed divides the predicted duration, so a faster setting must produce a
   * shorter latent. Getting the sign wrong here is not a crash; it is speech
   * that slows down when the user asks for faster.
   */
  it("makes a higher speed produce a shorter latent", async () => {
    const lengthAt = async (speed: number) => {
      const { sessions, calls } = fakeSessions(1);
      await synthesize("Hi.", deps({ sessions }), { ...options, speed });
      return (calls.find((c) => c.name === "est")!.feeds.noisy_latent as any)
        .dims[2];
    };

    expect(await lengthAt(2)).toBeLessThan(await lengthAt(1));
  });

  it("masks the starting noise to the predicted length", async () => {
    const { sessions, calls } = fakeSessions(0.5);
    await synthesize("Hi.", deps({ sessions }), options);

    const est = calls.find((c) => c.name === "est")!;
    const mask = (est.feeds.latent_mask as any).data as Float32Array;
    const noise = (est.feeds.noisy_latent as any).data as Float32Array;

    // Every mask value is a flag, and something is switched on.
    expect(Array.from(mask).every((v) => v === 0 || v === 1)).toBe(true);
    expect(Array.from(mask).some((v) => v === 1)).toBe(true);
    // Nothing is NaN, which is what a log(0) in the Box-Muller draw would give.
    expect(Array.from(noise).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("splits a long script and joins it with a gap", async () => {
    const { sessions, calls } = fakeSessions();
    const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i} here.`).join(" ");

    const result = await synthesize(long, deps({ sessions }), {
      ...options,
      // Force several passes without needing a huge script.
      lang: "ko",
    });

    expect(result.chunkCount).toBeGreaterThan(1);
    expect(calls.filter((c) => c.name === "voc").length).toBe(result.chunkCount);
    expect(result.sampleRate).toBe(44100);
  });

  it("answers an empty result for text with nothing in it", async () => {
    const { sessions, calls } = fakeSessions();
    const result = await synthesize("   \n\n ", deps({ sessions }), options);

    expect(result.chunkCount).toBe(0);
    expect(result.samples.length).toBe(0);
    // Nothing was loaded and nothing was run.
    expect(calls).toEqual([]);
  });

  it("reports progress that only ever rises, and ends at one", async () => {
    const seen: number[] = [];
    const { sessions } = fakeSessions();
    await synthesize(
      "One. Two. Three.",
      deps({ sessions, onProgress: (f) => seen.push(f) }),
      options,
    );

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("is reproducible for a seed and different across seeds", async () => {
    const noiseFor = async (seed: number) => {
      const { sessions, calls } = fakeSessions();
      await synthesize("Hi.", deps({ sessions, random: seededRandom(seed) }), options);
      return Array.from(
        (calls.find((c) => c.name === "est")!.feeds.noisy_latent as any)
          .data as Float32Array,
      );
    };

    const first = await noiseFor(99);
    expect(await noiseFor(99)).toEqual(first);
    // Proof the comparison above is measuring something.
    expect(await noiseFor(100)).not.toEqual(first);
  });

  describe("cancellation", () => {
    it("stops before the first graph when already aborted", async () => {
      const { sessions, calls } = fakeSessions();
      await expect(
        synthesize(
          "Hi.",
          deps({ sessions, signal: { aborted: true } }),
          options,
        ),
      ).rejects.toBeInstanceOf(TtsCancelledError);
      expect(calls).toEqual([]);
    });

    /**
     * The denoising loop is where nearly all the time goes, so a cancel that
     * was only checked at the top would leave the user waiting out the rest of
     * a long utterance after pressing the button.
     */
    it("stops inside the denoising loop", async () => {
      const signal = { aborted: false };
      const { sessions, calls } = fakeSessions();
      const estimator = sessions.vectorEstimator.run;
      sessions.vectorEstimator.run = async (feeds) => {
        const reply = await estimator(feeds);
        signal.aborted = true;
        return reply;
      };

      await expect(
        synthesize("Hi.", deps({ sessions, signal }), { ...options, totalStep: 8 }),
      ).rejects.toBeInstanceOf(TtsCancelledError);

      // One step ran, not all eight, and the vocoder never did.
      expect(calls.filter((c) => c.name === "est").length).toBe(1);
      expect(calls.filter((c) => c.name === "voc").length).toBe(0);
    });
  });
});
