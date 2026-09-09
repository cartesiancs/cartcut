import { createStore } from "zustand/vanilla";
import {
  nextPhase,
  type ExportEvent,
  type ExportPhase,
} from "../features/export/exportPhase";

/**
 * What an export looks like from the outside.
 *
 * The numbers only — the strings ("Estimating…", "40s left") belong to the
 * component that draws them, which is the half that can reach a
 * `LocaleController`. This replaces the `#progress` / `#remainingTime` nodes
 * `exportProgress` used to write into: those lived inside a Bootstrap modal,
 * and the modal is gone.
 *
 * `features/export/exportProgress.ts` is the only writer of `percent` and
 * `remainingMs`; it still owns the ETA machinery and now publishes here
 * instead of painting.
 */
export interface IExportStore {
  phase: ExportPhase;

  /**
   * 0..100, and it is **work done, not frames done** — `cost.ts` weights a
   * busy stretch of timeline against a sparse one, which is what keeps the bar
   * advancing at a roughly constant rate in time.
   */
  percent: number;

  /** Whole ms left, or `null` while warming up and while finalizing. */
  remainingMs: number | null;

  /**
   * Where the last export was written.
   *
   * Deliberately **not** cleared when one ends: the completion dialog's
   * "Open Saved Folder" reads it after the fact. It used to read
   * `#projectFolder`, which is a different directory entirely.
   */
  destination: string;

  begin: (destination: string) => void;
  dispatch: (event: ExportEvent) => void;
  /** Both numbers in one write, so the UI is woken once rather than twice. */
  report: (percent: number, remainingMs: number | null) => void;
  /** Main is authoritative about the file it actually wrote. */
  setDestination: (destination: string) => void;
}

/** Whole percent is all the ring draws; whole seconds are all the panel shows. */
function samePaint(
  a: { percent: number; remainingMs: number | null },
  b: { percent: number; remainingMs: number | null },
): boolean {
  const seconds = (ms: number | null) => (ms == null ? null : Math.ceil(ms / 1000));
  return (
    Math.round(a.percent) === Math.round(b.percent) &&
    seconds(a.remainingMs) === seconds(b.remainingMs)
  );
}

export const exportStore = createStore<IExportStore>((set, get) => ({
  phase: "idle",
  percent: 0,
  remainingMs: null,
  destination: "",

  begin: (destination: string) =>
    set({
      phase: nextPhase(get().phase, "start"),
      percent: 0,
      remainingMs: null,
      destination,
    }),

  dispatch: (event: ExportEvent) => {
    const phase = nextPhase(get().phase, event);
    // Identity, from a pure op that declines by returning its input. Same
    // rule `proxyStore.setMode` and `withCheckpoint` keep: a write that
    // changes nothing must not repaint the button.
    if (phase === get().phase) {
      return;
    }
    set({ phase });
  },

  report: (percent: number, remainingMs: number | null) => {
    const clamped = Math.max(0, Math.min(100, percent));
    const next = { percent: clamped, remainingMs };
    // An 18,000-frame export writing once per frame would be 18,000 Lit
    // renders of a component drawing an SVG, on the thread that is also
    // moving 8MB per frame into a pipe. Nothing on screen can show the
    // difference between 41.2% and 41.4%.
    if (samePaint(get(), next)) {
      return;
    }
    set(next);
  },

  setDestination: (destination: string) => {
    if (destination === "" || destination === get().destination) {
      return;
    }
    set({ destination });
  },
}));
