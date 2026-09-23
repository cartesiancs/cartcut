/**
 * Where an extension's files live. Main knows, and nobody else does.
 *
 * The rule `autosaveCache.ts` states: **main owns the directory.** The
 * renderer and the host name an extension by its id and never by a path, so
 * there is no call shape in which either of them asks main to delete a path
 * it chose. Every function here takes an id that `EXTENSION_ID_PATTERN` has
 * already accepted, which is what makes joining it to a root safe: the pattern
 * admits no separator, no dot beyond the single one, and no `..`.
 */

import path from "path";
import { app } from "electron";

import { EXTENSION_ID_PATTERN } from "./protocol";

/**
 * Installed extensions, one folder per id.
 *
 * Computed per call rather than at module load, for the reason `preset.ts`
 * gives: `app` is not guaranteed populated while this module is still being
 * imported.
 */
export function extensionsRoot(): string {
  return path.join(app.getPath("userData"), "extensions");
}

/**
 * An extension's own writable corner, which survives an uninstall of the code.
 *
 * Separate from the installed folder on purpose: reinstalling or updating an
 * extension replaces its code wholesale, and a user who has spent an hour
 * configuring it would otherwise lose that to a version bump.
 */
export function extensionDataDir(id: string): string {
  return path.join(app.getPath("userData"), "extension-data", id);
}

export function configFileFor(id: string): string {
  return path.join(extensionDataDir(id), "config.json");
}

export function storageFileFor(id: string): string {
  return path.join(extensionDataDir(id), "storage.json");
}

/**
 * Whether a string can be joined to a root as an extension id.
 *
 * The one gate between an id arriving over IPC and a path being built from
 * it. `isValidAutosaveKey` is the same idea in the same position.
 */
export function isValidExtensionId(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_ID_PATTERN.test(value);
}
