/**
 * Unpacking a `.cartcut-ext`, and refusing the ones that are traps.
 *
 * `planExtractions` reads **names, never bytes**, which is what keeps the
 * whole rule pure and node-testable, the same split
 * `features/template/archive.ts` makes for a `.cttpl`. The rule it enforces is
 * that file's rule too, and worth repeating because it is the difference
 * between an installer and a remote write primitive: `../`, an absolute name,
 * a Windows drive and a backslash are **refused outright** rather than
 * sanitised, and one hostile name refuses the whole archive. An archive
 * containing one traversal is not an archive with a bad file in it; it is a
 * hostile archive.
 *
 * The write half is `.part` then rename, which `autosaveCache.ts` states the
 * reason for: there is no instant in which the target directory exists and is
 * half an extension.
 */

import path from "path";

import { isSafeRelativePath } from "./paths";

/** What a valid archive turns into. Directory entries are dropped, not created. */
export type ExtractionPlan =
  | { ok: true; files: string[] }
  | { ok: false; reason: string };

/** The one file every archive must carry at its root. */
export const MANIFEST_ENTRY = "package.json";

/**
 * A `.cartcut-ext` larger than this is not one.
 *
 * Not a limit any real extension meets. It is a cap so that a 4GB file named
 * `.cartcut-ext` cannot be read into main's memory before anything has looked
 * at what is inside it.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function planExtractions(entryNames: readonly string[]): ExtractionPlan {
  const files: string[] = [];

  for (const name of entryNames) {
    if (name.endsWith("/")) {
      // A directory entry. Every file name carries its own directories, so
      // creating these separately would be one more path to validate for no
      // gain.
      continue;
    }
    if (!isSafeRelativePath(name)) {
      return { ok: false, reason: "the archive contains an unsafe entry name: " + JSON.stringify(name) };
    }
    files.push(name);
  }

  if (!files.includes(MANIFEST_ENTRY)) {
    return {
      ok: false,
      reason: "the archive has no " + MANIFEST_ENTRY + " at its root, so it is not an extension",
    };
  }

  return { ok: true, files };
}

/** Where an extension being installed is assembled before it is named. */
export function stagingDirFor(root: string, id: string): string {
  return path.join(root, ".part-" + id);
}

export function installedDirFor(root: string, id: string): string {
  return path.join(root, id);
}
