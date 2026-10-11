/**
 * The preload's `storage` namespace, as a narrow port, and the calls Settings
 * makes through it.
 *
 * `null` where there is no such bridge: the web build's `ipcWrapper.ts` shim
 * has none, and the Storage rows then render disabled, as the cloud ones do.
 * Every call answers `null` rather than throwing, and no call names a path.
 */

import { refreshProxies } from "../proxy/proxyBridge";

/** Matches `electron/lib/storage/storageFolders.ts#STORAGE_FOLDERS`. */
export type StorageFolder = "appData" | "recordings" | "autosave" | "logs" | "temp";

export type StoragePort = {
  tempSummary: () => Promise<{ bytes: number }>;
  clearTemp: () => Promise<{ ok: boolean; removed: number; failed: number }>;
  recordingsSummary: () => Promise<{ files: number; bytes: number }>;
  /** `busy` while a take is running; nothing is moved then. */
  clearRecordings: () => Promise<{ ok: boolean; busy: boolean; removed: number; failed: number }>;
  openFolder: (folder: StorageFolder) => Promise<{ ok: boolean }>;
};

export function storagePort(): StoragePort | null {
  const api = (globalThis as { electronAPI?: { req?: { storage?: StoragePort } } })?.electronAPI
    ?.req?.storage;
  return api != null && typeof api.tempSummary === "function" ? api : null;
}

export async function readTempSummary(): Promise<{ bytes: number } | null> {
  const port = storagePort();
  if (port == null) {
    return null;
  }
  try {
    const result = await port.tempSummary();
    return { bytes: Number(result?.bytes) || 0 };
  } catch {
    return null;
  }
}

/**
 * Delete the temporary files. The proxies go with them, so the preview's idea
 * of which exist is re-read afterwards, as `proxyPanel.ts` does after its own
 * clear, or it keeps reaching for files that are gone.
 */
export async function clearTempFiles(): Promise<{ ok: boolean } | null> {
  const port = storagePort();
  if (port == null) {
    return null;
  }
  try {
    const result = await port.clearTemp();
    return { ok: result?.ok === true };
  } catch {
    return null;
  } finally {
    await refreshProxies();
  }
}

export async function readRecordingsSummary(): Promise<{ files: number; bytes: number } | null> {
  const port = storagePort();
  if (port == null) {
    return null;
  }
  try {
    const result = await port.recordingsSummary();
    return { files: Number(result?.files) || 0, bytes: Number(result?.bytes) || 0 };
  } catch {
    return null;
  }
}

export async function clearRecordingFiles(): Promise<{ ok: boolean; busy: boolean } | null> {
  const port = storagePort();
  if (port == null) {
    return null;
  }
  try {
    const result = await port.clearRecordings();
    return { ok: result?.ok === true, busy: result?.busy === true };
  } catch {
    return null;
  }
}

export async function openStorageFolder(folder: StorageFolder): Promise<boolean> {
  const port = storagePort();
  if (port == null) {
    return false;
  }
  try {
    return (await port.openFolder(folder))?.ok === true;
  } catch {
    return false;
  }
}
