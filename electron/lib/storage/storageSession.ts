/**
 * Settings' Storage section, main's half: which files are temporary, the
 * finished recordings, and the folders it can open.
 *
 * Main names every folder, the rule `cloudInstalled.ts` follows. The disk work
 * is in `tempFiles.ts` and `recordingFiles.ts`, which have no Electron in them.
 *
 * Temporary means a file nothing on the timeline points at. Reversed clips,
 * generated speech and rasterised titles are cached in userData too, but a
 * clip's `localpath` names them, so they are never swept here; neither is
 * autosave, which can be the only copy of unsaved work.
 */

import { app, session, shell } from "electron";
import * as fsp from "fs/promises";
import path from "path";

import { autosaveRoot } from "../autosave";
import { cloudStagingRoot } from "../cloud/cloudPaths";
import { extensionsRoot } from "../../extension/dirs";
import { clearProxies, proxyDir } from "../proxy";
import { currentSession, recordingsDirectory, recordingsRoot } from "../recordSession";
import { reverseDir } from "../reverse";
import { speechCacheDir } from "../tts/ttsModels";
import { removeRecordings, summarizeRecordings } from "./recordingFiles";
import type { StorageFolder } from "./storageFolders";
import { removeSweeps, summarizeSweeps, type Sweep } from "./tempFiles";

/**
 * How long a partial must sit unwritten before it counts as left behind: the
 * age `autosaveCache.ts#pruneRoot` gives a crashed `.part`. A job still running
 * keeps writing, so its partial never reaches it.
 */
const LEFTOVER_MS = 60 * 60 * 1000;

const isPartial = (name: string) => name.endsWith(".part") || name.endsWith(".tmp");

function userData(): string {
  return app.getPath("userData");
}

/** Everything under userData that is regenerated when it is wanted again. */
function cacheSweeps(): Sweep[] {
  const everything = () => true;
  return ["transcripts", "analysis", "contact-sheets"].map((folder) => ({
    root: path.join(userData(), folder),
    match: everything,
  }));
}

/** What crashed and interrupted jobs leave behind, and nothing they are still writing. */
function leftoverSweeps(): Sweep[] {
  const temp = app.getPath("temp");
  return [
    // A take is excluded by `keep` rather than by age: paused, it writes nothing.
    { root: temp, match: (name) => name.startsWith("cartcut-record-") },
    { root: temp, match: (name) => name.startsWith("cartcut-ramp-"), minAgeMs: LEFTOVER_MS },
    {
      root: temp,
      match: (name) => name.startsWith("cartcut-stt-") && name.endsWith(".wav"),
      minAgeMs: LEFTOVER_MS,
    },
    { root: cloudStagingRoot(userData()), match: () => true, minAgeMs: LEFTOVER_MS },
    {
      root: extensionsRoot(),
      match: (name) => name.startsWith(".part-"),
      minAgeMs: LEFTOVER_MS,
    },
    ...[reverseDir(), speechCacheDir(userData()), path.join(userData(), "tts-models")].map(
      (root): Sweep => ({ root, match: isPartial, recursive: true, minAgeMs: LEFTOVER_MS }),
    ),
  ];
}

/**
 * Every proxy, and the partials and unindexed files `clearProxies` does not
 * know about. The index itself is rewritten empty by `clearProxies`.
 */
function proxySweep(): Sweep {
  return { root: proxyDir(), match: (name) => name !== "index.json" };
}

function tempSweeps(withProxies: boolean): Sweep[] {
  const sweeps = [...cacheSweeps(), ...leftoverSweeps()];
  if (withProxies) {
    sweeps.push(proxySweep());
  } else {
    // A pass is running: its finished proxies stay, and only old partials go.
    sweeps.push({ root: proxyDir(), match: isPartial, minAgeMs: LEFTOVER_MS });
  }
  return sweeps;
}

function sweepOptions() {
  const take = currentSession();
  return { nowMs: Date.now(), keep: take == null ? [] : [take.dir] };
}

/** Chromium's HTTP cache, which only the session can measure or clear while it runs. */
async function httpCacheBytes(): Promise<number> {
  try {
    return await session.defaultSession.getCacheSize();
  } catch {
    return 0;
  }
}

export async function tempSummary(): Promise<{ bytes: number }> {
  const [files, cache] = await Promise.all([
    summarizeSweeps(tempSweeps(true), sweepOptions()),
    httpCacheBytes(),
  ]);
  return { bytes: files.bytes + cache };
}

/**
 * Remove the temporary files. `proxyPassRunning` keeps the proxies a running
 * pass is making and about to index; the caller knows, this module does not.
 */
export async function clearTemp(options: {
  proxyPassRunning: boolean;
}): Promise<{ ok: boolean; removed: number; failed: number }> {
  const withProxies = !options.proxyPassRunning;
  if (withProxies) {
    clearProxies();
  }
  const result = await removeSweeps(tempSweeps(withProxies), sweepOptions());
  await session.defaultSession.clearCache().catch(() => {});
  return { ok: result.failed === 0, ...result };
}

export async function recordingsSummary(): Promise<{ files: number; bytes: number }> {
  return summarizeRecordings(recordingsRoot());
}

/**
 * Move every finished take to the Trash, so a mistaken click on footage can be
 * undone from there. Refused outright while a take is running, because its
 * delivery writes into this folder.
 */
export async function clearRecordings(): Promise<{
  ok: boolean;
  busy: boolean;
  removed: number;
  failed: number;
}> {
  if (currentSession() != null) {
    return { ok: false, busy: true, removed: 0, failed: 0 };
  }
  const result = await removeRecordings(recordingsRoot(), (file) => shell.trashItem(file));
  return { ok: result.failed === 0, busy: false, ...result };
}

async function folderPath(folder: StorageFolder): Promise<string> {
  switch (folder) {
    case "appData":
      return userData();
    case "recordings":
      return recordingsDirectory();
    case "autosave":
      return autosaveRoot();
    case "logs":
      return app.getPath("logs");
    case "temp":
      return app.getPath("temp");
  }
}

/** Open one of the named folders in the file browser, creating it first if no file has needed it yet. */
export async function openStorageFolder(folder: StorageFolder): Promise<{ ok: boolean }> {
  try {
    const dir = await folderPath(folder);
    await fsp.mkdir(dir, { recursive: true });
    // An error is reported as a string, and success as an empty one.
    return { ok: (await shell.openPath(dir)) === "" };
  } catch {
    return { ok: false };
  }
}
