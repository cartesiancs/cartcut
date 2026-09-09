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

import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { io } from "socket.io-client";

import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { exportStore } from "../../states/exportStore";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { exportProgress } from "./exportProgress";
import { requestIPCVideoExport } from "./ipc";
import { exportElementRenderers } from "./renderers";
import { frameCount } from "./frames";
import { snapshotExportOptions, snapshotTimeline } from "./snapshot";

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

  if (getLocationEnv() !== "electron") {
    await requestHttpRender();
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
  const timeline = snapshotTimeline(useTimelineStore.getState().timeline);
  const options = snapshotExportOptions(
    renderOptionStore.getState().options,
    videoDestination,
  );

  // `exportProgress.begin` resets the estimate without touching the phase, and
  // `exportStore.begin` is what sets it running. The order is load-bearing —
  // see the comment on `begin`.
  exportProgress.begin(timeline, frameCount(options), options.fps);
  exportStore.getState().begin(videoDestination);

  const running = new AbortController();
  controller = running;

  try {
    await requestIPCVideoExport(
      timeline,
      exportElementRenderers,
      options,
      (currentFrame, totalFrames) =>
        exportProgress.onFrame(currentFrame, totalFrames),
      running.signal,
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
 * The web build's export, which renders in a hidden window driven by the HTTP
 * API rather than in this page. Moved here wholesale from `ControlRender`.
 */
let socket: any;

export function installHttpRenderListeners(): void {
  if (getLocationEnv() !== "web" || socket != null) {
    return;
  }
  socket = io();

  socket.on("render:progress", (percent: number) => {
    exportStore.getState().report(percent, null);
  });

  socket.on("render:done", (path: string) => {
    exportStore.getState().setDestination(path);
    exportProgress.finish();
    document.dispatchEvent(
      new CustomEvent("cartcut:http-render-done", { detail: { path } }),
    );
  });
}

async function requestHttpRender(): Promise<void> {
  // Installed here rather than at startup, because this is the only thing that
  // needs the socket and the dependency should be visible from it. It used to
  // work only as a side effect of the export *settings* panel having been
  // mounted, which is why it went missing when that panel moved. Idempotent and
  // web-only, so calling it on every render costs nothing.
  installHttpRenderListeners();

  const tempPath = await window.electronAPI.req.app.getTempPath();
  const renderOptionState = renderOptionStore.getState().options;
  const elementControlComponent: any =
    document.querySelector("element-control");

  const projectFolder = tempPath.path;
  if (projectFolder === "") {
    toast("Select a project folder");
    return;
  }

  const uuidKey = uuidv4();
  const settings = renderOptionState.exportSettings;

  // Spreading the store also carries `fps` and `duration`, which
  // `renderTimeline` destructures — the hand-built object below used to omit
  // them, leaving the offscreen render loop with an undefined frame count.
  const options = {
    ...renderOptionState,
    videoDuration: renderOptionState.duration,
    videoDestination: `${projectFolder}/${uuidKey}.${settings.container}`,
    videoDestinationFolder: projectFolder,
    videoBitrate: settings.videoBitrate,
    previewRatio: elementControlComponent.previewRatio,
    previewSize: {
      w: renderOptionState.previewSize.w,
      h: renderOptionState.previewSize.h,
    },
  };

  // A snapshot, so the `file:/` rewrite below cannot reach the live document.
  // It used to mutate the store's own elements in place.
  const timeline: any = snapshotTimeline(
    Object.fromEntries(
      Object.entries(useTimelineStore.getState().timeline).sort(
        ([, a]: any, [, b]: any) => a.priority - b.priority,
      ),
    ),
  );

  for (const key in timeline) {
    if (Object.prototype.hasOwnProperty.call(timeline, key)) {
      timeline[key].localpath = `file:/${timeline[key].localpath}`;
    }
  }

  await axios.post("/api/render", { options, timeline });
}
