/**
 * The four graphs, in the order that turns text into a waveform.
 *
 *   duration_predictor -> text_encoder -> vector_estimator (xN) -> vocoder
 *
 * **Nothing here imports onnxruntime.** The sessions arrive as a plain record
 * of `run` functions, the same narrowing CLAUDE.md describes for DOM logic and
 * for the same reason: a rule kept inside a native binding is a rule no suite
 * can reach. `ttsWorker.ts` supplies the real ones, a fake supplies canned
 * tensors, and the tensor plumbing below is checked either way.
 *
 * Ported from the MIT reference at supertone-oss-archive/supertonic
 * (`nodejs/helper.js`, Copyright (c) 2025 Supertone Inc.).
 */

import {
  chunkText,
  encodeBatch,
  maxChunkChars,
  type TtsLang,
  type UnicodeIndexer,
} from "./ttsText";
import { joinChunks } from "./ttsWav";

/** One tensor, in the shape both onnxruntime and a fake can produce. */
export type TensorLike = {
  readonly data: Float32Array | ArrayLike<number>;
  readonly dims: readonly number[];
};

/** Just enough of `ort.InferenceSession` to run one graph. */
export type SessionLike = {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
};

export type TtsSessions = {
  durationPredictor: SessionLike;
  textEncoder: SessionLike;
  vectorEstimator: SessionLike;
  vocoder: SessionLike;
};

/**
 * Builds the tensor objects the runtime wants.
 *
 * Injected for the same reason the sessions are: `ort.Tensor` is a native
 * constructor, and a suite that had to produce one could not run under node
 * without the binding loaded.
 */
export type TensorFactory = {
  float32(data: Float32Array, dims: readonly number[]): unknown;
  int64(data: readonly number[], dims: readonly number[]): unknown;
};

/** `tts.json`, the shapes the graphs were exported with. */
export type TtsConfig = {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { latent_dim: number; chunk_compress_factor: number };
};

/** One voice, already flattened out of its `voice_styles/*.json`. */
export type VoiceStyle = {
  ttl: { data: Float32Array; dims: readonly number[] };
  dp: { data: Float32Array; dims: readonly number[] };
};

export type SynthesisOptions = {
  lang: TtsLang;
  /** Denoising steps. More is slower and smoother; 2 to 8 is the useful range. */
  totalStep: number;
  /** Divides the predicted duration, so above 1 is faster speech. */
  speed: number;
  /** Silence between chunks of a long script, in seconds. */
  gapSeconds: number;
};

export type SynthesisDeps = {
  sessions: TtsSessions;
  tensor: TensorFactory;
  config: TtsConfig;
  indexer: UnicodeIndexer;
  style: VoiceStyle;
  /**
   * Uniform [0, 1), the source of the starting noise.
   *
   * Injected so a synthesis is reproducible. With `Math.random` the same text
   * and voice come back measurably different every run, which would make the
   * output cache a liar (a hit and a miss would not sound alike) and every
   * assertion about the waveform a coin toss. `ttsWorker.ts` seeds this from
   * the same key the cache files are named by.
   */
  random?: () => number;
  /** 0 to 1 across the whole run. Called at chunk and step boundaries. */
  onProgress?: (fraction: number) => void;
  signal?: { readonly aborted: boolean };
};

export class TtsCancelledError extends Error {
  constructor() {
    super("Synthesis cancelled");
    this.name = "TtsCancelledError";
  }
}

function throwIfAborted(signal?: { readonly aborted: boolean }): void {
  if (signal?.aborted === true) {
    throw new TtsCancelledError();
  }
}

/**
 * A deterministic uniform source, mulberry32.
 *
 * Chosen for being four lines and stable across platforms. Nothing here is
 * cryptographic; it only has to give the same latent for the same seed on
 * every machine, which `Math.random` explicitly does not promise.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal noise, by Box-Muller.
 *
 * `u1` is floored away from zero because a uniform source may return exactly 0
 * and `log(0)` is `-Infinity`, which would put NaN through the whole latent and
 * come out as silence with nothing to show which sample started it.
 */
function randomNormal(random: () => number): number {
  const u1 = Math.max(1e-10, random());
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

type NoisyLatent = {
  data: Float32Array;
  dims: readonly number[];
  mask: Float32Array;
  maskDims: readonly number[];
};

/**
 * The noise the flow matching starts from, already masked to the predicted
 * length.
 *
 * Flat `Float32Array`s throughout rather than the reference's nested arrays.
 * A minute of speech is a latent of roughly 144 by 860, and the reference
 * rebuilds it as `number[][][]` and calls `.flat(Infinity)` on every one of the
 * denoising steps, which costs more than the inference it is feeding.
 */
function sampleNoisyLatent(
  durations: readonly number[],
  config: TtsConfig,
  random: () => number,
): NoisyLatent {
  const { sample_rate: sampleRate, base_chunk_size: baseChunkSize } = config.ae;
  const { latent_dim: latentDim, chunk_compress_factor: compress } = config.ttl;

  const batch = durations.length;
  const wavLengths = durations.map((d) => Math.floor(d * sampleRate));
  const wavLenMax = Math.max(...durations) * sampleRate;

  const chunkSize = baseChunkSize * compress;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const rows = latentDim * compress;

  // The mask marks how much of the padded length each item actually occupies.
  const mask = new Float32Array(batch * latentLen);
  wavLengths.forEach((wavLen, b) => {
    const used = Math.floor((wavLen + chunkSize - 1) / chunkSize);
    for (let t = 0; t < Math.min(used, latentLen); t++) {
      mask[b * latentLen + t] = 1;
    }
  });

  const data = new Float32Array(batch * rows * latentLen);
  for (let b = 0; b < batch; b++) {
    for (let d = 0; d < rows; d++) {
      const offset = (b * rows + d) * latentLen;
      const maskRow = b * latentLen;
      for (let t = 0; t < latentLen; t++) {
        data[offset + t] = randomNormal(random) * mask[maskRow + t];
      }
    }
  }

  return {
    data,
    dims: [batch, rows, latentLen],
    mask,
    maskDims: [batch, 1, latentLen],
  };
}

/** Copy a runtime tensor's samples out as floats we own. */
function toFloat32(tensor: TensorLike): Float32Array {
  return tensor.data instanceof Float32Array
    ? tensor.data
    : Float32Array.from(tensor.data as ArrayLike<number>);
}

/**
 * Synthesise one chunk: a single batch item, start to finish.
 *
 * `onStep` reports progress inside the denoising loop, which is where nearly
 * all of the time goes and therefore the only place a bar can move honestly.
 */
async function synthesizeChunk(
  text: string,
  deps: SynthesisDeps,
  options: SynthesisOptions,
  onStep?: (stepFraction: number) => void,
): Promise<Float32Array> {
  const { sessions, tensor, config, indexer, style, signal } = deps;

  const encoded = encodeBatch([text], [options.lang], indexer);
  const textIds = tensor.int64(encoded.textIds, encoded.textIdsDims);
  const textMask = tensor.float32(encoded.textMask, encoded.textMaskDims);
  const styleTtl = tensor.float32(style.ttl.data, style.ttl.dims);
  const styleDp = tensor.float32(style.dp.data, style.dp.dims);

  throwIfAborted(signal);
  const dp = await sessions.durationPredictor.run({
    text_ids: textIds,
    style_dp: styleDp,
    text_mask: textMask,
  });

  // Speed divides the predicted duration, so a higher number means the same
  // words are laid into less time.
  const speed = options.speed > 0 ? options.speed : 1;
  const durations = Array.from(toFloat32(dp.duration), (d) => d / speed);

  throwIfAborted(signal);
  const encoder = await sessions.textEncoder.run({
    text_ids: textIds,
    style_ttl: styleTtl,
    text_mask: textMask,
  });
  const textEmb = encoder.text_emb;

  const latent = sampleNoisyLatent(durations, config, deps.random ?? Math.random);
  const latentMask = tensor.float32(latent.mask, latent.maskDims);
  const totalStep = Math.max(1, Math.floor(options.totalStep));
  const totalStepTensor = tensor.float32(
    Float32Array.from([totalStep]),
    [durations.length],
  );

  let current = latent.data;
  for (let step = 0; step < totalStep; step++) {
    throwIfAborted(signal);
    const result = await sessions.vectorEstimator.run({
      noisy_latent: tensor.float32(current, latent.dims),
      text_emb: textEmb,
      style_ttl: styleTtl,
      text_mask: textMask,
      latent_mask: latentMask,
      total_step: totalStepTensor,
      current_step: tensor.float32(
        Float32Array.from([step]),
        [durations.length],
      ),
    });
    // The estimator returns the whole latent each step, so this replaces rather
    // than accumulates. Adding would diverge after the second step.
    current = toFloat32(result.denoised_latent);
    onStep?.((step + 1) / totalStep);
  }

  throwIfAborted(signal);
  const voice = await sessions.vocoder.run({
    latent: tensor.float32(current, latent.dims),
  });

  return toFloat32(voice.wav_tts);
}

export type SynthesisResult = {
  samples: Float32Array;
  sampleRate: number;
  chunkCount: number;
};

/**
 * Synthesise a whole script.
 *
 * Chunked because the model has a trained context length, and joined with a
 * gap so the seams read as pauses rather than as elisions.
 */
export async function synthesize(
  text: string,
  deps: SynthesisDeps,
  options: SynthesisOptions,
): Promise<SynthesisResult> {
  const sampleRate = deps.config.ae.sample_rate;
  const chunks = chunkText(text, maxChunkChars(options.lang));

  if (chunks.length === 0) {
    return { samples: new Float32Array(0), sampleRate, chunkCount: 0 };
  }

  const rendered: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const done = i / chunks.length;
    const span = 1 / chunks.length;
    rendered.push(
      await synthesizeChunk(chunks[i], deps, options, (stepFraction) => {
        deps.onProgress?.(done + span * stepFraction);
      }),
    );
  }

  deps.onProgress?.(1);
  return {
    samples: joinChunks(rendered, sampleRate, options.gapSeconds),
    sampleRate,
    chunkCount: chunks.length,
  };
}
