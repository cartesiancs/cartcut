/**
 * The data layer for the asset browser.
 *
 * Everything here is either pure or takes its IO as a parameter, so the whole
 * module is testable under vitest's `node` environment without jsdom. The one
 * function that touches the outside world, `readDirectory`, defaults to the
 * real IPC call but accepts a replacement.
 */

import { DEFAULT_ASSET_SORT, sortAssetEntries } from "./assetSort";

export interface AssetEntry {
  /** Basename only, e.g. "clip.mp4" — never a full path. */
  name: string;
  isDirectory: boolean;
  /**
   * Bytes, for a file. Absent for a folder, whose `stat` size is its inode's
   * rather than its contents', and for a listing that did not report one (the
   * web demo's sample list).
   */
  size?: number;
  /** `mtimeMs`, absent when unreported. */
  modifiedMs?: number;
  /**
   * `birthtimeMs`, absent when unreported or 0. A Linux filesystem without
   * statx answers 0, and a clip born in 1970 would sort as the oldest thing on
   * the disk rather than as one whose age is unknown.
   */
  createdMs?: number;
}

/**
 * `filesystem:getDirectory` answers with an object keyed by filename:
 * `{ "clip.mp4": { isDirectory: false, title: "clip.mp4", size, mtimeMs, birthtimeMs } }`
 * (`electron/lib/listDirectory.ts`).
 *
 * Iterating that object directly — which every call site used to do — leaks JS
 * object key semantics into the UI: integer-like filenames ("1.mp4", "2.mp4")
 * get hoisted ahead of everything else regardless of insertion order. Turning
 * it into an array up front and sorting deliberately is the fix.
 */
export function normalizeDirectoryEntries(raw: unknown): AssetEntry[] {
  if (raw == null || typeof raw != "object") {
    return [];
  }

  const entries: AssetEntry[] = [];

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value == null || typeof value != "object") {
      continue;
    }

    // `title` is what the handler sends, but the key is the filename too, so
    // fall back to it rather than dropping the entry.
    const name = typeof value.title == "string" ? value.title : key;
    if (name == "") {
      continue;
    }

    const isDirectory = Boolean(value.isDirectory);
    const entry: AssetEntry = { name: name, isDirectory: isDirectory };

    // Each key is set only when it holds a usable number, so an entry with
    // nothing reported has no key at all rather than one holding `undefined`.
    if (!isDirectory && isFiniteAtLeast(value.size, 0)) {
      entry.size = value.size;
    }
    if (isFiniteAbove(value.mtimeMs, 0)) {
      entry.modifiedMs = value.mtimeMs;
    }
    if (isFiniteAbove(value.birthtimeMs, 0)) {
      entry.createdMs = value.birthtimeMs;
    }

    entries.push(entry);
  }

  return sortEntries(entries);
}

function isFiniteAtLeast(value: unknown, min: number): value is number {
  return typeof value == "number" && Number.isFinite(value) && value >= min;
}

function isFiniteAbove(value: unknown, min: number): value is number {
  return typeof value == "number" && Number.isFinite(value) && value > min;
}

/**
 * Folders first, then files, each group alphabetical: the panel's default
 * order. `assetSort.ts` owns every order, this one included.
 */
export function sortEntries(entries: AssetEntry[]): AssetEntry[] {
  return sortAssetEntries(entries, DEFAULT_ASSET_SORT);
}

/**
 * The containing directory, or null when there is nowhere left to go.
 *
 * Returning null for the root is what stops the "up" button from walking off
 * the top into `""`, which reaches `fs.readdir("")` and fails silently.
 */
export function parentDirectory(dir: string): string | null {
  if (dir == "" || dir == "/") {
    return null;
  }

  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const lastSlash = trimmed.lastIndexOf("/");

  if (lastSlash < 0) {
    return null;
  }
  if (lastSlash == 0) {
    return "/";
  }

  return trimmed.slice(0, lastSlash);
}

/**
 * Joins without the doubled separator that plain `${dir}/${name}` produces at
 * the filesystem root — that "//clip.mp4" reached the timeline as an asset path.
 */
export function joinPath(dir: string, name: string): string {
  if (dir == "") {
    return name;
  }

  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${base}/${name}`;
}

export type GetDirectoryFn = (dir: string) => Promise<unknown>;

const defaultGetDirectory: GetDirectoryFn = (dir) =>
  window.electronAPI.req.filesystem.getDirectory(dir);

/**
 * Reads a directory and returns it sorted and normalized.
 *
 * `ipcWrapper` swaps `window.electronAPI` wholesale for an axios-backed shim on
 * web and demo, so there is no environment branch to make here.
 */
export async function readDirectory(
  dir: string,
  getDirectory: GetDirectoryFn = defaultGetDirectory,
): Promise<AssetEntry[]> {
  const raw = await getDirectory(dir);
  return normalizeDirectoryEntries(raw);
}
