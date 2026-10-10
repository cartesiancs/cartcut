/**
 * What the renderer knows about the cloud: the setting, the connection, each
 * kind's catalog and every download in flight.
 *
 * Main is the gate (`electron/lib/cloud/cloudSession.ts`): with the setting
 * off or no network it answers without a request. This store keeps a second,
 * cheaper gate in front of that one, so a panel offline does not even cross
 * IPC, and so the moment the connection drops the cloud tiles that are not
 * downloaded leave the screen.
 *
 * Catalogs are fetched when a panel first shows (`ensureCatalog`), never at
 * startup: every browser is mounted hidden when the app opens, and asking
 * from `connectedCallback` would call the API on every launch.
 */

import { createStore } from "zustand/vanilla";
import { v4 as uuidv4 } from "uuid";

import { cloudPort, type CloudPort } from "./cloudPort";
import {
  cloudKey,
  type CloudDownloadOutcome,
  type CloudItem,
  type CloudKind,
  type CloudStatus,
} from "./cloudTypes";

export type CatalogState = {
  status: CloudStatus | "loading";
  items: CloudItem[];
  /** When the status was last set, for the refetch and retry intervals. */
  at: number;
};

export interface ICloudStore {
  /** Whether a bridge exists at all. `false` on the web build. */
  available: boolean;
  /**
   * The setting, as main last reported it. Off until main answers: what a
   * setting nobody has touched means depends on the build, and only main
   * knows which build this is.
   */
  enabled: boolean;
  /** `navigator.onLine`, kept by the `online` and `offline` events. */
  online: boolean;
  /** The server in use: the one typed into Settings, else the default. */
  url: string | null;
  /** `CARTCUT_CLOUD_URL`, else `config.json`'s `cloudApiUrl`. */
  defaultUrl: string | null;
  /** Whether `url` is one typed into Settings. */
  customUrl: boolean;
  catalogs: Partial<Record<CloudKind, CatalogState>>;
  /** By `kind:id`, 0 to 1, for exactly the downloads in flight. */
  downloads: Record<string, number>;
  /** The assets already on disk, for the asset browser's cloud view. */
  installedAssets: CloudItem[];
}

export const cloudStore = createStore<ICloudStore>(() => ({
  available: false,
  enabled: false,
  online: true,
  url: null,
  defaultUrl: null,
  customUrl: false,
  catalogs: {},
  downloads: {},
  installedAssets: [],
}));

/** A fresh catalog is reused for this long; main caches as long again. */
const CATALOG_TTL_MS = 10 * 60 * 1000;
/** After `unreachable`, the next attempt waits at least this long. */
const RETRY_MS = 60 * 1000;

let port: CloudPort | null = null;
let started = false;
/** Job id to `kind:id`, for progress events. */
const jobKeys = new Map<string, string>();
/** By `kind:id`. A second click joins the first. */
const running = new Map<string, Promise<CloudDownloadOutcome>>();

function setCatalog(kind: CloudKind, next: CatalogState): void {
  cloudStore.setState((state) => ({ catalogs: { ...state.catalogs, [kind]: next } }));
}

function setDownload(key: string, fraction: number | null): void {
  cloudStore.setState((state) => {
    if (fraction == null) {
      if (!(key in state.downloads)) {
        return state;
      }
      const { [key]: _gone, ...rest } = state.downloads;
      return { downloads: rest };
    }
    // Returning the state itself is what makes zustand skip the notify; an
    // empty object still wakes every subscriber.
    if (state.downloads[key] === fraction) {
      return state;
    }
    return { downloads: { ...state.downloads, [key]: fraction } };
  });
}

/**
 * Connect to the bridge and to the connection events. Once, from `App`.
 *
 * Reads the setting from main rather than from a renderer copy, so the
 * toggle in Settings and the gate in main can never disagree.
 */
export async function startCloud(): Promise<void> {
  if (started) {
    return;
  }
  started = true;
  port = cloudPort();
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  cloudStore.setState({ available: port != null, online });
  if (port == null) {
    return;
  }

  port.onProgress(({ jobId, fraction }) => {
    const key = jobKeys.get(jobId);
    if (key != null && running.has(key)) {
      setDownload(key, Math.max(0, Math.min(1, fraction)));
    }
  });

  // Dropping every catalog on either edge: offline hides what is not
  // downloaded at once, and online makes every visible panel ask again.
  window.addEventListener("online", () => cloudStore.setState({ online: true, catalogs: {} }));
  window.addEventListener("offline", () => cloudStore.setState({ online: false, catalogs: {} }));

  try {
    const status = await port.status();
    cloudStore.setState({
      enabled: status?.enabled !== false,
      url: status?.url ?? null,
      defaultUrl: status?.defaultUrl ?? null,
      customUrl: status?.custom === true,
    });
  } catch {
    // Main did not answer. Off stands, and main's own gate still decides
    // every request.
  }
}

/**
 * Notified when what a grid shows could change: a catalog, the setting, the
 * connection, the assets on disk. **Not** on download progress, which only
 * the tile's own badge listens to; a grid that re-rendered on every percent
 * would redraw seventy tiles a hundred times per download.
 */
export function subscribeCloudListing(listener: () => void): () => void {
  let last = cloudStore.getState();
  return cloudStore.subscribe((state) => {
    const changed =
      state.catalogs !== last.catalogs ||
      state.enabled !== last.enabled ||
      state.online !== last.online ||
      state.available !== last.available ||
      state.url !== last.url ||
      state.customUrl !== last.customUrl ||
      state.installedAssets !== last.installedAssets;
    last = state;
    if (changed) {
      listener();
    }
  });
}

/** Whether cloud tiles may be shown at all right now. */
export function cloudUsable(state: ICloudStore = cloudStore.getState()): boolean {
  return state.available && state.enabled && state.online;
}

/**
 * Fetch one kind's catalog if it is missing or stale. Cheap to call on every
 * render of a visible panel: it returns at once when there is nothing to do.
 */
export function ensureCatalog(kind: CloudKind): void {
  const state = cloudStore.getState();
  if (port == null || !cloudUsable(state)) {
    return;
  }
  const current = state.catalogs[kind];
  const now = Date.now();
  if (current != null) {
    if (current.status === "loading") {
      return;
    }
    if (current.status === "ok" && now - current.at < CATALOG_TTL_MS) {
      return;
    }
    if (current.status !== "ok" && now - current.at < RETRY_MS) {
      return;
    }
  }

  // The items already shown stay up while a stale catalog is refreshed.
  setCatalog(kind, { status: "loading", items: current?.items ?? [], at: now });
  port
    .catalog(kind)
    .then((result) => {
      const status = result?.status ?? "unreachable";
      // Turned off or gone offline while the request was out: what it
      // brought back is no longer anything to show.
      if (!cloudUsable()) {
        return;
      }
      if (status === "disabled") {
        cloudStore.setState({ enabled: false });
      }
      setCatalog(kind, {
        status,
        items: status === "ok" && Array.isArray(result?.items) ? result.items : [],
        at: Date.now(),
      });
    })
    .catch(() => setCatalog(kind, { status: "unreachable", items: [], at: Date.now() }));
}

/** The catalog items to show for one kind: none unless the cloud is usable. */
export function cloudItemsOf(kind: CloudKind, state: ICloudStore = cloudStore.getState()): CloudItem[] {
  if (!cloudUsable(state)) {
    return [];
  }
  const catalog = state.catalogs[kind];
  return catalog != null && (catalog.status === "ok" || catalog.status === "loading")
    ? catalog.items
    : [];
}

/** Whether one kind's catalog came back unusable, for an empty state to say so. */
export function catalogStatus(kind: CloudKind, state: ICloudStore = cloudStore.getState()) {
  return state.catalogs[kind]?.status ?? null;
}

/** The folder of a POSIX or Windows path, POSIX-separated, with its slash. */
function folderOf(file: string): string {
  return file.replace(/\\/g, "/").replace(/[^/]*$/, "");
}

function markInstalled(kind: CloudKind, id: string, installedPath: string): void {
  cloudStore.setState((state) => {
    const catalog = state.catalogs[kind];
    if (catalog == null) {
      return state;
    }
    const items = catalog.items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const asset = kind === "asset";
      const dir = asset ? folderOf(installedPath) : `${installedPath.replace(/\\/g, "/")}/`;
      return {
        ...item,
        installed: true,
        localPath: asset ? installedPath : null,
        localThumbnail: item.thumbnail == null ? null : dir + item.thumbnail,
      };
    });
    return { catalogs: { ...state.catalogs, [kind]: { ...catalog, items } } };
  });
}

/**
 * Download and install one item. Resolves once it is on disk, or with why not.
 *
 * Never rejects. A second call for an item already downloading returns the
 * first call's promise, so a double click is one download.
 */
export function downloadCloudItem(kind: CloudKind, id: string): Promise<CloudDownloadOutcome> {
  const key = cloudKey(kind, id);
  const existing = running.get(key);
  if (existing != null) {
    return existing;
  }
  const state = cloudStore.getState();
  if (port == null || !state.available || !state.enabled) {
    return Promise.resolve({ ok: false, reason: "disabled" });
  }
  if (!state.online) {
    return Promise.resolve({ ok: false, reason: "offline" });
  }

  const jobId = uuidv4();
  const bridge = port;
  jobKeys.set(jobId, key);
  setDownload(key, 0);

  const promise = bridge
    .download(kind, id, jobId)
    .then((outcome) => outcome ?? { ok: false as const, reason: "failed" as const })
    .catch(
      (error): CloudDownloadOutcome => ({
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((outcome) => {
      if (outcome.ok) {
        markInstalled(kind, id, outcome.path);
      }
      return outcome;
    })
    .finally(() => {
      jobKeys.delete(jobId);
      running.delete(key);
      setDownload(key, null);
    });
  running.set(key, promise);
  return promise;
}

/**
 * Turn the API on or off, through main, which aborts what is in flight.
 *
 * Every catalog is dropped either way: off hides what is not downloaded, and
 * on makes every visible panel ask again.
 */
export async function setCloudEnabled(enabled: boolean): Promise<void> {
  if (port == null) {
    return;
  }
  try {
    const result = await port.setEnabled(enabled);
    cloudStore.setState({ enabled: result?.enabled !== false, catalogs: {} });
  } catch {
    // Main did not take it. Leave the store as it was, so the toggle shows
    // what main still believes.
  }
}

/**
 * Point the app at another server, or back at the default with `""`.
 * Answers `false` when main refused the address, and then changes nothing.
 *
 * Every catalog is dropped on success, because the old server's listing
 * names files the new one may not have; visible panels ask the new one.
 */
export async function setCloudUrl(url: string): Promise<boolean> {
  if (port == null) {
    return false;
  }
  try {
    const result = await port.setUrl(url);
    if (result?.ok !== true) {
      return false;
    }
    cloudStore.setState({
      url: result.url ?? null,
      defaultUrl: result.defaultUrl ?? null,
      customUrl: result.custom === true,
      catalogs: {},
    });
    return true;
  } catch {
    return false;
  }
}

/** Re-read the assets already on disk. Works offline. */
export async function refreshInstalledAssets(): Promise<void> {
  if (port == null) {
    return;
  }
  try {
    const result = await port.installedAssets();
    cloudStore.setState({ installedAssets: Array.isArray(result?.items) ? result.items : [] });
  } catch {
    cloudStore.setState({ installedAssets: [] });
  }
}
