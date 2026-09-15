/**
 * Synthesis, in a process of its own.
 *
 * Forked by `tts.ts` as an Electron `utilityProcess`, which is a Node
 * environment with the app's `node_modules` on its path. Three reasons it is
 * not simply done in main:
 *
 * - The four sessions hold roughly 400MB. Here that is reclaimed by exiting
 *   after an idle spell; in main it would be the editor's new floor.
 * - A fault inside a native runtime takes down the process it is in. In main
 *   that is the whole app and the user's unsaved timeline with it.
 * - Cancel becomes a kill, which is certain. The same conclusion
 *   `speechStt.ts` reached about aborting the transcription sidecar.
 *
 * This file is the only one in the feature that loads onnxruntime. Everything
 * worth a test is in `ttsEngine.ts` behind the injected session port.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  synthesize,
  seededRandom,
  type SessionLike,
  type TensorFactory,
  type TtsConfig,
  type TtsSessions,
  type VoiceStyle,
} from "./ttsEngine";
import type { UnicodeIndexer } from "./ttsText";
import { durationMsOf, encodeWav } from "./ttsWav";
import type { WorkerCommand, WorkerEvent } from "./ttsProtocol";

// Required lazily and by name so that nothing in the tree pulls the native
// binding in at import time. `main/` is not tree-shaken, and a stray top-level
// require here would load 23MB of dylib into every process that touches this
// module's siblings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ort = require("onnxruntime-node");

const parentPort = (process as unknown as {
  parentPort: { postMessage(value: unknown): void; on(event: "message", handler: (message: { data: WorkerCommand }) => void): void };
}).parentPort;

function send(event: WorkerEvent): void {
  parentPort.postMessage(event);
}

const tensor: TensorFactory = {
  float32: (data, dims) => new ort.Tensor("float32", data, dims),
  // Plain numbers rather than BigInt: the runtime converts them, and naming
  // BigInt64Array here would need a lib this build does not set.
  int64: (data, dims) => new ort.Tensor("int64", data, dims),
};

type Loaded = {
  dir: string;
  sessions: TtsSessions;
  config: TtsConfig;
  indexer: UnicodeIndexer;
};

/**
 * The loaded model, kept between jobs.
 *
 * Keyed by directory so a revision change reloads rather than serving the old
 * graphs. Loading costs about 700ms, which is worth paying once and not once
 * per sentence.
 */
let loaded: Loaded | null = null;

async function open(file: string): Promise<SessionLike> {
  return ort.InferenceSession.create(file, { executionProviders: ["cpu"] });
}

async function load(dir: string): Promise<Loaded> {
  if (loaded != null && loaded.dir === dir) {
    return loaded;
  }

  const onnx = (name: string) => path.join(dir, "onnx", `${name}.onnx`);
  const [durationPredictor, textEncoder, vectorEstimator, vocoder] =
    await Promise.all([
      open(onnx("duration_predictor")),
      open(onnx("text_encoder")),
      open(onnx("vector_estimator")),
      open(onnx("vocoder")),
    ]);

  loaded = {
    dir,
    sessions: { durationPredictor, textEncoder, vectorEstimator, vocoder },
    config: JSON.parse(
      fs.readFileSync(path.join(dir, "onnx", "tts.json"), "utf8"),
    ),
    indexer: JSON.parse(
      fs.readFileSync(path.join(dir, "onnx", "unicode_indexer.json"), "utf8"),
    ),
  };
  return loaded;
}

/**
 * One voice, flattened out of its JSON.
 *
 * The file stores the vectors as nested arrays; the runtime wants one flat
 * `Float32Array`. Read per job rather than cached: the ten files are 290KB
 * each, and holding all of them would cost more than re-reading one.
 */
function readStyle(dir: string, voice: string): VoiceStyle {
  const file = path.join(dir, "voice_styles", `${voice}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const flatten = (part: { data: unknown[]; dims: number[] }) => ({
    data: Float32Array.from(part.data.flat(Infinity) as number[]),
    dims: part.dims,
  });
  return { ttl: flatten(parsed.style_ttl), dp: flatten(parsed.style_dp) };
}

async function handle(command: WorkerCommand): Promise<void> {
  if (command.type === "shutdown") {
    process.exit(0);
  }

  const { jobId, modelDir, outPath, request } = command;

  try {
    send({ type: "progress", jobId, fraction: 0, stage: "loading" });
    const model = await load(modelDir);
    const style = readStyle(modelDir, request.voice);

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
        gapSeconds: 0.3,
      },
    );

    if (result.samples.length === 0) {
      throw new Error("Nothing to say: the text held no speakable characters.");
    }

    send({ type: "progress", jobId, fraction: 1, stage: "writing" });

    // Written to `.part` and renamed, so an interrupted write can never leave a
    // truncated file that the cache takes for a finished one. The same rule
    // `lib/reverse.ts` follows for derived media.
    const part = `${outPath}.part`;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    try {
      fs.writeFileSync(part, encodeWav(result.samples, result.sampleRate));
      fs.renameSync(part, outPath);
    } catch (error) {
      fs.rmSync(part, { force: true });
      throw error;
    }

    send({
      type: "done",
      jobId,
      ok: true,
      path: outPath,
      durationMs: durationMsOf(result.samples.length, result.sampleRate),
      sampleRate: result.sampleRate,
    });
  } catch (error) {
    send({
      type: "done",
      jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort.on("message", (message) => {
  void handle(message.data);
});

send({ type: "ready" });
