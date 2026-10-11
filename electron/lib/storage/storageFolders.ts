/**
 * The folders Settings can open, by name. The renderer sends one of these and
 * main resolves it, so no call can make main open a path the renderer chose.
 */

export const STORAGE_FOLDERS = ["appData", "recordings", "autosave", "logs", "temp"] as const;

export type StorageFolder = (typeof STORAGE_FOLDERS)[number];

export function isStorageFolder(value: unknown): value is StorageFolder {
  return typeof value === "string" && (STORAGE_FOLDERS as readonly string[]).includes(value);
}
