/**
 * The preload's `cloud` namespace, as a narrow port.
 *
 * `null` where there is no such bridge: the web build's `ipcWrapper.ts` shim
 * has none, and the cloud UI then never appears, which is the same thing a
 * user who turned the setting off sees.
 */

import type { CloudDownloadOutcome, CloudItem, CloudKind, CloudStatus } from "./cloudTypes";

/** The server in use, the default it falls back to, and whether Settings named one. */
export type CloudServer = { url: string | null; defaultUrl: string | null; custom: boolean };

export type CloudPort = {
  status: () => Promise<{ enabled: boolean; online: boolean } & CloudServer>;
  setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  /** An empty string restores the default. `ok: false` for an unusable address. */
  setUrl: (url: string) => Promise<{ ok: boolean } & CloudServer>;
  catalog: (kind: CloudKind) => Promise<{ status: CloudStatus; items: CloudItem[] }>;
  download: (kind: CloudKind, id: string, jobId: string) => Promise<CloudDownloadOutcome>;
  cancel: (jobId: string) => Promise<unknown>;
  installedAssets: () => Promise<{ items: CloudItem[] }>;
  onProgress: (handler: (payload: { jobId: string; fraction: number }) => void) => () => void;
};

export function cloudPort(): CloudPort | null {
  const api = (globalThis as { electronAPI?: { req?: { cloud?: CloudPort } } })?.electronAPI?.req
    ?.cloud;
  return api != null && typeof api.catalog === "function" ? api : null;
}
