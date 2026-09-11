/**
 * The renderer's view of clip reversal: start, cancel, and a progress event.
 *
 * Jobs run **one at a time**, for the reason `ipcProxy.ts` gives for proxies —
 * two x264 encodes at once starve the same CPU the preview composites on, and
 * a reversal of heavy footage also holds up to the whole frame budget in
 * memory. Queued jobs report `stage: "queued"` so the tray can say so.
 *
 * The job id is the renderer's. It mints one before calling `start`, so the
 * tray row exists — and can be cancelled — before `start` resolves, which for
 * a long reversal is minutes later.
 */

import type { IpcMainInvokeEvent, WebContents } from "electron";
import { ensureReversed, type ReverseRequest } from "../lib/reverse";
import { CancelledError } from "../lib/reversePipeline";

export type ReverseJobResult =
  | { ok: true; path: string; durationMs: number; hasAudio: boolean }
  | { ok: false; cancelled?: boolean; error?: string };

type Job = {
  jobId: string;
  request: ReverseRequest;
  sender: WebContents;
  controller: AbortController;
  resolve: (result: ReverseJobResult) => void;
};

const queue: Job[] = [];
let active: Job | null = null;

/**
 * Send one progress line, skipping repeats. FFmpeg reports several times a
 * second per stage, and the renderer only draws whole percents.
 */
function progressSender(job: Job) {
  let lastPercent = -1;
  let lastStage = "";
  return (fraction: number | null, stage: string) => {
    const percent = fraction == null ? -1 : Math.floor(fraction * 100);
    if (percent === lastPercent && stage === lastStage) {
      return;
    }
    lastPercent = percent;
    lastStage = stage;
    if (!job.sender.isDestroyed()) {
      job.sender.send("reverse:progress", {
        jobId: job.jobId,
        fraction,
        stage,
      });
    }
  };
}

async function pump(): Promise<void> {
  if (active != null || queue.length === 0) {
    return;
  }
  const job = queue.shift()!;
  active = job;
  const send = progressSender(job);

  try {
    const output = await ensureReversed(
      job.request,
      (fraction, stage) => send(fraction, stage),
      job.controller.signal,
    );
    job.resolve({ ok: true, ...output });
  } catch (error) {
    if (error instanceof CancelledError || job.controller.signal.aborted) {
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

export const ipcReverse = {
  start: (
    event: IpcMainInvokeEvent,
    jobId: string,
    request: ReverseRequest,
  ): Promise<ReverseJobResult> =>
    new Promise((resolve) => {
      const job: Job = {
        jobId,
        request,
        sender: event.sender,
        controller: new AbortController(),
        resolve,
      };
      queue.push(job);
      if (active != null) {
        progressSender(job)(null, "queued");
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
