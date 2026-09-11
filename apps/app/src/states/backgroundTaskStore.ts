/**
 * Long-running work the user is waiting on, for the tray in the bottom-left.
 *
 * Generic on purpose. Reversing a clip is the first thing here, but anything
 * that takes minutes and runs while the user goes on editing has the same four
 * needs — a name, a fraction, a way to cancel, and to disappear when done — and
 * a second tray for the second such job would be one too many.
 *
 * `subject` names what a task is working on, so a panel can ask "is this clip
 * being reversed?" of the same list the tray draws from. One source of truth:
 * a separate pending-set would have to be kept in step with this one, and the
 * moment they disagreed a button would stay disabled forever.
 */

import { createStore } from "zustand/vanilla";

export type BackgroundTask = {
  id: string;
  /** What kind of work, e.g. `"reverse"`. */
  kind: string;
  /** The thing it is working on — an element id for a reversal. */
  subject?: string;
  label: string;
  /** Material icon name for the tray row. */
  icon?: string;
  /** 0..1, or `null` while there is no estimate yet. */
  fraction: number | null;
  /** `"queued"` while waiting behind another job; otherwise free-form. */
  stage: string;
  cancel?: () => void;
};

export interface IBackgroundTaskStore {
  tasks: BackgroundTask[];
  add: (task: BackgroundTask) => void;
  progress: (id: string, fraction: number | null, stage: string) => void;
  remove: (id: string) => void;
}

const percentOf = (fraction: number | null) =>
  fraction == null ? -1 : Math.floor(fraction * 100);

export const backgroundTaskStore = createStore<IBackgroundTaskStore>(
  (set, get) => ({
    tasks: [],

    add: (task) => {
      if (get().tasks.some((existing) => existing.id === task.id)) {
        return;
      }
      set({ tasks: [...get().tasks, task] });
    },

    // Guarded before `set`: a zustand `set` notifies every subscriber even
    // when nothing changed, and FFmpeg reports several times a second. Only a
    // new whole percent or a new stage is worth a repaint.
    progress: (id, fraction, stage) => {
      const tasks = get().tasks;
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) {
        return;
      }
      const current = tasks[index];
      if (
        percentOf(current.fraction) === percentOf(fraction) &&
        current.stage === stage
      ) {
        return;
      }
      const next = [...tasks];
      next[index] = { ...current, fraction, stage };
      set({ tasks: next });
    },

    remove: (id) => {
      const tasks = get().tasks;
      if (!tasks.some((task) => task.id === id)) {
        return;
      }
      set({ tasks: tasks.filter((task) => task.id !== id) });
    },
  }),
);

/** The running or queued task of `kind` working on `subject`, if any. */
export function taskFor(
  kind: string,
  subject: string,
): BackgroundTask | undefined {
  return backgroundTaskStore
    .getState()
    .tasks.find((task) => task.kind === kind && task.subject === subject);
}
