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

import { BrowserWindow, screen } from "electron";
import log from "electron-log";
import {
  destroyRecordTray,
  showRecordTray,
} from "./recordTray.js";
import type { TrayModel } from "./recordTrayMenu.js";
import { window as windows, mainWindow } from "./window.js";
import { cancelSession } from "./recordSession.js";
import { disarmDisplayMedia } from "./displayMedia.js";
import { overlayBoundsFor, sameBounds } from "./overlayPlacement.js";

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
 * Put the overlay over the display being captured.
 *
 * The window is created on the primary display and the screen being captured is
 * a setting, so without this the bubble stays on monitor one while the take
 * records monitor two: invisible to the person being recorded on the screen
 * they are recording, and drawn by the compositor into the file anyway, at a
 * corner they never saw it in.
 *
 * `setResizable` around the move because **a `resizable: false` window ignores
 * a programmatic size change on Windows**. Displays differ in size, so without
 * the toggle a move to a second monitor would keep the first one's dimensions
 * and leave the overlay covering part of the screen, with the bubble laid out
 * against a frame that is not the one it is on.
 *
 * `bounds`, not `workArea`, for the reason `window.ts` gives: the work area
 * excludes the menu bar and the Dock, and those are being recorded too.
 */
function placeOverlayOn(overlay: BrowserWindow, displayId: unknown): void {
  const bounds = overlayBoundsFor(screen.getAllDisplays(), displayId);

  if (bounds == null || sameBounds(bounds, overlay.getBounds())) {
    return;
  }

  const wasResizable = overlay.isResizable();
  overlay.setResizable(true);
  overlay.setBounds(bounds);
  overlay.setResizable(wasResizable);
}

/**
 * Push the overlay's state to it, and set whether it takes the pointer.
 *
 * Drawing mode is the only time the overlay is interactive. The rest of the
 * time it must be `setIgnoreMouseEvents(true, { forward: true })` — ignoring
 * clicks so they reach the app being recorded, and still seeing `mousemove` so
 * it knows where the pointer is without having to steal it.
 *
 * **The window level has to come down with it.** An interactive window at
 * `"screen-saver"` level covering the display's whole `bounds` sits over the
 * macOS menu bar and the Dock, so it swallows clicks on the tray — the one
 * control that could turn drawing off again. `"floating"` is below
 * `NSMainMenuWindowLevel`, so the menu bar and the tray stay clickable while
 * everything else on screen is still drawn over. On Windows the taskbar is
 * topmost, so dropping out of always-on-top achieves the same thing.
 *
 * This is the third of three exits from drawing mode, and the one that does not
 * depend on the overlay's own UI working. The other two — the toolbar's Done
 * button and the Escape key — are in `overlayRoot.ts`, which explains why a
 * drawing surface must carry its own way out.
 *
 * `displayId` is the display behind the selected capture source, and the window
 * follows it here rather than at creation because the source is chosen after
 * the recorder opens and can change at any time while it is idle.
 */
export function updateOverlay(state: {
  drawing: boolean;
  displayId?: unknown;
  [key: string]: unknown;
}): void {
  if (!alive(overlayWindow)) {
    return;
  }

  placeOverlayOn(overlayWindow, state.displayId);

  const drawing = state.drawing === true;

  overlayWindow.setIgnoreMouseEvents(!drawing, { forward: true });

  // Focusable only while drawing: the Escape key needs keyboard focus, and a
  // focusable always-on-top window at any other time would steal it from
  // whatever is being recorded.
  overlayWindow.setFocusable(drawing);

  if (process.platform === "win32") {
    overlayWindow.setAlwaysOnTop(!drawing);
  } else {
    overlayWindow.setAlwaysOnTop(true, drawing ? "floating" : "screen-saver");
  }

  if (drawing) {
    overlayWindow.focus();
  }

  overlayWindow.webContents.send("overlayRecord:overlay", state);
}

/**
 * Hand an annotation from the overlay to the compositor.
 *
 * The two live in different renderer processes and share no memory, so a stroke
 * made in one and drawn by the other has to cross through here. Sent whole and
 * re-sent as it grows — see `engine/strokeStore.ts` for why that is the cheap
 * way to make a line appear in the recording as it is being drawn.
 */
export function forwardStroke(message: unknown): void {
  sendToEngine("overlayRecord:stroke", message);
}

/**
 * Say something to the engine.
 *
 * The engine owns every setting, so anything the *overlay* wants changed — the
 * Done button turning drawing off, say — has to be asked for rather than done.
 * Routing it through the owner is what keeps the tray's tick, the overlay's
 * appearance and the compositor's behaviour describing one state instead of
 * three.
 */
export function sendToEngine(channel: string, payload: unknown): void {
  if (alive(engineWindow)) {
    engineWindow.webContents.send(channel, payload);
  }
}

/** Tell the editor a recording is ready for it. */
export function deliverToEditor(filePath: string): void {
  if (mainWindow == null || mainWindow.isDestroyed()) {
    log.warn("[record] no editor window to hand", filePath, "to");
    return;
  }

  mainWindow.webContents.send("overlayRecord:complete", { path: filePath });
}
