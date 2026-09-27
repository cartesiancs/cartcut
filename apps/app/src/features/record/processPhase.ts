/**
 * What the processing dialog says, as data.
 *
 * The same split `features/caption/captionPhase.ts` and `features/tts/ttsPhase.ts`
 * make, and for the same reason: there is no DOM test environment here, so copy and
 * percentages decided inside a Lit class are rules nothing can check. The component
 * renders whatever this returns and makes no decisions of its own.
 *
 * `percent: null` draws a spinner rather than a bar, and not as a shortcut: the
 * mux is the only slow step and FFmpeg is copying a stream whose length nobody has
 * measured, so any number here would be invented. `ttsPhase.ts` models the same
 * distinction.
 */

export type ProcessStage =
  /** Main is muxing. The slow one, and the only one with no measurable progress. */
  | "finishing"
  /** The editor is reading the input sidecar. */
  | "reading"
  /** Segments, then the camera path. */
  | "planning"
  /** Fitting the clip and writing the keyframes. */
  | "placing"
  | "done"
  | "failed";

export type ProcessState = {
  stage: ProcessStage;
  /** Set only on `failed`, and only to something a person can act on. */
  message?: string;
};

export const IDLE: ProcessState = { stage: "done" };

export type ProcessView = {
  open: boolean;
  title: string;
  detail: string;
  /** 0 to 100, or `null` for a spinner. */
  percent: number | null;
  /** Whether abandoning the zoom is still possible. */
  cancellable: boolean;
  failed: boolean;
};

/**
 * Where each stage sits on the bar.
 *
 * Hand-placed rather than evenly spaced, because the stages are not evenly long:
 * the mux dominates everything else put together, so the bar has to spend most of
 * itself there or it would sit at 75% for the whole wait and then finish instantly.
 * `finishing` is a spinner anyway; these are where the bar *resumes* from.
 */
const AT: Record<ProcessStage, number> = {
  finishing: 0,
  reading: 70,
  planning: 82,
  placing: 94,
  done: 100,
  failed: 100,
};

const COPY: Record<ProcessStage, { title: string; detail: string }> = {
  finishing: {
    title: "Finishing the recording",
    detail: "Writing the video file.",
  },
  reading: {
    title: "Reading the recording",
    detail: "Looking at where the pointer went.",
  },
  planning: {
    title: "Planning the zooms",
    detail: "Deciding what to move toward, and when.",
  },
  placing: {
    title: "Adding it to the timeline",
    detail: "Fitting the clip and writing its keyframes.",
  },
  done: { title: "Done", detail: "" },
  failed: {
    title: "Could not finish the zoom",
    detail: "The recording is on the timeline without it.",
  },
};

export function processView(state: ProcessState): ProcessView {
  const copy = COPY[state.stage] ?? COPY.failed;

  return {
    open: state.stage !== "done",
    title: copy.title,
    // A message from the failure outranks the generic line, when there is one.
    detail: state.stage === "failed" && state.message ? state.message : copy.detail,
    // The mux is the one step with nothing honest to report.
    percent: state.stage === "finishing" ? null : AT[state.stage],
    // Not during the mux: the recording is still being written and there is nothing
    // to abandon that would not lose the take.
    cancellable: state.stage === "reading" || state.stage === "planning",
    failed: state.stage === "failed",
  };
}

/**
 * Whether one stage may follow another.
 *
 * The dialog is driven from two places (a push from main when the mux starts, and
 * the editor's own work once the file arrives) and those are not ordered against
 * each other. A `complete` that overtakes its own `processing` notice would
 * otherwise walk the dialog backwards from `placing` to `finishing` and leave it
 * open forever.
 */
const ORDER: ProcessStage[] = [
  "finishing",
  "reading",
  "planning",
  "placing",
  "done",
];

export function advances(from: ProcessStage, to: ProcessStage): boolean {
  if (to === "failed") {
    return from !== "done";
  }
  if (from === "failed") {
    // Only a new recording clears a failure, and that starts at the beginning.
    return to === "finishing" || to === "done";
  }
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}
