/**
 * The update flow as a state machine, with `electron-updater` behind a port.
 *
 * Nothing here imports electron, so the rules run under vitest against a fake
 * updater. `lib/autoUpdater.ts` is the wiring. The renderer's end is
 * `apps/app/src/features/update/`, which keeps its own copy of `UpdateEvent`
 * because `electron/` may not import from `apps/app/src`.
 *
 * The phases, and why there are two after the download:
 *
 *   idle → available → downloading → preparing → downloaded
 *                          ↓              ↓
 *                        failed ←─────────┘   (a retry goes back to downloading)
 *
 * On macOS `electron-updater` announces `update-downloaded` as soon as its own
 * download finishes, *before* Squirrel.Mac has read the zip back from the
 * local proxy, unpacked it and checked its signature. For the 1GB zip that was
 * five seconds on 2026-09-16, and by ShipIt's log four and a half minutes on
 * 2026-09-09. Until Squirrel says so, `quitAndInstall` only waits, so a
 * restart button that is live during `preparing` can look broken for minutes.
 * `onInstallable` is the moment it stops waiting.
 */

export type UpdateEvent =
  | { kind: "available"; version: string }
  | { kind: "progress"; version: string; percent: number }
  | { kind: "preparing"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "failed"; version: string; message: string };

export type UpdaterPort = {
  /**
   * `update-available`, `download-progress`, `update-downloaded` and `error`,
   * with `electron-updater`'s payloads.
   */
  on(event: string, listener: (payload?: any) => void): unknown;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  /** Fires once the update installs without waiting for anything else. */
  onInstallable(listener: () => void): void;
};

export type UpdateLog = {
  info(message: string): void;
  error(message: string): void;
};

export type UpdateSession = {
  /** The last event sent, so a renderer that loads late can catch up. */
  snapshot(): UpdateEvent | null;
  /** Starts the download. Does nothing unless an update is waiting for one. */
  download(): Promise<void>;
  /** Quits and installs. Answers false, and does nothing, before `downloaded`. */
  install(): boolean;
  /** Whether `install` has run, so the window's close guard can stand aside. */
  isQuittingForUpdate(): boolean;
};

type Phase =
  | "idle"
  | "available"
  | "downloading"
  | "preparing"
  | "downloaded"
  | "failed";

export function createUpdateSession(
  updater: UpdaterPort,
  send: (event: UpdateEvent) => void,
  log: UpdateLog,
): UpdateSession {
  let phase: Phase = "idle";
  let version = "";
  let lastPercent = -1;
  let installable = false;
  let quitting = false;
  let last: UpdateEvent | null = null;

  const emit = (event: UpdateEvent) => {
    last = event;
    send(event);
  };

  const markDownloaded = () => {
    phase = "downloaded";
    emit({ kind: "downloaded", version });
  };

  // One failure usually arrives twice: `downloadUpdate()` rejects *and*
  // `error` fires, and on macOS Squirrel's own error is forwarded as a second
  // `error`. The phase check is what keeps the card to one message.
  const fail = (error: unknown) => {
    const message = messageOf(error);
    log.error(`Error in auto-updater. ${message}`);
    if (phase !== "downloading" && phase !== "preparing") {
      // A failed *check* stays in the log. Offline, a rate-limited GitHub, or
      // a 0.4.x install whose bundle id Squirrel rejects: none of them is
      // something the user asked about or can act on.
      return;
    }
    phase = "failed";
    emit({ kind: "failed", version, message });
  };

  updater.on("update-available", (info) => {
    // A card mid-download must not snap back to "Download?".
    if (phase !== "idle" && phase !== "available" && phase !== "failed") {
      return;
    }
    version = String(info?.version ?? "");
    phase = "available";
    emit({ kind: "available", version });
  });

  updater.on("download-progress", (progress) => {
    if (phase !== "downloading") {
      return;
    }
    const percent = wholePercent(progress?.percent);
    // Whole percents only, and repeats skipped. A drop is passed through: it
    // is a download starting over, and it has to show. A differential download
    // checks its sha512 only at the very end, so when the cached `update.zip`
    // is not the running version it counts to 100% and then falls back to a
    // full download from zero. Measured on 2026-09-16: two and a half minutes
    // to the mismatch, then the whole zip again, all of it behind a bar that
    // would otherwise have sat at 100%.
    if (percent == null || percent === lastPercent) {
      return;
    }
    lastPercent = percent;
    emit({ kind: "progress", version, percent });
  });

  updater.on("update-downloaded", () => {
    if (phase !== "downloading") {
      return;
    }
    phase = "preparing";
    emit({ kind: "preparing", version });
    if (installable) {
      markDownloaded();
    }
  });

  updater.onInstallable(() => {
    installable = true;
    if (phase === "preparing") {
      markDownloaded();
    }
  });

  updater.on("error", fail);

  return {
    snapshot: () => last,

    async download() {
      if (phase !== "available" && phase !== "failed") {
        return;
      }
      phase = "downloading";
      lastPercent = 0;
      // At once, so the button reacts to the click rather than to the first
      // chunk, which can be seconds away.
      emit({ kind: "progress", version, percent: 0 });
      log.info(`Downloading update ${version}`);
      try {
        await updater.downloadUpdate();
      } catch (error) {
        fail(error);
      }
    },

    install() {
      if (phase !== "downloaded") {
        return false;
      }
      quitting = true;
      log.info(`Quitting to install update ${version}`);
      updater.quitAndInstall();
      return true;
    },

    isQuittingForUpdate: () => quitting,
  };
}

function wholePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor(value)));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
