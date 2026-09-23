/**
 * The two lists that outlive a launch: what is loaded unpacked, what is off.
 *
 * `electron-store` rather than a file of our own, because the app already has
 * one and a second settings file would be a second thing to find when a user
 * asks why an extension is disabled.
 */

import Store from "electron-store";

const store = new Store();

const UNPACKED_KEY = "ext_unpacked_paths";
const DISABLED_KEY = "ext_disabled";

function readList(key: string): string[] {
  const value = store.get(key);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function unpackedPaths(): string[] {
  return readList(UNPACKED_KEY);
}

export function addUnpackedPath(dir: string): string[] {
  const next = [...new Set([...unpackedPaths(), dir])];
  store.set(UNPACKED_KEY, next);
  return next;
}

export function removeUnpackedPath(dir: string): string[] {
  const next = unpackedPaths().filter((entry) => entry !== dir);
  store.set(UNPACKED_KEY, next);
  return next;
}

export function disabledIds(): string[] {
  return readList(DISABLED_KEY);
}

export function isEnabled(id: string): boolean {
  return !disabledIds().includes(id);
}

export function setEnabled(id: string, enabled: boolean): void {
  const current = disabledIds();
  const next = enabled ? current.filter((entry) => entry !== id) : [...new Set([...current, id])];
  store.set(DISABLED_KEY, next);
}
