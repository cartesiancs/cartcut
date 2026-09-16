import {
  autoUpdater as nativeUpdater,
  ipcMain,
  type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";

import {
  createUpdateSession,
  type UpdateEvent,
  type UpdaterPort,
  type UpdateSession,
} from "./updateSession.js";

/**
 * Connects `electron-updater` to the update card in the renderer.
 *
 * The rules live in `updateSession.ts`; this file only wires them. Three
 * settings carry the design:
 *
 * - `autoDownload` is off, so a new version is announced and the card asks
 *   before a gigabyte leaves GitHub.
 * - `autoInstallOnAppQuit` stays on, so a download the user started lands the
 *   next time they quit even if they close the card. On macOS it is also what
 *   hands the zip to Squirrel as soon as it arrives; without it that happens
 *   only inside `quitAndInstall`.
 * - `logger` is `electron-log`. The default is `console`, which a packaged app
 *   sends nowhere, and it was the only record of the Rosetta check, the
 *   differential download and every Squirrel error.
 *
 * Development is a no-op, because the updater bails unless `app.isPackaged`.
 * `CARTCUT_UPDATE_DEV=1` reads `dev-app-update.yml` instead, which is enough to
 * drive the card; Squirrel still refuses the update, since the development
 * Electron.app is not signed as Cartcut.
 */

let session: UpdateSession | null = null;

export function installUpdater(webContents: WebContents): void {
  // `ipcMain.handle` throws on a second registration of the same channel.
  if (session != null) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Everything but `debug`. A differential download logs its whole plan and
  // every range request there: 22,000 lines, half a megabyte, for one update
  // on 2026-09-16. What is worth keeping (the Rosetta check, the download
  // size, every failure) is info, warn or error.
  autoUpdater.logger = {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
  };
  if (process.env.CARTCUT_UPDATE_DEV === "1") {
    autoUpdater.forceDevUpdateConfig = true;
  }

  const port: UpdaterPort = {
    on: (event, listener) => autoUpdater.on(event as any, listener),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    // `electron-updater` sets a private flag on this same native event before
    // its `quitAndInstall` stops waiting, so the two agree on the moment.
    onInstallable: (listener) => {
      if (process.platform === "darwin") {
        nativeUpdater.on("update-downloaded", listener);
      } else {
        autoUpdater.on("update-downloaded", listener);
      }
    },
  };

  const current = createUpdateSession(port, sendTo(webContents), log);
  session = current;

  ipcMain.handle("update:getState", () => current.snapshot());
  ipcMain.handle("update:download", () => current.download());
  ipcMain.handle("update:install", () => current.install());

  autoUpdater.checkForUpdates()?.catch((error) => {
    // Already logged through the `error` event; caught so it is not also an
    // unhandled rejection.
    log.warn(`Update check did not complete: ${error}`);
  });
}

/** Whether the app is quitting to install, so a close must not be cancelled. */
export function isQuittingForUpdate(): boolean {
  return session?.isQuittingForUpdate() ?? false;
}

function sendTo(webContents: WebContents) {
  let lastLoggedDecile = -1;
  return (event: UpdateEvent) => {
    // Every tenth, not every percent: a whole download is otherwise a hundred
    // log lines, and the updater logs its own start and finish.
    if (event.kind === "progress") {
      const decile = Math.floor(event.percent / 10);
      if (decile !== lastLoggedDecile) {
        lastLoggedDecile = decile;
        log.info(`Update ${event.version}: ${event.percent}%`);
      }
    } else {
      lastLoggedDecile = -1;
      log.info(`Update ${event.version}: ${event.kind}`);
    }

    if (!webContents.isDestroyed()) {
      webContents.send("update:event", event);
    }
  };
}
