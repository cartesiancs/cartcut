/**
 * The cloud API, as the rest of main sees it: a gate, a catalog cache and the
 * downloads in flight.
 *
 * **Every network path starts at `gate()`.** The setting is off, or
 * `net.isOnline()` says no interface is up, and the call answers at once with
 * no request made. `net.isOnline()` only knows about interfaces, so a request
 * that then fails or times out reads as `unreachable`, which the renderer
 * treats the same as offline: local content only.
 *
 * **Main owns every URL and every path.** The renderer names an item by kind
 * and id; the URL comes from the catalog this module fetched and the folder
 * from `cloudPaths.ts`. There is no call shape in which the renderer supplies
 * either, the rule `autosave:write` keeps for its directory.
 */

import { app, net } from "electron";
import Store from "electron-store";
import * as fsp from "fs/promises";
import path from "path";

import config from "../../config.json";
import { netFetch } from "../netFetch";
import { isUsableCloudId, isSafeCloudPath, parseCatalog, type CloudItem, type CloudMedia } from "./cloudCatalog";
import { CloudDownloadCancelled, clearStaging, installCloudItem } from "./cloudDownload";
import {
  cloudAssetRoot,
  cloudStagingRoot,
  installRootFor,
  type CloudKind,
} from "./cloudPaths";

const store = new Store();

/** Absent means on: the API is enabled until someone turns it off. */
const ENABLED_KEY = "cloud_api_enabled";
/** The server address typed into Settings. Absent means the default. */
const URL_KEY = "cloud_api_url";
const CATALOG_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CATALOG_CHARS = 16 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 64 * 1024;
const THUMBNAILS = ["thumbnail.webp", "thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];

export type CloudStatus = "ok" | "disabled" | "offline" | "unreachable";

/** An item as the renderer receives it. */
export type PublicCloudItem = CloudItem & {
  /** Where to fetch the thumbnail, or `null`. Only shown while online. */
  thumbnailUrl: string | null;
  /** Whether the item's folder is on disk. */
  installed: boolean;
  /** Installed assets only: the media file, in the platform's own spelling. */
  localPath: string | null;
  /** Installed items only: the thumbnail on disk, POSIX-separated. */
  localThumbnail: string | null;
};

export type CloudDownloadOutcome =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: "disabled" | "offline" | "unreachable" | "missing" | "cancelled" | "failed";
      message?: string;
    };

function userData(): string {
  return app.getPath("userData");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function cloudEnabled(): boolean {
  return store.get(ENABLED_KEY) !== false;
}

/**
 * A server address the app can append `/v1/...` to: http(s), no trailing
 * slash, and no credentials, query or fragment, any of which would either
 * corrupt every path built on it or send a password with every request.
 * `null` for anything else.
 */
export function normalizeCloudUrl(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const usable =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    return usable ? trimmed : null;
  } catch {
    return null;
  }
}

/** `CARTCUT_CLOUD_URL` when set, otherwise `cloudApiUrl` from `config.json`. */
export function defaultCloudUrl(): string | null {
  return normalizeCloudUrl(process.env.CARTCUT_CLOUD_URL) ?? normalizeCloudUrl(config.cloudApiUrl);
}

/** The address typed into Settings, or `null` when none is. */
export function customCloudUrl(): string | null {
  return normalizeCloudUrl(store.get(URL_KEY));
}

/**
 * The server every request goes to: the one in Settings, else the default.
 * The same rule in a development and a packaged build, so pointing an
 * installed app at a staging or local server needs no rebuild.
 */
export function cloudBaseUrl(): string | null {
  return customCloudUrl() ?? defaultCloudUrl();
}

type Gate = { ok: true; base: string } | { ok: false; status: Exclude<CloudStatus, "ok"> };

function gate(): Gate {
  if (!cloudEnabled()) {
    return { ok: false, status: "disabled" };
  }
  if (!net.isOnline()) {
    return { ok: false, status: "offline" };
  }
  const base = cloudBaseUrl();
  return base == null ? { ok: false, status: "unreachable" } : { ok: true, base };
}

// ------------------------------------------------------------------ catalog

const catalogs = new Map<CloudKind, { at: number; base: string; items: CloudItem[] }>();
const pendingCatalogs = new Map<CloudKind, Promise<CloudItem[]>>();

/** Aborted, and replaced, when the setting is turned off. */
let session = new AbortController();

async function fetchJson(url: string): Promise<unknown> {
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await net.fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_CATALOG_CHARS) {
    throw new Error("the catalog is too large");
  }
  return JSON.parse(text);
}

async function catalogItems(kind: CloudKind, base: string): Promise<CloudItem[]> {
  const cached = catalogs.get(kind);
  if (cached != null && cached.base === base && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.items;
  }
  // Four grids open at once ask for four kinds, and one grid asked twice must
  // not fetch twice.
  const pending = pendingCatalogs.get(kind);
  if (pending != null) {
    return pending;
  }
  const request = (async () => {
    const json = await fetchJson(`${base}/v1/catalog/${kind}`);
    const { items, rejected } = parseCatalog(kind, json);
    for (const reason of rejected) {
      console.warn(`cloud: ${kind} item skipped: ${reason}`);
    }
    catalogs.set(kind, { at: Date.now(), base, items });
    return items;
  })();
  pendingCatalogs.set(kind, request);
  try {
    return await request;
  } finally {
    pendingCatalogs.delete(kind);
  }
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/** `?v=` is the digest, so new bytes are a new URL and no cache serves the old. */
function fileUrl(
  base: string,
  kind: CloudKind,
  id: string,
  file: { path: string; sha256: string },
): string {
  return `${base}/v1/files/${kind}/${encodeURIComponent(id)}/${encodePath(file.path)}?v=${file.sha256}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function publicItem(item: CloudItem, base: string): Promise<PublicCloudItem> {
  const target = path.join(installRootFor(userData(), item.kind), item.id);
  const installed = await exists(target);
  const thumbnail = item.files.find((file) => file.path === item.thumbnail) ?? null;
  return {
    ...item,
    thumbnailUrl: thumbnail == null ? null : fileUrl(base, item.kind, item.id, thumbnail),
    installed,
    localPath:
      installed && item.kind === "asset" && item.file != null
        ? path.join(target, ...item.file.split("/"))
        : null,
    localThumbnail:
      installed && item.thumbnail != null
        ? toPosix(path.join(target, ...item.thumbnail.split("/")))
        : null,
  };
}

export async function cloudCatalog(
  kind: CloudKind,
): Promise<{ status: CloudStatus; items: PublicCloudItem[] }> {
  const open = gate();
  if (!open.ok) {
    return { status: open.status, items: [] };
  }
  try {
    const items = await catalogItems(kind, open.base);
    return {
      status: "ok",
      items: await Promise.all(items.map((item) => publicItem(item, open.base))),
    };
  } catch (error) {
    console.warn(`cloud: ${kind} catalog unavailable:`, error instanceof Error ? error.message : error);
    return { status: "unreachable", items: [] };
  }
}

// ------------------------------------------------------------------ download

type Inflight = {
  promise: Promise<CloudDownloadOutcome>;
  controller: AbortController;
  listeners: Map<string, (fraction: number) => void>;
};

/** By `kind:id`. A second click on a tile joins the download already running. */
const inflight = new Map<string, Inflight>();
/** Job id to `kind:id`, for `cancel`. */
const jobs = new Map<string, string>();

let staged: Promise<void> | null = null;

/** Once per launch, before the first download: a crash can leave staging full. */
function clearStagingOnce(): Promise<void> {
  staged ??= clearStaging(cloudStagingRoot(userData()));
  return staged;
}

async function runDownload(
  kind: CloudKind,
  id: string,
  base: string,
  signal: AbortSignal,
  report: (fraction: number) => void,
): Promise<CloudDownloadOutcome> {
  try {
    await clearStagingOnce();
    const item = (await catalogItems(kind, base)).find((entry) => entry.id === id);
    if (item == null) {
      return { ok: false, reason: "missing", message: "This item is no longer offered." };
    }

    const target = path.join(installRootFor(userData(), kind), item.id);
    await installCloudItem(item, {
      fetch: netFetch,
      fileUrl: (file) => fileUrl(base, kind, item.id, file),
      stagingRoot: cloudStagingRoot(userData()),
      target,
      onProgress: report,
      signal,
    });

    return {
      ok: true,
      path:
        kind === "asset" && item.file != null
          ? path.join(target, ...item.file.split("/"))
          : toPosix(target),
    };
  } catch (error) {
    if (error instanceof CloudDownloadCancelled || signal.aborted) {
      return { ok: false, reason: "cancelled" };
    }
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function cloudDownload(
  kind: CloudKind,
  id: string,
  jobId: string,
  onProgress: (fraction: number) => void,
): Promise<CloudDownloadOutcome> {
  const open = gate();
  if (!open.ok) {
    return Promise.resolve({ ok: false, reason: open.status });
  }
  if (!isUsableCloudId(id)) {
    return Promise.resolve({ ok: false, reason: "missing" });
  }

  const key = `${kind}:${id}`;
  let entry = inflight.get(key);
  if (entry == null) {
    const controller = new AbortController();
    const listeners = new Map<string, (fraction: number) => void>();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const promise = runDownload(kind, id, open.base, signal, (fraction) => {
      for (const listener of listeners.values()) {
        listener(fraction);
      }
    }).finally(() => {
      inflight.delete(key);
      for (const job of listeners.keys()) {
        jobs.delete(job);
      }
    });
    entry = { promise, controller, listeners };
    inflight.set(key, entry);
  }
  entry.listeners.set(jobId, onProgress);
  jobs.set(jobId, key);
  return entry.promise;
}

/** Stop listening for one job. The download stops when nobody is left listening. */
export function cancelCloudJob(jobId: string): void {
  const key = jobs.get(jobId);
  if (key == null) {
    return;
  }
  jobs.delete(jobId);
  const entry = inflight.get(key);
  if (entry == null) {
    return;
  }
  entry.listeners.delete(jobId);
  if (entry.listeners.size === 0) {
    entry.controller.abort();
  }
}

/**
 * Turn the API on or off.
 *
 * Off stops every download and catalog request in flight and forgets every
 * catalog, so nothing fetched before the switch is offered after it.
 */
export function setCloudEnabled(enabled: boolean): void {
  store.set(ENABLED_KEY, enabled);
  if (!enabled) {
    resetSession();
  }
}

/**
 * Point the app at another server, or back at the default with an empty
 * string. A catalog fetched from the old server describes files the new one
 * may not have, so every catalog is dropped and every download in flight is
 * stopped. What is already installed stays: it is local now.
 */
export function setCloudUrl(raw: unknown): { ok: boolean } {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    store.delete(URL_KEY);
  } else {
    const url = normalizeCloudUrl(raw);
    if (url == null) {
      return { ok: false };
    }
    store.set(URL_KEY, url);
  }
  resetSession();
  return { ok: true };
}

function resetSession(): void {
  session.abort();
  session = new AbortController();
  catalogs.clear();
}

// ------------------------------------------------------------------ installed

function readMedia(record: Record<string, unknown>): CloudMedia | null {
  const type = record.type;
  if (type !== "video" && type !== "image" && type !== "audio") {
    return null;
  }
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    type,
    durationMs: count(record.durationMs),
    width: count(record.width),
    height: count(record.height),
  };
}

async function readInstalledAsset(dir: string, id: string): Promise<PublicCloudItem | null> {
  try {
    const sidecar = path.join(dir, "asset.json");
    if ((await fsp.stat(sidecar)).size > MAX_SIDECAR_BYTES) {
      return null;
    }
    const record = JSON.parse(await fsp.readFile(sidecar, "utf8")) as Record<string, unknown>;
    const media = readMedia(record);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const file = record.file;
    if (media == null || name === "" || !isSafeCloudPath(file, 1)) {
      return null;
    }
    const mediaPath = path.join(dir, file);
    if (!(await exists(mediaPath))) {
      return null;
    }

    let thumbnail: string | null = null;
    for (const candidate of THUMBNAILS) {
      if (await exists(path.join(dir, candidate))) {
        thumbnail = candidate;
        break;
      }
    }
    if (thumbnail == null && media.type === "image") {
      thumbnail = file;
    }

    return {
      id,
      kind: "asset",
      name,
      category: typeof record.category === "string" ? record.category.trim() || null : null,
      author: null,
      version: null,
      schema: null,
      thumbnail,
      files: [],
      bytes: 0,
      file,
      media,
      thumbnailUrl: null,
      installed: true,
      localPath: mediaPath,
      localThumbnail: thumbnail == null ? null : toPosix(path.join(dir, thumbnail)),
    };
  } catch {
    return null;
  }
}

/**
 * The assets already downloaded, read from their own `asset.json`.
 *
 * Needs neither the network nor the setting: what is on disk is local now,
 * and the asset browser's cloud view shows exactly this while offline.
 */
export async function installedCloudAssets(): Promise<PublicCloudItem[]> {
  const root = cloudAssetRoot(userData());
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: PublicCloudItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isUsableCloudId(entry.name)) {
      continue;
    }
    const item = await readInstalledAsset(path.join(root, entry.name), entry.name);
    if (item != null) {
      found.push(item);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
