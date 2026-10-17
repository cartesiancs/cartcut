/**
 * Starting and stopping an export.
 *
 * The one code path behind the title bar's button, File → Export, the progress
 * popover's Stop button and the e2e harness — the rule
 * `features/editor/actions.ts` states for the toolbar, applied to the one
 * command that was still reached by calling a method on a Lit component.
 *
 * This lived inside `ControlRender.handleClickRenderV2Button`, which meant the
 * export could only be started from a panel that had to be mounted, and
 * `disconnectedCallback` stopped the progress ticker — actively wrong now that
 * an export outlives whatever started it.
 */

import {
  announceDidExport,
  askWillExport,
  vetoMessage,
} from "../extension/exportHooks";

import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { exportStore } from "../../states/exportStore";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { exportProgress } from "./exportProgress";
import { requestIPCVideoExport } from "./ipc";
import { exportElementRenderers } from "./renderers";
import { frameCount } from "./frames";
import { snapshotExportOptions, snapshotTimeline } from "./snapshot";
import {
  projectRenderOptions,
  projectSnapshot,
} from "../composition/projectSnapshot";
import { snapshotTemplateResolver } from "../../states/timelineWorkspace";
import {
  preloadTemplatesForDocument,
  templateFor,
} from "../template/templateRegistry";
import { assetTimeline } from "../template/assetTimeline";
import { rendererModal } from "../../utils/modal";
import { webExportAvailable } from "./web/codecSupport";
import { browserDestinationHost, chooseDestination } from "./web/destination";
import { encodePlanFor } from "./web/encodeSettings";
import { runWebExport } from "./web/webExportSession";

/**
 * How long a cancel may sit unconfirmed before the button frees itself.
 *
 * `render:v2:cancel` kills FFmpeg and `render:v2:cancelled` comes back when it
 * has been reaped, which is fast. If that message never arrives — a crashed
 * main process, a session id that has already been superseded — the phase
 * would otherwise stay `cancelling` and the export button would be inert for
 * the rest of the session.
 */
const CANCEL_TIMEOUT_MS = 10_000;

/** Non-null exactly while a frame loop is running. */
let controller: AbortController | null = null;
let cancelTimer: number | null = null;

function toast(message: string, delay = "4000") {
  const box: any = document.querySelector("toast-box");
  box?.showToast({ message, delay });
}

/**
 * Can an export be started right now?
 *
 * The main process refuses a second one outright — `ipcRenderV2.start` throws
 * "An export is already running" — so this is asked *before* the save dialog,
 * or the user picks a filename and is then handed an exception.
 */
export function canStartExport(): boolean {
  return exportStore.getState().phase === "idle";
}

/**
 * Ask for a destination and export the project to it.
 *
 * Everything the frame loop reads is snapshotted the instant the dialog
 * resolves (see `snapshot.ts`), and the decoders it drives are its own (see
 * `renderTimeline.ts`), so the user is free to keep editing while it runs.
 */
export async function startExport(): Promise<void> {
  if (!canStartExport()) {
    toast("An export is already running.");
    return;
  }

  // Every browser build, the static demo included, exports in the page:
  // WebCodecs and Mediabunny in place of FFmpeg. See `web/webExportSession.ts`.
  if (getLocationEnv() !== "electron") {
    await startWebExport();
    return;
  }

  const ipc = window.electronAPI.req;
  const settings = renderOptionStore.getState().options.exportSettings;

  const videoDestination = await ipc.dialog.exportVideo(settings.container);
  if (videoDestination == null) {
    return;
  }

  const fileExists = await ipc.filesystem.existFile(videoDestination);
  if (fileExists) {
    await ipc.filesystem.removeFile(videoDestination);
  }

  // Read after the dialog, at the last instant before any work begins: the
  // dialog is modal to the window but the user may have been editing right up
  // to opening it.
  // The project, whichever timeline is showing: main's document at the
  // project's own frame. A template's own timeline is edited in its tab and
  // reaches the file through the clip that places it.
  const snapshot = projectSnapshot();
  const timeline = snapshotTimeline(snapshot.project.main.elements);
  const options = snapshotExportOptions(snapshot.options, videoDestination);
  // And every template the project owns, as it stands now: one edited while
  // this renders must not change the frames still to come.
  const resolveTemplate = snapshotTemplateResolver(
    useTimelineStore.getState(),
    templateFor,
  );

  /*
   * Extensions get one chance to stop this, here.
   *
   * After the destination is chosen, so an extension can see what is being
   * written, and before any phase is entered, so a veto costs nothing and
   * leaves the editor exactly as it was. Bounded and failing open: an
   * extension that does not answer in time has no objection, because an
   * export a broken extension could make impossible is worse than an export
   * that ignored a warning.
   */
  const objections = await askWillExport(options.exportSettings);
  if (objections.vetoes.length > 0) {
    toast(vetoMessage(objections.vetoes));
    return;
  }

  // `exportProgress.begin` resets the estimate without touching the phase, and
  // `exportStore.begin` is what sets it running. The order is load-bearing:
  // see the comment on `begin`.
  exportProgress.begin(timeline, frameCount(options), options.fps);
  exportStore.getState().begin(videoDestination);

  const running = new AbortController();
  controller = running;

  try {
    // Read before the sound is planned: an installed template is loaded on
    // first use, and one not read yet would contribute no sound at all.
    await preloadTemplatesForDocument(timeline);
    await requestIPCVideoExport(
      timeline,
      exportElementRenderers,
      options,
      (currentFrame, totalFrames) =>
        exportProgress.onFrame(currentFrame, totalFrames),
      running.signal,
      resolveTemplate,
      // A template's own sound, as the preview plays it. Hidden rows are not
      // left out: the eye hides picture, never sound.
      assetTimeline(timeline, resolveTemplate),
    );

    // The frame loop is done; FFmpeg is not. `finishStream` only closes its
    // stdin, so the mux still has seconds to run and nothing reports on it
    // until `PROCESSING_FINISH` reaches `event.ts`.
    exportProgress.finalizing();
  } catch (error) {
    // An abort leaves the phase at `cancelling` on purpose: the main process
    // is still reaping FFmpeg and would refuse a new export until it has.
    // `render:v2:cancelled` settles it, and `armCancelTimeout` is the backstop.
    if ((error as Error)?.name === "AbortError") {
      return;
    }
    exportProgress.stop();
    toast(`Export failed: ${(error as Error)?.message ?? error}`, "6000");
  } finally {
    if (controller === running) {
      controller = null;
    }
  }
}

/**
 * Stop the running export.
 *
 * Declines when there is nothing to stop, which is what makes a second press
 * of a Stop button that is still on screen free.
 */
export function cancelExport(): void {
  const running = controller;
  if (running == null) {
    return;
  }
  controller = null;

  // Not `exportProgress.stop()`: that would settle the phase to `idle` while
  // FFmpeg is still being killed, and the very next click would hit main's
  // "An export is already running".
  exportStore.getState().dispatch("cancelRequested");
  armCancelTimeout();
  running.abort();
}

/** `render:v2:cancelled` arrived, or the export ended some other way. */
export function clearCancelTimeout(): void {
  if (cancelTimer != null) {
    window.clearTimeout(cancelTimer);
    cancelTimer = null;
  }
}

function armCancelTimeout(): void {
  clearCancelTimeout();
  cancelTimer = window.setTimeout(() => {
    cancelTimer = null;
    if (exportStore.getState().phase === "cancelling") {
      exportProgress.stop();
    }
  }, CANCEL_TIMEOUT_MS);
}

/**
 * A finished export: the progress closes, the dialog opens, extensions hear.
 *
 * The desktop export reaches this from `event.ts`, when main reports FFmpeg
 * has finished muxing; the browser export calls it itself once its muxer has
 * finalized. Extensions are told last, and only here: before this point the
 * file is still being written.
 */
export function finishExport(destination: string, settings: unknown): void {
  clearCancelTimeout();
  if (destination !== "") {
    exportStore.getState().setDestination(destination);
  }
  exportProgress.finish();

  // A browser cannot reveal a file in its folder, so its dialog names the file
  // instead of offering to.
  const detail = document.querySelector("#progressFinishDetail");
  if (detail != null) {
    detail.textContent =
      getLocationEnv() === "electron" || destination === ""
        ? ""
        : `Saved as ${destination}`;
  }
  rendererModal.progressFinish.show();

  if (destination !== "") {
    announceDidExport(destination, settings);
  }
}

/** A failed export: the progress stops and the error dialog says why. */
export function failExport(message: string, detail = ""): void {
  clearCancelTimeout();
  exportProgress.stop();
  rendererModal.progressError.show();
  const target = document.querySelector("#progressErrorMsg");
  if (target != null) {
    // `textContent`, not `innerHTML`: this can carry raw FFmpeg stderr.
    target.textContent = detail === "" ? message : `${message}\n\n${detail}`;
  }
}

/** The file name the save dialog offers. */
function suggestedName(extension: string): string {
  return `cartcut-export.${extension}`;
}

/**
 * The browser export, from the click to the finished file.
 *
 * The same order the desktop export keeps: destination, snapshot, the
 * extensions' veto, then the phase. The save dialog comes first and before any
 * other await, because it needs the click's user activation.
 */
async function startWebExport(): Promise<void> {
  if (!webExportAvailable()) {
    toast(
      "This browser cannot export video. Use a recent Chrome, Edge or Safari, or the desktop app.",
      "6000",
    );
    return;
  }

  // Only the container is read from this plan, to name the file before the
  // snapshot; the session builds the real one from the snapshot.
  const live = renderOptionStore.getState().options;
  const plan = encodePlanFor(live.exportSettings, {
    width: live.previewSize.w,
    height: live.previewSize.h,
    fps: live.fps,
  });
  const destination = await chooseDestination(browserDestinationHost(), {
    suggestedName: suggestedName(plan.extension),
    mimeType: plan.mimeType,
    extension: plan.extension,
  });
  if (destination == null) {
    return;
  }

  const snapshot = projectSnapshot();
  const timeline = snapshotTimeline(snapshot.project.main.elements);
  const options = snapshotExportOptions(snapshot.options, destination.name);
  const resolveTemplate = snapshotTemplateResolver(
    useTimelineStore.getState(),
    templateFor,
  );

  const objections = await askWillExport(options.exportSettings);
  if (objections.vetoes.length > 0) {
    await destination.discard();
    toast(vetoMessage(objections.vetoes));
    return;
  }

  exportProgress.begin(timeline, frameCount(options), options.fps);
  exportStore.getState().begin(destination.name);

  const running = new AbortController();
  controller = running;
  // A long export with nobody touching the machine should not stop for the
  // screen going to sleep. Released however the export ends.
  const wakeLock = await (navigator as any).wakeLock
    ?.request?.("screen")
    .catch(() => null);

  try {
    await preloadTemplatesForDocument(timeline);
    await runWebExport({
      timeline,
      options,
      resolveTemplate,
      // A template's own sound, as the preview plays it. Hidden rows are not
      // left out: the eye hides picture, never sound.
      audioTimeline: assetTimeline(timeline, resolveTemplate),
      destination,
      signal: running.signal,
      onFrame: (currentFrame, totalFrames) =>
        exportProgress.onFrame(currentFrame, totalFrames),
      onFinalizing: () => exportProgress.finalizing(),
    });
    finishExport(destination.name, options.exportSettings);
  } catch (error) {
    // Nothing runs elsewhere to be reaped, so a cancel is settled here, now.
    if ((error as Error)?.name === "AbortError") {
      clearCancelTimeout();
      exportProgress.stop();
      return;
    }
    console.error("[export] browser export failed", error);
    failExport(`Export failed: ${(error as Error)?.message ?? error}`);
  } finally {
    void wakeLock?.release?.().catch(() => {});
    if (controller === running) {
      controller = null;
    }
  }
}
