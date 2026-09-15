/**
 * The renderer's view of speech synthesis: availability, the model download,
 * start, cancel, and one progress event.
 *
 * The shape is `ipcReverse.ts`'s, deliberately: a queue, one active job, a
 * `pump` that recurses in `finally`, an `AbortController` per job, and a
 * `progressSender` that drops repeats. Synthesis runs **one at a time** for the
 * reason proxies and reversals do, with one extra: the worker holds 400MB of
 * weights, and two of them would hold 800MB while the editor is still
 * compositing.
 *
 * The job id is the renderer's. It mints one before calling, so the tray row
 * exists and can be cancelled before `start` resolves, which for a first-run
 * model download is several minutes later.
 */

import type { IpcMainInvokeEvent, WebContents } from "electron";

import {
  TtsCancelled,
  ensureSpoken,
  coerceRequest,
  installModel,
  ttsAvailability,
  TOTAL_MODEL_BYTES,
  type SpeakRequest,
} from "../lib/tts/tts";
import { DownloadCancelledError } from "../lib/tts/ttsDownload";
import { VOICE_IDS, MODEL_LICENSE, MODEL_REPO } from "../lib/tts/ttsManifest";
import type { TtsStage } from "../lib/tts/ttsProtocol";

export type TtsJobResult =
  | { ok: true; path: string; durationMs: number; sampleRate: number }
  | { ok: false; cancelled?: boolean; error?: string };

export type TtsDownloadResult =
  | { ok: true; downloaded: string[] }
  | { ok: false; cancelled?: boolean; error?: string };

type Job = {
  jobId: string;
  request: SpeakRequest;
  sender: WebContents;
  controller: AbortController;
  resolve: (result: TtsJobResult) => void;
};

const queue: Job[] = [];
let active: Job | null = null;

/** The one download, if there is one. Two would fight over the same files. */
let download: { jobId: string; controller: AbortController } | null = null;

/**
 * Send one progress line, skipping repeats.
 *
 * The stage is part of the comparison because 100% of `loading` and 0% of
 * `synthesizing` are different things to say, and a percent-only check would
 * swallow the transition between them.
 */
function progressSender(jobId: string, sender: WebContents) {
  let lastPercent = -1;
  let lastStage = "";
  return (fraction: number | null, stage: TtsStage) => {
    const percent = fraction == null ? -1 : Math.floor(fraction * 100);
    if (percent === lastPercent && stage === lastStage) {
      return;
    }
    lastPercent = percent;
    lastStage = stage;
    if (!sender.isDestroyed()) {
      sender.send("tts:progress", { jobId, fraction, stage });
    }
  };
}

async function pump(): Promise<void> {
  if (active != null || queue.length === 0) {
    return;
  }
  const job = queue.shift()!;
  active = job;
  const send = progressSender(job.jobId, job.sender);

  try {
    const output = await ensureSpoken(
      job.request,
      (fraction, stage) => send(fraction, stage),
      job.controller.signal,
    );
    job.resolve({ ok: true, ...output });
  } catch (error) {
    if (error instanceof TtsCancelled || job.controller.signal.aborted) {
      job.resolve({ ok: false, cancelled: true });
    } else {
      job.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    active = null;
    void pump();
  }
}

export const ipcTts = {
  /**
   * Whether synthesis can run, decided in JS before any process starts.
   *
   * The same rule `speechBin.ts` follows. Note there is no platform gate:
   * ONNX Runtime ships for darwin, win32 and linux alike.
   */
  availability: async () => ({
    ...ttsAvailability(),
    totalBytes: TOTAL_MODEL_BYTES,
    voices: VOICE_IDS,
    repo: MODEL_REPO,
    license: MODEL_LICENSE,
  }),

  /**
   * Fetch the model. Roughly 400MB, so the renderer asks first.
   *
   * Reports on the same `tts:progress` channel as synthesis, under the
   * `downloading` stage, so the panel has one subscription and not two.
   */
  download: async (
    event: IpcMainInvokeEvent,
    jobId: string,
  ): Promise<TtsDownloadResult> => {
    if (download != null) {
      return { ok: false, error: "A model download is already running." };
    }
    const controller = new AbortController();
    download = { jobId, controller };
    const send = progressSender(jobId, event.sender);

    try {
      const result = await installModel(
        (progress) => send(progress.fraction, "downloading"),
        controller.signal,
      );
      return { ok: true, downloaded: result.downloaded };
    } catch (error) {
      if (error instanceof DownloadCancelledError || controller.signal.aborted) {
        return { ok: false, cancelled: true };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      download = null;
    }
  },

  cancelDownload: async (_event: IpcMainInvokeEvent, jobId: string) => {
    if (download?.jobId === jobId) {
      download.controller.abort();
    }
    return { ok: true };
  },

  /**
   * Synthesise one piece of text.
   *
   * The request is coerced here rather than trusted: this is the boundary, and
   * everything downstream may then assume a usable voice, a known language and
   * a step count inside the range the model behaves in.
   */
  start: (
    event: IpcMainInvokeEvent,
    jobId: string,
    request: unknown,
  ): Promise<TtsJobResult> =>
    new Promise((resolve) => {
      const job: Job = {
        jobId,
        request: coerceRequest((request ?? {}) as Record<string, unknown>),
        sender: event.sender,
        controller: new AbortController(),
        resolve,
      };
      queue.push(job);
      if (active != null) {
        progressSender(jobId, event.sender)(null, "queued");
      }
      void pump();
    }),

  /** Drop a queued job, or kill the running one. Unknown ids are ignored. */
  cancel: async (_event: IpcMainInvokeEvent, jobId: string) => {
    if (active?.jobId === jobId) {
      active.controller.abort();
      return { ok: true };
    }
    const index = queue.findIndex((job) => job.jobId === jobId);
    if (index >= 0) {
      const [job] = queue.splice(index, 1);
      job.resolve({ ok: false, cancelled: true });
    }
    return { ok: true };
  },
};
