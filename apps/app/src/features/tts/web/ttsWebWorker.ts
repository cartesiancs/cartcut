/**
 * Speech synthesis in a browser, in a worker of its own.
 *
 * Built as webpack's second entry (`ttsWorker.js`, beside `index.js`) and
 * started by `browserTts.ts`. The browser counterpart of
 * `electron/lib/tts/ttsWorker.ts`, running the same engine (`ttsEngine.ts`)
 * on ONNX Runtime's WebAssembly build instead of its native one. A worker for
 * the desktop's reasons: inference would otherwise freeze the editor for
 * seconds at a time, the 400MB of weights are released by terminating it, and
 * cancelling is a terminate, which is certain.
 *
 * This file is the only one in the browser build that loads onnxruntime.
 */

import * as ort from "onnxruntime-web/wasm";
import glueUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm";

import {
  CHUNK_GAP_SECONDS,
  seededRandom,
  synthesize,
  type SessionLike,
  type TensorFactory,
  type TtsConfig,
  type TtsSessions,
  type VoiceStyle,
} from "../../../../../../electron/lib/tts/ttsEngine";
import type { UnicodeIndexer } from "../../../../../../electron/lib/tts/ttsText";
import {
  durationMsOf,
  encodeWavBytes,
} from "../../../../../../electron/lib/tts/ttsWav";
import { openModelCache, readModelFile, type ModelCache } from "./webModelStore";
import type { WebWorkerCommand, WebWorkerEvent } from "./webTtsProtocol";

type WorkerScope = {
  location: { href: string };
  postMessage(message: WebWorkerEvent, transfer?: Transferable[]): void;
  onmessage: ((event: { data: WebWorkerCommand }) => void) | null;
};

const scope = self as unknown as WorkerScope;

// One thread. More need cross-origin isolation, which the static host does
// not send, and ONNX Runtime falls back to one with a console warning anyway.
ort.env.wasm.numThreads = 1;
// The two files webpack emitted beside this script (`modules.d.ts` says why
// this build of the runtime needs them named).
ort.env.wasm.wasmPaths = {
  mjs: new URL(glueUrl, scope.location.href).href,
  wasm: new URL(wasmUrl, scope.location.href).href,
};

function send(event: WebWorkerEvent, transfer?: Transferable[]): void {
  scope.postMessage(event, transfer);
}

const tensor: TensorFactory = {
  float32: (data, dims) => new ort.Tensor("float32", data, dims),
  // Plain numbers, as on the desktop: the runtime converts them to int64.
  int64: (data, dims) => new ort.Tensor("int64", data as number[], dims),
};

type Loaded = {
  cache: ModelCache;
  sessions: TtsSessions;
  config: TtsConfig;
  indexer: UnicodeIndexer;
};

/**
 * The loaded model, kept between jobs, or the load in flight.
 *
 * Forgotten when a load fails, so the next job tries again rather than
 * inheriting the rejection.
 */
let loading: Promise<Loaded> | null = null;

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function load(): Promise<Loaded> {
  const cache = await openModelCache(caches);
  const open = async (name: string): Promise<SessionLike> => {
    const bytes = await readModelFile(cache, `onnx/${name}.onnx`);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
    });
    return session as unknown as SessionLike;
  };

  // One graph at a time: each is copied into the runtime's own memory, and
  // holding all four as script buffers as well would double the peak.
  const durationPredictor = await open("duration_predictor");
  const textEncoder = await open("text_encoder");
  const vectorEstimator = await open("vector_estimator");
  const vocoder = await open("vocoder");

  return {
    cache,
    sessions: { durationPredictor, textEncoder, vectorEstimator, vocoder },
    config: JSON.parse(text(await readModelFile(cache, "onnx/tts.json"))),
    indexer: JSON.parse(
      text(await readModelFile(cache, "onnx/unicode_indexer.json")),
    ),
  };
}

function loadOnce(): Promise<Loaded> {
  if (loading == null) {
    loading = load().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

/** Every number in a nested array, in order. */
function flatten(value: unknown, into: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      flatten(item, into);
    }
  } else {
    into.push(Number(value));
  }
  return into;
}

/** One voice, flattened out of its JSON, read per job as the desktop does. */
async function readStyle(cache: ModelCache, voice: string): Promise<VoiceStyle> {
  const parsed = JSON.parse(
    text(await readModelFile(cache, `voice_styles/${voice}.json`)),
  );
  const part = (entry: { data: unknown; dims: number[] }) => ({
    data: Float32Array.from(flatten(entry.data)),
    dims: entry.dims,
  });
  return { ttl: part(parsed.style_ttl), dp: part(parsed.style_dp) };
}

async function handle(command: WebWorkerCommand): Promise<void> {
  const { jobId, request } = command;
  try {
    send({ type: "progress", jobId, fraction: 0, stage: "loading" });
    const model = await loadOnce();
    const style = await readStyle(model.cache, request.voice);

    const result = await synthesize(
      request.text,
      {
        sessions: model.sessions,
        tensor,
        config: model.config,
        indexer: model.indexer,
        style,
        random: seededRandom(request.seed),
        onProgress: (fraction) =>
          send({ type: "progress", jobId, fraction, stage: "synthesizing" }),
      },
      {
        lang: request.lang,
        totalStep: request.steps,
        speed: request.speed,
        gapSeconds: CHUNK_GAP_SECONDS,
      },
    );

    if (result.samples.length === 0) {
      throw new Error("Nothing to say: the text held no speakable characters.");
    }

    send({ type: "progress", jobId, fraction: 1, stage: "writing" });
    const wav = encodeWavBytes(result.samples, result.sampleRate);
    const buffer = wav.buffer as ArrayBuffer;
    send(
      {
        type: "done",
        jobId,
        ok: true,
        wav: buffer,
        durationMs: durationMsOf(result.samples.length, result.sampleRate),
        sampleRate: result.sampleRate,
      },
      [buffer],
    );
  } catch (error) {
    send({
      type: "done",
      jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event) => {
  void handle(event.data);
};
