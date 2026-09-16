import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  createUpdateSession,
  type UpdateEvent,
  type UpdaterPort,
} from "./updateSession.js";

/**
 * `electron-updater` as far as the session can see it: an emitter, a
 * download whose outcome the test decides, and a native "ready" signal the
 * test fires by hand.
 */
function fakeUpdater() {
  const emitter = new EventEmitter();
  const installable: Array<() => void> = [];
  let settle: { resolve: () => void; reject: (error: unknown) => void } | null =
    null;
  const calls = { download: 0, quitAndInstall: 0 };

  const port: UpdaterPort = {
    on: (event, listener) => emitter.on(event, listener),
    downloadUpdate: () => {
      calls.download += 1;
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    quitAndInstall: () => {
      calls.quitAndInstall += 1;
    },
    onInstallable: (listener) => {
      installable.push(listener);
    },
  };

  return {
    port,
    calls,
    emit: (event: string, payload?: unknown) => emitter.emit(event, payload),
    installable: () => installable.forEach((listener) => listener()),
    resolveDownload: () => settle?.resolve(),
    rejectDownload: (error: unknown) => settle?.reject(error),
  };
}

function setup() {
  const updater = fakeUpdater();
  const sent: UpdateEvent[] = [];
  const logged: string[] = [];
  const session = createUpdateSession(
    updater.port,
    (event) => sent.push(event),
    {
      info: (message) => logged.push(message),
      error: (message) => logged.push(message),
    },
  );
  return { updater, sent, logged, session };
}

/** Lets a rejected `downloadUpdate()` reach the session's `catch`. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createUpdateSession", () => {
  it("walks available, progress, preparing, downloaded and install in order", async () => {
    const { updater, sent, session } = setup();

    updater.emit("update-available", { version: "0.5.7" });
    void session.download();
    updater.emit("download-progress", { percent: 12.7 });
    updater.emit("download-progress", { percent: 100 });
    updater.emit("update-downloaded", { version: "0.5.7" });
    updater.installable();

    expect(sent).toEqual([
      { kind: "available", version: "0.5.7" },
      { kind: "progress", version: "0.5.7", percent: 0 },
      { kind: "progress", version: "0.5.7", percent: 12 },
      { kind: "progress", version: "0.5.7", percent: 100 },
      { kind: "preparing", version: "0.5.7" },
      { kind: "downloaded", version: "0.5.7" },
    ]);

    expect(session.isQuittingForUpdate()).toBe(false);
    expect(session.install()).toBe(true);
    expect(session.isQuittingForUpdate()).toBe(true);
    expect(updater.calls.quitAndInstall).toBe(1);
  });

  it("sends nothing and downloads nothing before an update is found", async () => {
    const { updater, sent, session } = setup();

    await session.download();
    updater.emit("download-progress", { percent: 50 });
    updater.emit("update-downloaded", { version: "0.5.7" });

    expect(sent).toEqual([]);
    expect(updater.calls.download).toBe(0);
    expect(session.snapshot()).toBeNull();
  });

  it("sends whole percents and skips repeats", () => {
    const { updater, sent, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    for (const percent of [0.4, 3.1, 3.9, 7, 7.5, Number.NaN, 150]) {
      updater.emit("download-progress", { percent });
    }

    const percents = sent
      .filter((event) => event.kind === "progress")
      .map((event) => (event as { percent: number }).percent);
    expect(percents).toEqual([0, 3, 7, 100]);
  });

  // A differential download against the wrong cached zip counts to 100%,
  // fails its sha512 check and starts a full download from zero.
  it("shows a download that starts over", () => {
    const { updater, sent, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    for (const percent of [40, 100, 0, 1, 55]) {
      updater.emit("download-progress", { percent });
    }

    const percents = sent
      .filter((event) => event.kind === "progress")
      .map((event) => (event as { percent: number }).percent);
    expect(percents).toEqual([0, 40, 100, 0, 1, 55]);
    expect(session.snapshot()).toEqual({
      kind: "progress",
      version: "0.5.7",
      percent: 55,
    });
  });

  it("starts one download however often the button is pressed", () => {
    const { updater, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });

    void session.download();
    void session.download();
    void session.download();

    expect(updater.calls.download).toBe(1);
  });

  it("keeps a check that fails in the log and off the card", () => {
    const { updater, sent, logged } = setup();

    updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));

    expect(sent).toEqual([]);
    expect(logged.some((line) => line.includes("ERR_INTERNET"))).toBe(true);
  });

  it("reports a failed download once, though it arrives twice", async () => {
    const { updater, sent, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    const error = new Error("sha512 checksum mismatch");
    updater.emit("error", error);
    updater.rejectDownload(error);
    await flush();

    const failures = sent.filter((event) => event.kind === "failed");
    expect(failures).toEqual([
      { kind: "failed", version: "0.5.7", message: "sha512 checksum mismatch" },
    ]);
  });

  it("reports a download that only rejects", async () => {
    const { updater, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    updater.rejectDownload("socket hang up");
    await flush();

    expect(session.snapshot()).toEqual({
      kind: "failed",
      version: "0.5.7",
      message: "socket hang up",
    });
  });

  it("reports Squirrel refusing the update while it prepares", () => {
    const { updater, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();
    updater.emit("update-downloaded", { version: "0.5.7" });

    updater.emit("error", new Error("Code signature did not pass validation"));

    expect(session.snapshot()?.kind).toBe("failed");
    expect(session.install()).toBe(false);
  });

  it("retries after a failure from zero", async () => {
    const { updater, sent, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();
    updater.emit("download-progress", { percent: 40 });
    updater.emit("error", new Error("socket hang up"));

    sent.length = 0;
    void session.download();
    updater.emit("download-progress", { percent: 5 });

    expect(updater.calls.download).toBe(2);
    expect(sent).toEqual([
      { kind: "progress", version: "0.5.7", percent: 0 },
      { kind: "progress", version: "0.5.7", percent: 5 },
    ]);
  });

  it("refuses to install while Squirrel is still preparing", () => {
    const { updater, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();
    updater.emit("update-downloaded", { version: "0.5.7" });

    expect(session.snapshot()).toEqual({ kind: "preparing", version: "0.5.7" });
    expect(session.install()).toBe(false);
    expect(session.isQuittingForUpdate()).toBe(false);
    expect(updater.calls.quitAndInstall).toBe(0);
  });

  it("refuses to install before anything was downloaded", () => {
    const { updater, session } = setup();
    expect(session.install()).toBe(false);

    updater.emit("update-available", { version: "0.5.7" });
    expect(session.install()).toBe(false);

    void session.download();
    expect(session.install()).toBe(false);
    expect(updater.calls.quitAndInstall).toBe(0);
  });

  it("marks the update installable once, whichever signal comes first", () => {
    const { updater, sent, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    updater.installable();
    updater.emit("update-downloaded", { version: "0.5.7" });
    updater.installable();

    expect(sent.filter((event) => event.kind === "downloaded")).toHaveLength(1);
    expect(session.snapshot()).toEqual({ kind: "downloaded", version: "0.5.7" });
  });

  it("ignores a second announcement once the download has started", () => {
    const { updater, session } = setup();
    updater.emit("update-available", { version: "0.5.7" });
    void session.download();

    updater.emit("update-available", { version: "0.5.8" });

    expect(session.snapshot()).toEqual({
      kind: "progress",
      version: "0.5.7",
      percent: 0,
    });
  });

  it("answers the last event for a renderer that loads late", () => {
    const { updater, session } = setup();
    expect(session.snapshot()).toBeNull();

    updater.emit("update-available", { version: "0.5.7" });
    expect(session.snapshot()).toEqual({ kind: "available", version: "0.5.7" });
  });
});
