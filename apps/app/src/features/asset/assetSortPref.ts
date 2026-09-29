/**
 * Where the asset panel's Sort By is remembered between launches: one choice
 * for every folder, in `localStorage`.
 *
 * `localStorage` rather than `electron-store` because the value has to be
 * there synchronously when `assetStore` is created. An IPC read would land
 * after the first paint and re-sort a folder the user is already looking at.
 *
 * Every read and write may throw (a profile with site data blocked, a context
 * with no storage at all, vitest under node, which reaches this module through
 * `agent/commands/read.ts`), and every one of them means "use the default",
 * never a crash.
 */

import { AssetSort, coerceAssetSort, DEFAULT_ASSET_SORT } from "./assetSort";

export const ASSET_SORT_STORAGE_KEY = "cartcut.assetSort";

export type SortStoragePort = {
  read(): string | null;
  write(value: string): void;
};

export function loadAssetSort(port: SortStoragePort): AssetSort {
  try {
    const raw = port.read();
    return raw == null ? DEFAULT_ASSET_SORT : coerceAssetSort(JSON.parse(raw));
  } catch {
    return DEFAULT_ASSET_SORT;
  }
}

export function saveAssetSort(port: SortStoragePort, sort: AssetSort): void {
  try {
    port.write(JSON.stringify({ key: sort.key, direction: sort.direction }));
  } catch {
    // The choice still holds for this session; it just will not outlive it.
  }
}

/** The real one. `localStorage` is looked up at each call, never at import. */
export const browserSortStorage: SortStoragePort = {
  read: () => globalThis.localStorage?.getItem(ASSET_SORT_STORAGE_KEY) ?? null,
  write: (value) =>
    globalThis.localStorage?.setItem(ASSET_SORT_STORAGE_KEY, value),
};
