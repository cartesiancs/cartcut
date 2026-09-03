/**
 * The recorder as an application: two windows, a tray, and the routing between
 * them.
 *
 * The editor opens it and then has nothing more to do with it. That separation
 * is the requirement the whole feature is shaped around — a recording must not
 * be able to stutter the timeline, and an edit must not be able to drop a
 * frame — so nothing here ever reaches into the editor window except once, at
 * the very end, to hand over a finished path.
 *
 * The engine renderer is the brain. It holds the settings, decides what the
 * tray says, and drives the capture; this module is a switchboard, and
 * deliberately understands neither the settings nor the menu (see
 * `recordTrayMenu.ts` for why that boundary sits where it does).
 */

import { BrowserWindow } from "electron";
import log from "electron-log";
import {
  destroyRecordTray,
  showRecordTray,
} from "./recordTray.js";
import type { TrayModel } from "./recordTrayMenu.js";
import { window as windows, mainWindow } from "./window.js";
import { cancelSession } from "./recordSession.js";
import { disarmDisplayMedia } from "./displayMedia.js";

let overlayWindow: BrowserWindow | null = null;
let engineWindow: BrowserWindow | null = null;

function alive(candidate: BrowserWindow | null): candidate is BrowserWindow {
  return candidate != null && !candidate.isDestroyed();
}

export function isRecorderOpen(): boolean {
  return alive(engineWindow);
}

/**
 * Open the recorder, or do nothing if it is already open.
 *
 * Idempotent because the button that calls it is a tile in the editor's
 * utilities panel, and a second click on a tile should not mint a second
 * recorder with its own tray icon and its own idea of what is being captured.
 */
export function openRecorder(): void {
  if (alive(engineWindow)) {
    return;
  }

  engineWindow = windows.createRecordEngineWindow();
  overlayWindow = windows.createRecordOverlayWindow();

  // The engine outliving its overlay is normal — the overlay closes when the
  // take stops and the composite pass runs on. The reverse is not: an overlay
  // with no engine is a bubble nothing is recording.
  engineWindow.on("closed", () => {
    engineWindow = null;
    closeRecorder();
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  engineWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error("[record] engine renderer gone:", details.reason);
    closeRecorder();
  });

  // The engine has no window anybody looks at, so without this a failure inside
  // it — a codec the machine will not configure, a device that disappeared — is
  // silent, and the only symptom is a tray menu that does nothing.
  engineWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      const where = sourceId === "" ? "" : ` (${sourceId}:${line})`;
      if (level >= 2) {
        log.error(`[record:engine] ${message}${where}`);
      } else {
        log.info(`[record:engine] ${message}`);
      }
    },
  );
}

/**
 * Shut the whole thing down and throw away anything in flight.
 *
 * `cancelSession` rather than a graceful stop: this is the path a crash and a
 * "Close Recorder" both take, and there is no engine left to composite with in
 * the first case. A half-written temp directory is deleted rather than left
 * behind looking like a recording.
 */
export function closeRecorder(): void {
  destroyRecordTray();
  disarmDisplayMedia();

  void cancelSession().catch((error) => {
    log.warn("[record] could not clean up the session", error);
  });

  if (alive(overlayWindow)) {
    overlayWindow.destroy();
  }
  overlayWindow = null;

  const engine = engineWindow;
  engineWindow = null;

  if (alive(engine)) {
    engine.destroy();
  }
}

/** Render the model the engine sent, routing clicks straight back to it. */
export function setRecorderTray(model: TrayModel): void {
  showRecordTray(model, (id) => {
    if (alive(engineWindow)) {
      engineWindow.webContents.send("overlayRecord:tray", id);
    }
  });
}

/**
 * Push the overlay's state to it, and set whether it takes the pointer.
 *
 * Drawing mode is the only time the overlay is interactive. The rest of the
 * time it must be `setIgnoreMouseEvents(true, { forward: true })` — ignoring
 * clicks so they reach the app being recorded, and still seeing `mousemove` so
 * it knows where the pointer is without having to steal it.
 */
export function updateOverlay(state: {
  drawing: boolean;
  [key: string]: unknown;
}): void {
  if (!alive(overlayWindow)) {
    return;
  }

  overlayWindow.setIgnoreMouseEvents(!state.drawing, { forward: true });
  overlayWindow.webContents.send("overlayRecord:overlay", state);
}

/** Tell the editor a recording is ready for it. */
export function deliverToEditor(filePath: string): void {
  if (mainWindow == null || mainWindow.isDestroyed()) {
    log.warn("[record] no editor window to hand", filePath, "to");
    return;
  }

  mainWindow.webContents.send("overlayRecord:complete", { path: filePath });
}
