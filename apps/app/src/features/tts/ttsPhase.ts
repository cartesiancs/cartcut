/**
 * What the panel draws, as data.
 *
 * The same arrangement as `features/caption/captionPhase.ts`, and for its
 * reason: copy written straight into a Lit template is copy nothing can check,
 * and the decisions here (when a bar is a bar, when it is a spinner, what the
 * button says about 400MB) are exactly the ones worth getting right.
 *
 * Nothing here touches the DOM or a store.
 */

export type TtsPhaseName =
  | "checking"
  | "needsModel"
  | "downloading"
  | "ready"
  | "speaking"
  | "failed";

export type TtsPhaseInput = {
  phase: TtsPhaseName;
  fraction?: number | null;
  /** The worker's stage: `loading`, `synthesizing`, `writing`, `queued`. */
  stage?: string;
  /** Bytes already on disk, for a download resumed after a failure. */
  presentBytes?: number;
  totalBytes?: number;
  message?: string;
};

export type TtsPhaseView = {
  title: string;
  note: string;
  /** 0 to 100, or `null` to draw a spinner rather than a bar. */
  percent: number | null;
  cancellable: boolean;
  failed: boolean;
};

/** Whole megabytes. A download this size is never interesting to a decimal. */
export function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/**
 * The size sentence shown before anything is downloaded.
 *
 * States the figure plainly, because the one thing a user must not discover
 * afterwards is that pressing a button cost them 400MB.
 */
export function downloadPrompt(totalBytes: number, presentBytes = 0): string {
  const total = megabytes(totalBytes);
  if (presentBytes > 0) {
    const left = megabytes(Math.max(0, totalBytes - presentBytes));
    return `About ${left} MB left of ${total} MB. The download was interrupted; it picks up where it stopped.`;
  }
  return `The voice model is about ${total} MB. It downloads once and stays on this computer.`;
}

/**
 * What the progress screen says, or `null` for "draw the ordinary body".
 *
 * `percent: null` means a spinner. A bar sitting at zero while real work
 * happens is a bar that says the work has not started, which is the point
 * `captionPhase.ts` makes about its own sweeping and revealing phases.
 */
export function ttsPhaseView(input: TtsPhaseInput): TtsPhaseView | null {
  switch (input.phase) {
    case "ready":
    case "needsModel":
      return null;

    case "checking":
      return {
        title: "Looking for the voice model...",
        note: "",
        percent: null,
        cancellable: false,
        failed: false,
      };

    case "downloading": {
      const total = input.totalBytes ?? 0;
      return {
        title: "Downloading the voice model...",
        note:
          total > 0
            ? `About ${megabytes(total)} MB. This happens once, and the model stays on this computer.`
            : "This happens once, and the model stays on this computer.",
        percent: percentOf(input.fraction),
        cancellable: true,
        failed: false,
      };
    }

    case "speaking":
      return {
        title: titleForStage(input.stage),
        note: noteForStage(input.stage),
        // Loading the model reports no meaningful fraction, so it spins.
        percent: input.stage === "loading" ? null : percentOf(input.fraction),
        cancellable: true,
        failed: false,
      };

    case "failed":
      return {
        title: "That did not work",
        note: input.message ?? "",
        percent: null,
        cancellable: false,
        failed: true,
      };
  }
}

function percentOf(fraction: number | null | undefined): number | null {
  if (fraction == null || !Number.isFinite(fraction)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function titleForStage(stage: string | undefined): string {
  switch (stage) {
    case "queued":
      return "Waiting for the previous line...";
    case "loading":
      return "Loading the voice model...";
    case "writing":
      return "Writing the audio...";
    default:
      return "Speaking...";
  }
}

function noteForStage(stage: string | undefined): string {
  // Said only while loading, because that is the one wait with no visible
  // progress and the only one a user would otherwise read as a hang.
  return stage === "loading"
    ? "The first line after opening the app takes a moment longer."
    : "";
}
