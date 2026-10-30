/**
 * The main process's view of synthesis: a cache, and a worker that owns the
 * model.
 *
 * The Electron half of the feature. Everything decidable lives in the modules
 * this one composes, which is why they have suites and this does not.
 *
 * Generated speech is cached in `userData/tts`, keyed by everything that
 * decides how it sounds. The same arrangement as `lib/reverse.ts`, and for its
 * reasons: derived media lives beside the app rather than beside the user's
 * footage, and a repeated request costs nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, utilityProcess, type UtilityProcess } from "electron";

import { netFetch } from "../netFetch";

import { MODEL_TOTAL_BYTES } from "./ttsManifest";
import {
  availability,
  modelDir,
  speechCacheDir,
  type TtsAvailability,
} from "./ttsModels";
import {
  downloadModel,
  type DownloadProgress,
} from "./ttsDownload";
import { seedFor, speechKey } from "./ttsCacheKey";
import type {
  SynthesisRequest,
  TtsStage,
  WorkerCommand,
  WorkerEvent,
} from "./ttsProtocol";

// The request rule is shared with the browser build, so it lives in a file
// that does not import Electron. `ipc/ipcTts.ts` still reaches it from here.
export { coerceRequest } from "./ttsRequest";

/**
 * How long the worker outlives its last job.
 *
 * Long enough that writing several lines in a row does not reload 400MB each
 * time, short enough that the memory is back before the user notices. The
 * timer is cleared on every new job.
 */
const IDLE_SHUTDOWN_MS = 60000;

export const TOTAL_MODEL_BYTES = MODEL_TOTAL_BYTES;

export class TtsCancelled extends Error {
  constructor() {
    super("Synthesis cancelled");
    this.name = "TtsCancelled";
  }
}

function userData(): string {
  return app.getPath("userData");
}

export function ttsAvailability(): TtsAvailability {
  return availability(userData());
}

export function installModel(
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ downloaded: string[] }> {
  return downloadModel({
    userDataDir: userData(),
    fetch: netFetch,
    onProgress,
    signal,
  });
}

/** The running worker, if there is one. */
let worker: UtilityProcess | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/**
 * Compiled beside this file, so `__dirname` finds it in both layouts.
 *
 * Dev runs `main/lib/tts/tts.js` and packaged runs the same path inside the
 * asar. Neither needs `process.resourcesPath`, unlike the ffmpeg and STT
 * binaries, because this one is our own compiled JavaScript rather than an
 * extra resource copied in beside the app.
 */
function workerEntry(): string {
  return path.join(__dirname, "ttsWorker.js");
}

function clearIdleTimer(): void {
  if (idleTimer != null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function stopWorker(): void {
  clearIdleTimer();
  const running = worker;
  worker = null;
  running?.kill();
}

function armIdleShutdown(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Releases roughly 400MB. The next job pays about 700ms to load again,
    // which is the right trade for memory the user is not spending.
    stopWorker();
  }, IDLE_SHUTDOWN_MS);
}

function ensureWorker(): UtilityProcess {
  if (worker != null) {
    return worker;
  }
  const started = utilityProcess.fork(workerEntry(), [], {
    // Named so it is identifiable in Activity Monitor rather than showing up as
    // a second anonymous helper nobody can account for.
    serviceName: "cartcut-tts",
  });
  worker = started;
  started.on("exit", () => {
    if (worker === started) {
      worker = null;
    }
  });
  return started;
}

export type SpeakRequest = Omit<SynthesisRequest, "seed">;

export type SpeakOutput = {
  path: string;
  durationMs: number;
  sampleRate: number;
};

/**
 * Length and rate read straight from the header of a file we wrote.
 *
 * Cheaper than a probe, and safe because `ttsWav.ts` is the only thing that
 * writes into this directory: a fixed 44-byte canonical header, mono, 16-bit.
 */
function describeWav(file: string): { durationMs: number; sampleRate: number } {
  const header = Buffer.alloc(44);
  const handle = fs.openSync(file, "r");
  try {
    fs.readSync(handle, header, 0, 44, 0);
  } finally {
    fs.closeSync(handle);
  }
  const sampleRate = header.readUInt32LE(24) || 44100;
  const dataBytes = header.readUInt32LE(40);
  return {
    durationMs: Math.round((dataBytes / 2 / sampleRate) * 1000),
    sampleRate,
  };
}

/**
 * The spoken file for this request, made if it is not already cached.
 *
 * Cancellation kills the worker rather than asking it to stop. The denoising
 * loop spends most of its life inside a native `run`, so a cooperative flag
 * would only be read between steps and a long chunk would keep going for
 * seconds after the button was pressed. Killing costs the next job its 700ms
 * load, which is a fair price for work already abandoned.
 */
export async function ensureSpoken(
  request: SpeakRequest,
  onProgress?: (fraction: number, stage: TtsStage) => void,
  signal?: AbortSignal,
): Promise<SpeakOutput> {
  const state = availability(userData());
  if (!state.ok) {
    throw new Error(`The voice model is not installed (${state.reason}).`);
  }

  const key = speechKey(request);
  const dir = speechCacheDir(userData());
  const outPath = path.join(dir, `${key}.wav`);

  if (fs.existsSync(outPath)) {
    onProgress?.(1, "writing");
    return { path: outPath, ...describeWav(outPath) };
  }

  fs.mkdirSync(dir, { recursive: true });

  const jobId = key;
  const command: WorkerCommand = {
    type: "synthesize",
    jobId,
    modelDir: modelDir(userData()),
    outPath,
    request: { ...request, seed: seedFor(key) },
  };

  return new Promise<SpeakOutput>((resolve, reject) => {
    const child = ensureWorker();
    clearIdleTimer();

    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      child.removeListener("message", onMessage as never);
      signal?.removeEventListener("abort", onAbort);
      armIdleShutdown();
      finish();
    };

    const onMessage = (event: WorkerEvent) => {
      if (event.type === "progress" && event.jobId === jobId) {
        onProgress?.(event.fraction, event.stage);
        return;
      }
      if (event.type !== "done" || event.jobId !== jobId) {
        return;
      }
      if (event.ok) {
        const { path: file, durationMs, sampleRate } = event;
        settle(() => resolve({ path: file, durationMs, sampleRate }));
      } else {
        const { error } = event;
        settle(() => reject(new Error(error)));
      }
    };

    /**
     * A worker that dies with a job in flight must reject it.
     *
     * Without this the promise is never settled: the renderer's tray row sits
     * at whatever percent it reached, and the panel's Generate button stays
     * disabled until the app is restarted.
     */
    const onExit = () => {
      settle(() =>
        reject(
          signal?.aborted === true
            ? new TtsCancelled()
            : new Error("The synthesis process stopped unexpectedly."),
        ),
      );
    };

    const onAbort = () => {
      // The worker is inside native code; killing is the only certain way to
      // stop it. `stopWorker` clears the idle timer too.
      stopWorker();
      settle(() => reject(new TtsCancelled()));
    };

    child.on("message", onMessage as never);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    child.postMessage(command);
  });
}

/** Called on quit so a synthesis in flight cannot hold the app open. */
export function shutdownTts(): void {
  stopWorker();
}
