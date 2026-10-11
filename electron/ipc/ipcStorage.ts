/**
 * Settings' Storage section. No call takes a path: the folders are main's,
 * and `openFolder` takes a name `isStorageFolder` must accept.
 */

import type { IpcMainInvokeEvent } from "electron";

import { isStorageFolder } from "../lib/storage/storageFolders";
import {
  clearRecordings,
  clearTemp,
  openStorageFolder,
  recordingsSummary,
  tempSummary,
} from "../lib/storage/storageSession";
import { proxyPassRunning } from "./ipcProxy";

export const ipcStorage = {
  tempSummary: async () => tempSummary(),
  clearTemp: async () => clearTemp({ proxyPassRunning: proxyPassRunning() }),
  recordingsSummary: async () => recordingsSummary(),
  clearRecordings: async () => clearRecordings(),
  openFolder: async (_event: IpcMainInvokeEvent, folder: unknown) =>
    isStorageFolder(folder) ? openStorageFolder(folder) : { ok: false },
};
