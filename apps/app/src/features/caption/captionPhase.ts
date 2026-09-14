/**
 * What the panel shows while it is working.
 *
 * This used to be a Bootstrap modal over the whole app (`#AnalyzingVideo`), and
 * a modal was the wrong shape for it twice over. The panel is a window docked
 * beside the preview now, so covering the editor to say that one window is busy
 * is out of proportion; and the work no longer ends when the transcript lands,
 * because the session then sweeps the silences and reveals the edit. A dialog
 * that closes and reopens twice for one press is worse than no dialog.
 *
 * So the phases are a region inside the panel, and they are decided here for
 * the reason `silenceButton.ts` gives about itself: `apps/automatic-caption/` is
 * outside every vitest include pattern, so copy written into a Lit template is
 * copy nothing can check.
 *
 * The panel renders `null` as "no progress screen, show the ordinary body",
 * which is what `setup` and `live` are.
 */

import { progressCopy, progressPercent } from "./transcribeSession";

export type CaptionPhase =
  /** No clip chosen yet. The method, the language and Load video. */
  | "setup"
  /** Main is extracting, downloading a model, queued or recognising. */
  | "transcribing"
  /** One ffmpeg decode, looking for the silent gaps. */
  | "sweeping"
  /** The cuts and captions are landing on the timeline. */
  | "revealing"
  /** The caption list, the footer, and a timeline that is already edited. */
  | "live"
  | "failed";

export type CaptionPhaseInput = {
  phase: CaptionPhase;
  /** Main's own stage word. Meaningful for `transcribing` alone. */
  stage?: string;
  /** 0..1 from main, or 0 when it has said nothing yet. */
  fraction?: number;
  /** What went wrong. Meaningful for `failed` alone. */
  message?: string;
};

export type CaptionPhaseView = {
  title: string;
  note: string;
  /**
   * The bar's width as a whole percent, or null for a phase whose length
   * nothing can estimate.
   *
   * Null draws a spinner instead. A bar that sits at zero while real work
   * happens is a bar that says the work has not started.
   */
  percent: number | null;
  /** Whether Cancel does anything here. */
  cancellable: boolean;
  /** Whether this is the failure screen, which is styled as a warning. */
  failed: boolean;
};

const NOTE_SWEEP = "Finding the gaps where nobody is speaking.";
const NOTE_REVEAL = "Cutting the silences and laying the captions down.";

/**
 * The screen, or null when the phase has none.
 *
 * `sweeping` and `revealing` report no percentage on purpose. The sweep is one
 * ffmpeg decode with no intermediate output, which is the same reason
 * `ipcAnalyze` carries no progress channel at all; and the reveal is over in
 * about a second, where a bar would be a flicker and the timeline itself is
 * already showing what is happening.
 */
export function captionPhaseView(
  input: CaptionPhaseInput,
): CaptionPhaseView | null {
  switch (input.phase) {
    case "setup":
    case "live":
      return null;

    case "transcribing": {
      const copy = progressCopy(input.stage ?? "");
      return {
        title: copy.title,
        note: copy.note,
        percent: progressPercent(input.fraction ?? 0),
        cancellable: true,
        failed: false,
      };
    }

    case "sweeping":
      return {
        title: "Finding the silent gaps...",
        note: NOTE_SWEEP,
        percent: null,
        cancellable: false,
        failed: false,
      };

    case "revealing":
      return {
        title: "Applying to the timeline...",
        note: NOTE_REVEAL,
        percent: null,
        cancellable: false,
        failed: false,
      };

    case "failed":
      return {
        title: "That did not work",
        // Never empty: a failure screen with no reason on it is indistinguishable
        // from the app having given up without being asked.
        note:
          input.message != null && input.message.trim().length > 0
            ? input.message
            : "Transcription failed.",
        percent: null,
        cancellable: false,
        failed: true,
      };
  }
}
