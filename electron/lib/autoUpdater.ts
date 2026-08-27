import { dialog } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";

/**
 * Handlers for the `electron-updater` events wired up in `electron/main.ts`.
 *
 * The shape here follows from two defaults we keep: `autoDownload` is on, so a
 * new version starts downloading by itself, and `autoInstallOnAppQuit` is on,
 * so a downloaded version lands the next time the app quits either way. That
 * leaves exactly one moment worth interrupting the user for — the update is on
 * disk and they can choose to restart now. Everything else goes to the log.
 */
const updater = {
  checkingForUpdate: () => {
    log.info("Checking for update...");
  },

  /**
   * Deliberately silent. There is nothing for the user to do while the
   * download runs, and the dialog this replaced offered "업데이트"/"닫기"
   * buttons that did nothing at all.
   */
  updateAvailable: (info) => {
    log.info(`Update available: ${info?.version}`);
  },

  updateNotAvailable: () => {
    log.info("Update not available.");
  },

  /**
   * A failed update must not block the editor. This used to put up a modal
   * "E013" — which every 0.4.x install will now hit on launch, since the
   * rename moved the app to a new bundle id and Squirrel.Mac rejects the
   * signature. Log it and stay out of the way.
   */
  error: (err) => {
    log.error("Error in auto-updater. " + err);
  },

  downloadProgress: (progressObj) => {
    log.info(
      `Downloaded ${progressObj.percent.toFixed(1)}% ` +
        `(${progressObj.transferred}/${progressObj.total}) ` +
        `at ${progressObj.bytesPerSecond} B/s`,
    );
  },

  updateDownloaded: (info) => {
    const dialogOpts: any = {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Cartcut ${info?.version} is ready to install.`,
      detail:
        "Restart to finish now, or it will be applied the next time you quit.",
    };

    dialog.showMessageBox(dialogOpts).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  },
};

export { updater };
