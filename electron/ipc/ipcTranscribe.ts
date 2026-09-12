/**
 * The renderer's view of transcription: start, cancel, and a progress event.
 *
 * Jobs run **one at a time**, for the reason `ipcReverse.ts` gives for
 * reversals — the recogniser holds a language model and two of them at once
 * starve the same machine the preview composites on. Queued jobs report
 * `stage: "queued"`.
 *
 * The job id is the renderer's. It mints one before calling `start`, so the
 * panel can cancel a first-run model download — which is the long one — before
 * `start` has resolved.
 *
 * Everything goes through `transcribeFile`, the same function the MCP
 * `get_transcript` tool calls. That is deliberate: one disk cache, one ffmpeg
 * pass per clip, and a clip the agent has already transcribed opens instantly
 * in the panel.
 */

import type { IpcMainInvokeEvent, WebContents } from "electron";
import { groupWords, type TranscriptWord } from "../mcp/analysis/segments";
import {
  appleSpeechLocales,
  transcribeFile,
  type TranscribeStage,
  type TranscriptMethod,
} from "../mcp/transcribe";
import { SpeechCancelledError } from "../lib/speechStt";

export type TranscribeRequest = {
  /** A clip's `localpath` — a `file://` URL. `transcribeFile` converts it. */
  source: string;
  method?: TranscriptMethod;
  locale?: string;
};

export type TranscribeJobResult =
  | {
      ok: true;
      /**
       * Words already grouped into caption lines.
       *
       * Grouped here rather than in the renderer because `analysis/segments.ts`
       * owns where a caption breaks and is where that rule is tested. The panel
       * needs the words of each line, not the joined text, so it gets
       * `groupWords` rather than the `segments` an agent reads.
       */
      lines: TranscriptWord[][];
      method: TranscriptMethod;
    }
  | { ok: false; cancelled?: boolean; error?: string };

type Job = {
  jobId: string;
  request: TranscribeRequest;
  sender: WebContents;
  controller: AbortController;
  resolve: (result: TranscribeJobResult) => void;
};

const queue: Job[] = [];
let active: Job | null = null;

/**
 * Send one progress line, skipping repeats.
 *
 * A model download reports many times a second and the panel draws whole
 * percents. The stage is part of the comparison because 100% of downloading
 * and 0% of transcribing are different things to say.
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
      job.sender.send("transcribe:progress", { jobId: job.jobId, fraction, stage });
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
    const transcript = await transcribeFile(job.request.source, job.request.method, {
      locale: job.request.locale,
      onProgress: (fraction: number, stage: TranscribeStage) => send(fraction, stage),
      signal: job.controller.signal,
    });
    job.resolve({
      ok: true,
      lines: groupWords(transcript.words),
      method: transcript.method,
    });
  } catch (error) {
    if (error instanceof SpeechCancelledError || job.controller.signal.aborted) {
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

export const ipcTranscribe = {
  /** The languages this Mac can transcribe on device, and whether it can at all. */
  locales: () => appleSpeechLocales(),

  start: (
    event: IpcMainInvokeEvent,
    jobId: string,
    request: TranscribeRequest,
  ): Promise<TranscribeJobResult> =>
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
