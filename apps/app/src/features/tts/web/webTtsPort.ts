/**
 * The browser build's `TtsPort`: the five calls the preload bridge answers on
 * the desktop, answered here by Cache Storage and a worker.
 *
 * Shaped after `electron/ipc/ipcTts.ts` and `lib/tts/tts.ts` together, and for
 * their reasons: one job at a time behind a queue (the worker holds 400MB of
 * weights, and two would hold 800MB beside the editor), a job id minted by the
 * caller so the tray row can be cancelled before anything starts, cancel as a
 * terminate (the worker spends its life inside WebAssembly, where a flag would
 * be read only between steps), and a worker that exits after a minute idle.
 *
 * A request is coerced and keyed by the desktop's own rules
 * (`ttsRequest.ts`, `ttsKeyInput.ts`), so the same line in the same voice
 * starts from the same noise in either build and sounds the same. Lines spoken
 * this session are remembered by that key, the way the desktop caches its
 * `.wav` files, and come back without waking the worker.
 *
 * Everything browser-shaped is a port in `WebTtsDeps`, so this runs under
 * `environment: "node"` against fakes. `browserTts.ts` supplies the real ones.
 */

import {
  MODEL_LICENSE,
  MODEL_REPO,
  VOICE_IDS,
  type ModelFile,
} from "../../../../../../electron/lib/tts/ttsManifest";
import {
  keyFromDigest,
  seedFor,
  speechKeyInput,
} from "../../../../../../electron/lib/tts/ttsKeyInput";
import type { TtsStage } from "../../../../../../electron/lib/tts/ttsProtocol";
import { coerceRequest } from "../../../../../../electron/lib/tts/ttsRequest";
import type {
  TtsAvailabilityReply,
  TtsDownloadReply,
  TtsPort,
  TtsProgress,
  TtsStartReply,
} from "../ttsPort";
import {
  ModelDownloadCancelled,
  downloadModelToCache,
  modelState,
  type DigestPort,
  type FetchPort,
  type ModelCache,
} from "./webModelStore";
import type { WebWorkerCommand, WebWorkerEvent } from "./webTtsProtocol";

/** How long the worker outlives its last job: the desktop's figure. */
export const IDLE_SHUTDOWN_MS = 60000;

export type WorkerLike = {
  post(command: WebWorkerCommand): void;
  terminate(): void;
};

export type WorkerHandlers = {
  onEvent(event: WebWorkerEvent): void;
  /** The worker died: an uncaught error, a script that failed to load. */
  onFailure(message: string): void;
};

export type Timers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type WebTtsDeps = {
  openCache(): Promise<ModelCache>;
  fetch: FetchPort;
  digest: DigestPort;
  /** SHA-1 of `text` as lowercase hex: the hash the desktop's key is made with. */
  sha1(text: string): Promise<string>;
  spawnWorker(handlers: WorkerHandlers): WorkerLike;
  /** Hand a finished file to the editor, and answer the path to import it by. */
  register(wav: Uint8Array, name: string): string;
  freeBytes?(): Promise<number | null>;
  /** Drop other model revisions' caches; failures are ignored. */
  pruneStale?(): Promise<unknown>;
  /** Injected so a suite can walk a manifest of a few bytes. */
  files?: readonly ModelFile[];
  timers?: Timers;
};

type Spoken = { path: string; durationMs: number; sampleRate: number };

type Job = {
  jobId: string;
  raw: unknown;
  /** Set by `cancel` at any point; read after every await. */
  cancelled: boolean;
  resolve(reply: TtsStartReply): void;
  /** Present while the worker holds the job: stops it there. */
  abort?: () => void;
};

const CANCELLED: TtsStartReply = { ok: false, cancelled: true };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebTtsPort(deps: WebTtsDeps): TtsPort {
  const files = deps.files;
  const timers: Timers = deps.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const listeners = new Set<(payload: TtsProgress) => void>();

  /**
   * One progress line per change, as `ipcTts.ts#progressSender` sends them:
   * the stage is part of the comparison, or the step from 100% loading to 0%
   * synthesising would be swallowed.
   */
  function progressSender(jobId: string) {
    let lastPercent = -1;
    let lastStage = "";
    return (fraction: number | null, stage: TtsStage) => {
      const percent = fraction == null ? -1 : Math.floor(fraction * 100);
      if (percent === lastPercent && stage === lastStage) {
        return;
      }
      lastPercent = percent;
      lastStage = stage;
      for (const handler of [...listeners]) {
        handler({ jobId, fraction, stage });
      }
    };
  }

  // The worker, and the handlers of the job it is holding.
  let worker: WorkerLike | null = null;
  let holder: WorkerHandlers | null = null;
  let idle: unknown = null;

  function clearIdle(): void {
    if (idle != null) {
      timers.clear(idle);
      idle = null;
    }
  }

  function stopWorker(): void {
    clearIdle();
    const running = worker;
    worker = null;
    running?.terminate();
  }

  function armIdle(): void {
    clearIdle();
    idle = timers.set(() => {
      idle = null;
      stopWorker();
    }, IDLE_SHUTDOWN_MS);
  }

  function ensureWorker(): WorkerLike {
    if (worker != null) {
      return worker;
    }
    const spawned: WorkerLike = deps.spawnWorker({
      onEvent: (event) => {
        if (worker === spawned) {
          holder?.onEvent(event);
        }
      },
      onFailure: (message) => {
        if (worker !== spawned) {
          return;
        }
        // Dead either way; the next job starts a fresh one.
        worker = null;
        spawned.terminate();
        holder?.onFailure(message);
      },
    });
    worker = spawned;
    return spawned;
  }

  const spoken = new Map<string, Spoken>();
  const queue: Job[] = [];
  let active: Job | null = null;

  async function run(job: Job): Promise<TtsStartReply> {
    const send = progressSender(job.jobId);
    const request = coerceRequest((job.raw ?? {}) as Record<string, unknown>);
    const key = keyFromDigest(await deps.sha1(speechKeyInput(request)));
    if (job.cancelled) {
      return CANCELLED;
    }

    const made = spoken.get(key);
    if (made != null) {
      send(1, "writing");
      return { ok: true, ...made };
    }

    const state = await modelState(await deps.openCache(), files);
    if (job.cancelled) {
      return CANCELLED;
    }
    if (!state.complete) {
      return {
        ok: false,
        error: "The voice model is not installed. Download the voices first.",
      };
    }

    const child = ensureWorker();
    clearIdle();

    return new Promise<TtsStartReply>((resolve) => {
      let settled = false;
      const settle = (reply: TtsStartReply) => {
        if (settled) {
          return;
        }
        settled = true;
        holder = null;
        job.abort = undefined;
        if (worker != null) {
          armIdle();
        }
        resolve(reply);
      };

      holder = {
        onEvent: (event) => {
          if (event.jobId !== job.jobId) {
            return;
          }
          if (event.type === "progress") {
            send(event.fraction, event.stage);
            return;
          }
          if (!event.ok) {
            settle({ ok: false, error: event.error });
            return;
          }
          try {
            const path = deps.register(
              new Uint8Array(event.wav),
              `speech-${key}.wav`,
            );
            const output: Spoken = {
              path,
              durationMs: event.durationMs,
              sampleRate: event.sampleRate,
            };
            spoken.set(key, output);
            settle({ ok: true, ...output });
          } catch (error) {
            settle({ ok: false, error: messageOf(error) });
          }
        },
        // Without this the job never settles: the tray row sits at whatever
        // percent it reached and Generate stays disabled for the session.
        onFailure: (message) =>
          settle({
            ok: false,
            error: `The synthesis process stopped unexpectedly (${message}).`,
          }),
      };

      job.abort = () => {
        stopWorker();
        settle(CANCELLED);
      };

      child.post({
        type: "synthesize",
        jobId: job.jobId,
        request: { ...request, seed: seedFor(key) },
      });
    });
  }

  async function pump(): Promise<void> {
    if (active != null || queue.length === 0) {
      return;
    }
    const job = queue.shift()!;
    active = job;
    try {
      job.resolve(await run(job));
    } catch (error) {
      job.resolve(
        job.cancelled ? CANCELLED : { ok: false, error: messageOf(error) },
      );
    } finally {
      active = null;
      void pump();
    }
  }

  /** The one download, if there is one. Two would fight over the same files. */
  let download: { jobId: string; controller: AbortController } | null = null;

  return {
    async availability(): Promise<TtsAvailabilityReply> {
      await deps.pruneStale?.().catch(() => undefined);
      const state = await modelState(await deps.openCache(), files);
      return {
        ok: state.complete,
        ...(state.complete
          ? {}
          : {
              reason:
                state.presentBytes === 0
                  ? ("models_not_installed" as const)
                  : ("models_incomplete" as const),
              presentBytes: state.presentBytes,
            }),
        totalBytes: state.totalBytes,
        voices: VOICE_IDS,
        repo: MODEL_REPO,
        license: MODEL_LICENSE,
        storage: "browser",
      };
    },

    async download(jobId: string): Promise<TtsDownloadReply> {
      if (download != null) {
        return { ok: false, error: "A model download is already running." };
      }
      const controller = new AbortController();
      download = { jobId, controller };
      const send = progressSender(jobId);
      try {
        const result = await downloadModelToCache({
          cache: await deps.openCache(),
          fetch: deps.fetch,
          digest: deps.digest,
          files,
          onProgress: (fraction) => send(fraction, "downloading"),
          signal: controller.signal,
          freeBytes: deps.freeBytes,
        });
        return { ok: true, downloaded: result.downloaded };
      } catch (error) {
        if (error instanceof ModelDownloadCancelled || controller.signal.aborted) {
          return { ok: false, cancelled: true };
        }
        return { ok: false, error: messageOf(error) };
      } finally {
        download = null;
      }
    },

    async cancelDownload(jobId: string) {
      if (download?.jobId === jobId) {
        download.controller.abort();
      }
      return { ok: true };
    },

    start(jobId: string, request: unknown): Promise<TtsStartReply> {
      return new Promise((resolve) => {
        queue.push({ jobId, raw: request, cancelled: false, resolve });
        if (active != null) {
          progressSender(jobId)(null, "queued");
        }
        void pump();
      });
    },

    /** Drop a queued job, or stop the running one. Unknown ids are ignored. */
    async cancel(jobId: string) {
      if (active?.jobId === jobId) {
        active.cancelled = true;
        active.abort?.();
        return { ok: true };
      }
      const index = queue.findIndex((job) => job.jobId === jobId);
      if (index >= 0) {
        const [job] = queue.splice(index, 1);
        job.resolve(CANCELLED);
      }
      return { ok: true };
    },

    onProgress(handler: (payload: TtsProgress) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
