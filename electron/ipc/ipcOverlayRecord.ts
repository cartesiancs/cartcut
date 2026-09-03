/**
 * Everything the recorder asks the main process for.
 *
 * Two callers, and they want different things. The **editor** calls `show`, and
 * that is all it ever calls. The **engine renderer** calls the rest: it drives
 * the session, and main answers with the four capabilities a renderer does not
 * have — disk, the pointer, FFmpeg, and the tray.
 *
 * Handlers answer `{ status: 1, ... }` or `{ status: 0, error }`, which is the
 * shape the rest of `electron/ipc/` uses. A rejected `invoke` would reach the
 * renderer as an opaque `Error: Error invoking remote method`, and the engine
 * has to be able to tell "the microphone is missing" from "the disk is full".
 */

import { app, desktopCapturer, screen, shell, systemPreferences } from "electron";
import log from "electron-log";
import { armDisplayMedia, disarmDisplayMedia } from "../lib/displayMedia.js";
import {
  closeRecorder,
  deliverToEditor,
  openRecorder,
  setRecorderTray,
  updateOverlay,
} from "../lib/recorder.js";
import {
  addClick,
  addStroke,
  appendChunk,
  cancelSession,
  deliverSession,
  finishFile,
  pauseSession,
  recordingsDirectory,
  resumeSession,
  startSession,
  stopSession,
  type DeliverRequest,
  type FileKey,
  type StartRequest,
} from "../lib/recordSession.js";
import type { TrayModel } from "../lib/recordTrayMenu.js";

function fail(where: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`[record] ${where}:`, message);
  return { status: 0 as const, error: message };
}

export const ipcOverlayRecord = {
  /** The editor's only call. Idempotent — see `openRecorder`. */
  show: async () => {
    try {
      openRecorder();
      return { status: 1 as const };
    } catch (error) {
      return fail("could not open the recorder", error);
    }
  },

  close: async () => {
    closeRecorder();
    return { status: 1 as const };
  },

  /**
   * Screens and windows, with the display each screen belongs to.
   *
   * `thumbnailSize: { width: 0, height: 0 }` because nothing shows a preview:
   * the default is a 150×150 `NativeImage` per source, which is a screen grab
   * of every window on the machine, taken every time this menu is opened.
   *
   * The `display` half is what the engine needs to ask for a capture at the
   * screen's own pixels — `size × scaleFactor` — instead of the 1920×1080 the
   * in-panel recorder pins. A window source has no display, and gets `null`.
   */
  sources: async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });

      const displays = screen.getAllDisplays();

      // Screens first. The engine's fallback when a stored source id has gone
      // is "the first one" — ids are minted per enumeration and never survive a
      // restart, so that fallback is what runs on the first menu of every
      // session. `getSources` returns windows ahead of screens, which would
      // make the default capture whichever window the OS happened to list
      // first: on this machine, the editor's own devtools.
      const ordered = [
        ...sources.filter((source) => source.id.startsWith("screen:")),
        ...sources.filter((source) => !source.id.startsWith("screen:")),
      ];

      return {
        status: 1 as const,
        sources: ordered.map((source) => {
          const display = displays.find(
            (candidate) => String(candidate.id) === source.display_id,
          );

          return {
            id: source.id,
            name: source.name,
            displayId: source.display_id,
            display:
              display == null
                ? null
                : {
                    width: display.size.width,
                    height: display.size.height,
                    scaleFactor: display.scaleFactor,
                  },
          };
        }),
      };
    } catch (error) {
      return fail("could not list capture sources", error);
    }
  },

  /**
   * Where the OS stands on camera, microphone and screen access.
   *
   * macOS only in practice — `getMediaAccessStatus` answers `"granted"`
   * everywhere else. Asked before a take rather than discovered during one: a
   * recording that silently captures a black rectangle because Screen Recording
   * was never granted is the single most confusing failure this feature has.
   */
  permissions: async () => {
    if (process.platform !== "darwin") {
      return {
        status: 1 as const,
        camera: "granted",
        microphone: "granted",
        screen: "granted",
      };
    }

    return {
      status: 1 as const,
      camera: systemPreferences.getMediaAccessStatus("camera"),
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
      screen: systemPreferences.getMediaAccessStatus("screen"),
    };
  },

  /**
   * Ask for one.
   *
   * Screen Recording has no prompt API — the OS raises it on the first capture
   * attempt and then requires a relaunch — so the only useful thing to do is
   * open the pane and say so.
   */
  requestPermission: async (_event, kind: "camera" | "microphone" | "screen") => {
    try {
      if (process.platform !== "darwin") {
        return { status: 1 as const, granted: true };
      }

      if (kind === "screen") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
        return { status: 1 as const, granted: false, opened: true };
      }

      const granted = await systemPreferences.askForMediaAccess(kind);
      return { status: 1 as const, granted };
    } catch (error) {
      return fail(`could not request ${kind} access`, error);
    }
  },

  /** Render the menu model the engine built. */
  setTray: async (_event, model: TrayModel) => {
    try {
      setRecorderTray(model);
      return { status: 1 as const };
    } catch (error) {
      return fail("could not build the tray menu", error);
    }
  },

  /** Push state to the overlay, and set whether it takes the pointer. */
  setOverlay: async (_event, state: { drawing: boolean }) => {
    updateOverlay(state);
    return { status: 1 as const };
  },

  /**
   * Arm the next `getDisplayMedia`, for system audio only.
   *
   * One shot, consumed by the request that follows it. `lib/displayMedia.ts`
   * explains why it is not a standing grant.
   */
  armDisplayMedia: async (_event, sourceId: string, audio: boolean) => {
    armDisplayMedia(sourceId, audio);
    return { status: 1 as const };
  },

  disarmDisplayMedia: async () => {
    disarmDisplayMedia();
    return { status: 1 as const };
  },

  start: async (_event, request: StartRequest) => {
    try {
      return { status: 1 as const, ...(await startSession(request)) };
    } catch (error) {
      return fail("could not start the recording", error);
    }
  },

  /**
   * Append encoded bytes.
   *
   * Resolves only once the pipe has room, and the engine awaits that — the
   * resolution is the backpressure. See `recordSession.ts#appendChunk`.
   */
  append: async (
    _event,
    sessionId: string,
    key: FileKey,
    chunk: Uint8Array,
  ) => {
    try {
      await appendChunk(sessionId, key, chunk);
      return { status: 1 as const };
    } catch (error) {
      return fail("could not write the recording", error);
    }
  },

  finishFile: async (_event, sessionId: string, key: FileKey) => {
    try {
      await finishFile(sessionId, key);
      return { status: 1 as const };
    } catch (error) {
      return fail("could not close the recording file", error);
    }
  },

  pause: async (_event, sessionId: string) => {
    try {
      pauseSession(sessionId);
      return { status: 1 as const };
    } catch (error) {
      return fail("could not pause", error);
    }
  },

  resume: async (_event, sessionId: string) => {
    try {
      resumeSession(sessionId);
      return { status: 1 as const };
    } catch (error) {
      return fail("could not resume", error);
    }
  },

  stroke: async (_event, sessionId: string, stroke: unknown) => {
    try {
      addStroke(sessionId, stroke);
      return { status: 1 as const };
    } catch (error) {
      // A stroke arriving after the take stopped is a race, not a failure.
      return { status: 0 as const, error: String(error) };
    }
  },

  click: async (_event, sessionId: string, click: unknown) => {
    try {
      addClick(sessionId, click);
      return { status: 1 as const };
    } catch (error) {
      return { status: 0 as const, error: String(error) };
    }
  },

  /** Stop the clock and hand back the cursor track and the annotations. */
  stop: async (_event, sessionId: string) => {
    try {
      return { status: 1 as const, ...stopSession(sessionId) };
    } catch (error) {
      return fail("could not stop the recording", error);
    }
  },

  /**
   * Mux, file, and tell the editor.
   *
   * The last step of a recording, and the only moment the editor window hears
   * about any of this.
   */
  deliver: async (_event, sessionId: string, request: DeliverRequest) => {
    try {
      const filePath = await deliverSession(sessionId, request);
      deliverToEditor(filePath);
      return { status: 1 as const, path: filePath };
    } catch (error) {
      return fail("could not write the finished recording", error);
    }
  },

  cancel: async () => {
    await cancelSession();
    return { status: 1 as const };
  },

  openFolder: async () => {
    try {
      await shell.openPath(await recordingsDirectory());
      return { status: 1 as const };
    } catch (error) {
      return fail("could not open the recordings folder", error);
    }
  },

  /** `process.platform`, so the engine can decide about loopback audio. */
  platform: async () => ({
    status: 1 as const,
    platform: process.platform,
    version: app.getVersion(),
  }),
};
