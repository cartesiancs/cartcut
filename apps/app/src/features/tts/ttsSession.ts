/**
 * One synthesis, from the button to a clip on the timeline.
 *
 * Returns an outcome and lets the caller perform it, the way
 * `caption/transcribeSession.ts` does: the panel owns what a failure looks
 * like, and a session that showed its own modal could not be tested.
 *
 * The finished file reaches the timeline through the ordinary import path,
 * `asset/importMedia.ts`, so a generated line lands exactly as a dropped file
 * does: on a free audio track, at the playhead, as one undo step.
 */

import { v4 as uuidv4 } from "uuid";

import { backgroundTaskStore } from "../../states/backgroundTaskStore";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { planImport, placeImported } from "../asset/importMedia";
import type { MediaProber } from "../element/mediaProbe";
import type { TtsPort, TtsStartRequest } from "./ttsPort";

const KIND = "tts";

export type SpeakOutcome =
  | { kind: "placed"; elementId: string; durationMs: number }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

let listening = false;

/**
 * One progress listener for every job, installed on first use.
 *
 * The same arrangement as `reverse/reverseSession.ts`. A listener per job
 * would leak one subscription per line synthesised.
 */
function listen(port: TtsPort): void {
  if (listening) {
    return;
  }
  listening = true;
  port.onProgress(({ jobId, fraction, stage }) => {
    backgroundTaskStore.getState().progress(jobId, fraction, stage);
  });
}

/** A short label for the tray row, so a long script does not fill it. */
export function trayLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > 32 ? `${flat.slice(0, 31)}...` : flat;
  return clipped.length > 0 ? `Speaking "${clipped}"` : "Speaking";
}

export type SpeakDeps = {
  port: TtsPort;
  /** Injected so a suite can fix the ids it asserts on. */
  mintId?: () => string;
  /** Reported as the job runs, for the panel's own progress screen. */
  onProgress?: (fraction: number | null, stage: string) => void;
  /**
   * How a finished file is measured.
   *
   * Defaults to the DOM prober, which needs an `<audio>` element and therefore
   * a browser. Injected so the placement half of this file runs under
   * `environment: "node"` like everything else worth checking.
   */
  prober?: MediaProber;
};

/**
 * Synthesise `request` and place the result at the playhead.
 *
 * The job id is minted **before** `start` is called, so the tray row exists and
 * can be cancelled while the model is still loading, which is the longest part
 * of a first run. `ipcTranscribe.ts` states the same reason for the same rule.
 */
export async function speak(
  request: TtsStartRequest,
  deps: SpeakDeps,
): Promise<SpeakOutcome> {
  const { port } = deps;
  listen(port);

  const jobId = (deps.mintId ?? uuidv4)();
  backgroundTaskStore.getState().add({
    id: jobId,
    kind: KIND,
    label: trayLabel(request.text),
    icon: "record_voice_over",
    fraction: 0,
    stage: "loading",
    cancel: () => void port.cancel(jobId),
  });

  const unsubscribe = deps.onProgress
    ? port.onProgress((payload) => {
        if (payload.jobId === jobId) {
          deps.onProgress?.(payload.fraction, payload.stage);
        }
      })
    : null;

  try {
    const reply = await port.start(jobId, request);

    if (!reply.ok) {
      return reply.cancelled === true
        ? { kind: "cancelled" }
        : { kind: "failed", message: reply.error ?? "Synthesis failed." };
    }
    return await place(reply.path, deps.prober);
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unsubscribe?.();
    backgroundTaskStore.getState().remove(jobId);
  }
}

/**
 * Put a finished file on the timeline, as one undo step.
 *
 * Nothing here knows the file came from synthesis. `planImport` probes it and
 * `placeImported` finds it a free audio track, which is what makes a generated
 * line behave exactly like an imported one from this point on.
 */
async function place(
  file: string,
  prober?: MediaProber,
): Promise<SpeakOutcome> {
  const plan = await planImport([file], prober);
  if (plan.ready.length === 0) {
    const reason = plan.skipped[0]?.reason ?? "The audio could not be read.";
    return { kind: "failed", message: reason };
  }

  const timeline = useTimelineStore.getState();
  const fps = renderOptionStore.getState().options.fps;
  let elementId = "";
  let durationMs = 0;

  timeline.withCheckpoint((doc) => {
    const { doc: next, createdIds } = placeImported(doc, plan, {
      startMs: timeline.cursor,
      fps,
      newId: () => uuidv4(),
    });
    elementId = createdIds[0] ?? "";
    durationMs = next.elements[elementId]?.duration ?? 0;
    return next;
  });

  return elementId.length > 0
    ? { kind: "placed", elementId, durationMs }
    : { kind: "failed", message: "The clip could not be placed." };
}
