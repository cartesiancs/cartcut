/**
 * Where an export is in its life, as a transition table.
 *
 * Pure and DOM-free, so the phase can be reasoned about without a store, a
 * timer or an FFmpeg process. `exportStore` holds the current value and
 * `exportSession` supplies the events.
 *
 * The reason this is four states rather than a boolean is `cancelling`. An
 * abort is instant in the renderer — the frame loop throws on its next
 * checkpoint — and slow in the main process, which still has to SIGKILL FFmpeg
 * and reap it before `render:v2:cancelled` comes back. In between,
 * `ipcRenderV2.start` throws "An export is already running"
 * (`electron/render/renderFrame.ts`). While the progress dialog owned the
 * screen that window was unreachable; with the export button always on the
 * title bar it is one double-click away, so the button has to be able to say
 * "stopping" rather than "ready".
 */

export type ExportPhase = "idle" | "running" | "finalizing" | "cancelling";

export type ExportEvent =
  /** A destination was chosen and the frame loop is about to begin. */
  | "start"
  /** Every frame is written; FFmpeg is still muxing. */
  | "frameLoopDone"
  /** The user pressed Stop. The main process has not confirmed yet. */
  | "cancelRequested"
  /** Finished, failed or confirmed cancelled — whatever happened, it is over. */
  | "settled";

/**
 * The phase an event moves us to.
 *
 * **Returns its input by identity when the event does not apply**, which is the
 * decline convention every pure op in `features/timeline/` follows, and is what
 * lets `exportStore.dispatch` compare with `Object.is` and notify nobody. A
 * `settled` arriving twice — the click handler's `finally` and
 * `render:v2:cancelled` race each other — must cost no repaint.
 *
 * `finalizing + cancelRequested` is admitted deliberately: `render:v2:cancel`
 * kills the FFmpeg process, so stopping during the mux is a real thing a user
 * can ask for and it does work.
 */
export function nextPhase(phase: ExportPhase, event: ExportEvent): ExportPhase {
  switch (phase) {
    case "idle":
      return event === "start" ? "running" : phase;

    case "running":
      if (event === "frameLoopDone") return "finalizing";
      if (event === "cancelRequested") return "cancelling";
      if (event === "settled") return "idle";
      return phase;

    case "finalizing":
      if (event === "cancelRequested") return "cancelling";
      if (event === "settled") return "idle";
      return phase;

    case "cancelling":
      // Not `cancelRequested` — a second Stop press must not restart the
      // timeout fallback — and not `start`, which is the double-click this
      // phase exists for.
      return event === "settled" ? "idle" : phase;
  }
}

/** Is an export occupying the encoder right now? */
export function isExportBusy(phase: ExportPhase): boolean {
  return phase !== "idle";
}
