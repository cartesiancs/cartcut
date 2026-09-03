/**
 * Answering `getDisplayMedia`.
 *
 * Chromium asks the embedder which source to share; Electron routes that
 * through one handler per session, and there is only one session. The handler
 * that used to sit inline in `createMainWindow` answered `sources[0]`
 * unconditionally — which is why `features/record/screenRecord.ts` avoids
 * `getDisplayMedia` altogether and goes through `getUserMedia` with a
 * `chromeMediaSourceId` instead, as its header explains at length.
 *
 * The recorder captures its picture the same way, for the same reason. It comes
 * here for exactly one thing: **system audio**, which `getUserMedia` cannot
 * ask for. So the handler is a one-shot — the engine says which source it is
 * about to request, calls `getDisplayMedia`, and the arrangement is spent. A
 * standing "always share this screen" handler would let any page in the app
 * take the screen without a prompt.
 *
 * Note what this does *not* solve on macOS. Electron 33 documents `Streams.audio`
 * as "currently only supported on Windows"; a loopback request on macOS yields
 * a video-only stream. `recordSettings.ts#systemAudioSupported` is what stops
 * the recorder asking, and the tray says why.
 */

import { desktopCapturer, session } from "electron";
import log from "electron-log";

type Pending = { sourceId: string; audio: boolean };

let pending: Pending | null = null;

/**
 * Arm the next `getDisplayMedia` call to answer with this source.
 *
 * Consumed by the first request that arrives. If the request never comes — the
 * engine threw between arming and asking — the arrangement is dropped by the
 * next `arm`, and in the meantime it grants nothing on its own.
 */
export function armDisplayMedia(sourceId: string, audio: boolean): void {
  pending = { sourceId, audio };
}

export function disarmDisplayMedia(): void {
  pending = null;
}

/**
 * Install the session's handler. Called once, from app startup.
 *
 * An unarmed request is **denied**, by calling back with an empty object. The
 * previous handler granted the first screen to anything that asked, including
 * a page inside the `<webview>` extension sandbox.
 */
export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const armed = pending;
      pending = null;

      if (armed == null) {
        callback({});
        return;
      }

      desktopCapturer
        .getSources({
          types: ["window", "screen"],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then((sources) => {
          const source = sources.find(
            (candidate) => candidate.id === armed.sourceId,
          );

          if (source == null) {
            log.warn("[record] display source went away:", armed.sourceId);
            callback({});
            return;
          }

          callback(
            armed.audio ? { video: source, audio: "loopback" } : { video: source },
          );
        })
        .catch((error) => {
          log.error("[record] could not list display sources", error);
          // Electron leaks the request if the callback never fires, and the
          // renderer's promise then hangs forever with no error to catch.
          callback({});
        });
    },
  );
}
