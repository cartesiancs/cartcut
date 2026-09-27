/**
 * What the recording-processing dialog is showing.
 *
 * Its own store rather than state on the component, for the reason
 * `features/export/exportProgress.ts` documents about itself: the work outlives the
 * thing that started it. A recording's processing begins with a push from main
 * while the editor may not even be the front window, and ends several awaits later
 * inside an import; a component that owned this would have to survive both, and the
 * editor is free to close and reopen panels in between.
 *
 * Every decision about what the dialog *says* is in
 * `features/record/processPhase.ts`, which is node-testable. This only holds the
 * stage and refuses to move it backwards.
 */

import { createStore } from "zustand/vanilla";
import {
  advances,
  IDLE,
  type ProcessStage,
  type ProcessState,
} from "../features/record/processPhase";

export interface IRecordProcessStore extends ProcessState {
  /** Move on, if that is forward. Declines silently otherwise. */
  enter: (stage: ProcessStage, message?: string) => void;
  /** Close the dialog, from the button or from the end of the work. */
  clear: () => void;
  /** Set by the dialog's Cancel, read by the orchestration between awaits. */
  cancelled: boolean;
  cancel: () => void;
}

export const recordProcessStore = createStore<IRecordProcessStore>((set, get) => ({
  ...IDLE,
  cancelled: false,

  enter: (stage, message) => {
    const current = get();
    if (!advances(current.stage, stage)) {
      return;
    }
    // A new recording clears the previous one's cancellation, and nothing else does:
    // clearing it on every stage change would let a Cancel pressed during `reading`
    // be forgotten by the time `planning` checked it.
    const cancelled = stage === "finishing" ? false : current.cancelled;
    set({ stage, message, cancelled });
  },

  clear: () => set({ ...IDLE, message: undefined, cancelled: false }),

  cancel: () => set({ cancelled: true }),
}));
