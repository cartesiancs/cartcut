/**
 * What the browser's speech port and its synthesis worker say to each other.
 *
 * The browser counterpart of `electron/lib/tts/ttsProtocol.ts`. The worker
 * reads the model from Cache Storage itself, so a command carries no paths,
 * and the finished file comes back as bytes, transferred rather than copied.
 * Plain data only: every message crosses a structured-clone boundary.
 */

import type {
  SynthesisRequest,
  TtsStage,
} from "../../../../../../electron/lib/tts/ttsProtocol";

/** Sent to the worker. */
export type WebWorkerCommand = {
  type: "synthesize";
  jobId: string;
  request: SynthesisRequest;
};

/** Sent back to the port. */
export type WebWorkerEvent =
  | { type: "progress"; jobId: string; fraction: number; stage: TtsStage }
  | {
      type: "done";
      jobId: string;
      ok: true;
      /** A complete WAV file, `ttsWav.ts#encodeWavBytes`. */
      wav: ArrayBuffer;
      durationMs: number;
      sampleRate: number;
    }
  | { type: "done"; jobId: string; ok: false; error: string };
