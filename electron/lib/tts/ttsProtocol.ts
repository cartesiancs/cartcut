/**
 * What the main process and the synthesis worker say to each other.
 *
 * Its own file, with no imports beyond the engine's types, so both ends are
 * compiled against one definition rather than two hand copies that drift. The
 * worker is a `utilityProcess`, so every message crosses a structured-clone
 * boundary: plain data only, no class instances and no functions.
 */

import type { TtsLang } from "./ttsText";

export type SynthesisRequest = {
  text: string;
  /** One of the ten preset voices. There is no cloning in this release. */
  voice: string;
  lang: TtsLang;
  /** Divides the predicted duration, so above 1 is faster speech. */
  speed: number;
  /** Denoising steps. Never below 4: two clips on a handful of samples. */
  steps: number;
  /**
   * Fixes the starting noise.
   *
   * Derived from the cache key, so the file a cache hit returns is the file a
   * fresh run would have produced. Without it the same text sounds measurably
   * different every time and the cache quietly becomes a lie.
   */
  seed: number;
};

/** Sent to the worker. */
export type WorkerCommand =
  | {
      type: "synthesize";
      jobId: string;
      /** The revision directory holding `onnx/` and `voice_styles/`. */
      modelDir: string;
      /** Where to write the finished file. The worker owns the `.part`. */
      outPath: string;
      request: SynthesisRequest;
    }
  | { type: "shutdown" };

/** Sent back to main. */
export type WorkerEvent =
  | { type: "ready" }
  | { type: "progress"; jobId: string; fraction: number; stage: TtsStage }
  | {
      type: "done";
      jobId: string;
      ok: true;
      path: string;
      durationMs: number;
      sampleRate: number;
    }
  | { type: "done"; jobId: string; ok: false; error: string };

/**
 * The vocabulary the panel turns into a sentence.
 *
 * `loading` is separate from `synthesizing` because the first run of a session
 * spends about a second mapping 400MB of weights before any audio is made, and
 * a bar that sat at zero through it would read as nothing having started.
 */
export type TtsStage =
  | "queued"
  | "downloading"
  | "loading"
  | "synthesizing"
  | "writing";
