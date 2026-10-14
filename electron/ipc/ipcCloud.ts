/**
 * The renderer's view of the cloud API.
 *
 * Arguments are checked here, at the boundary: a kind outside the seven, an id
 * that is not one, a job id that is not a string, a GIF page request out of
 * range. Downloads report on
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
  clearCloudInstalls,
  cloudBaseUrl,
  cloudCatalog,
  cloudDownload,
  cloudEnabled,
  cloudGifPage,
  cloudInstallSummary,
  customCloudUrl,
  defaultCloudUrl,
  installedCloudAssets,
  installedCloudGifs,
  setCloudEnabled,
  setCloudUrl,
  type CloudDownloadOutcome,
  type GifPageParams,
} from "../lib/cloud/cloudSession";

/** The server's own limits (`server/src/gifs.rs`): a longer query it cuts, a larger page it clamps. */
const MAX_QUERY_LENGTH = 100;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 48;

/** A page request made safe to put in a URL: anything unusable is its default. */
export function gifPageParams(raw: unknown): GifPageParams {
  const record = (raw ?? {}) as Record<string, unknown>;
  const limit =
    typeof record.limit === "number" && Number.isInteger(record.limit) ? record.limit : DEFAULT_PAGE;
  return {
    q: typeof record.q === "string" ? record.q.normalize("NFC").trim().slice(0, MAX_QUERY_LENGTH) : "",
    cursor: typeof record.cursor === "string" && /^\d{1,9}$/.test(record.cursor) ? record.cursor : "",
    limit: Math.min(MAX_PAGE, Math.max(1, limit)),
  };
}

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

  // GIFs are never listed whole; `gifPage` is how they are read.
  catalog: async (_event: IpcMainInvokeEvent, kind: unknown) =>
    isCloudKind(kind) && kind !== "gif" ? cloudCatalog(kind) : { status: "unreachable", items: [] },

  gifPage: async (_event: IpcMainInvokeEvent, params: unknown) => cloudGifPage(gifPageParams(params)),

  installedGifs: async () => ({ items: await installedCloudGifs() }),

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

  /** Counted on disk, so it answers with the setting off and offline. */
  installedSummary: async () => cloudInstallSummary(),

  /** Takes no argument: main decides what "downloaded" means, by folder. */
  clearInstalled: async () => clearCloudInstalls(),
};
