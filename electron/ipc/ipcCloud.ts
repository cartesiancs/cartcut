/**
 * The renderer's view of the cloud API.
 *
 * Arguments are checked here, at the boundary: a kind outside the six, an id
 * that is not one, a job id that is not a string. Downloads report on
 * `cloud:progress` to the window that asked, as `{ jobId, fraction }`, with
 * repeats of the same whole percent dropped (`ipcTts.ts#progressSender`).
 *
 * The job id is the renderer's, minted before the call, so a tile can stop
 * listening before `download` resolves.
 */

import { net, type IpcMainInvokeEvent } from "electron";

import { isCloudKind } from "../lib/cloud/cloudPaths";
import {
  cancelCloudJob,
  cloudBaseUrl,
  cloudCatalog,
  cloudDownload,
  cloudEnabled,
  customCloudUrl,
  defaultCloudUrl,
  installedCloudAssets,
  setCloudEnabled,
  setCloudUrl,
  type CloudDownloadOutcome,
} from "../lib/cloud/cloudSession";

function progressSender(jobId: string, event: IpcMainInvokeEvent) {
  let lastPercent = -1;
  return (fraction: number) => {
    const percent = Math.floor(fraction * 100);
    if (percent === lastPercent) {
      return;
    }
    lastPercent = percent;
    if (!event.sender.isDestroyed()) {
      event.sender.send("cloud:progress", { jobId, fraction });
    }
  };
}

/** The server as Settings shows it: what is in use, the default, and whether it was typed. */
function serverState() {
  return { url: cloudBaseUrl(), defaultUrl: defaultCloudUrl(), custom: customCloudUrl() != null };
}

export const ipcCloud = {
  status: async () => ({ enabled: cloudEnabled(), online: net.isOnline(), ...serverState() }),

  setEnabled: async (_event: IpcMainInvokeEvent, enabled: unknown) => {
    setCloudEnabled(enabled === true);
    return { enabled: cloudEnabled() };
  },

  /** A string sets the server, an empty one restores the default. */
  setUrl: async (_event: IpcMainInvokeEvent, url: unknown) => ({
    ...setCloudUrl(url),
    ...serverState(),
  }),

  catalog: async (_event: IpcMainInvokeEvent, kind: unknown) =>
    isCloudKind(kind) ? cloudCatalog(kind) : { status: "unreachable", items: [] },

  download: async (
    event: IpcMainInvokeEvent,
    kind: unknown,
    id: unknown,
    jobId: unknown,
  ): Promise<CloudDownloadOutcome> => {
    if (!isCloudKind(kind) || typeof id !== "string" || typeof jobId !== "string") {
      return { ok: false, reason: "missing" };
    }
    return cloudDownload(kind, id, jobId, progressSender(jobId, event));
  },

  cancel: async (_event: IpcMainInvokeEvent, jobId: unknown) => {
    if (typeof jobId === "string") {
      cancelCloudJob(jobId);
    }
    return { ok: true };
  },

  installedAssets: async () => ({ items: await installedCloudAssets() }),
};
