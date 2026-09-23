/**
 * Installing a `.cartcut-ext`, for real, on disk.
 *
 * `install.ts` decides what an archive may contain; this writes it. The split
 * is the one `presetScan.ts` and `preset.ts` make: the decisions are pure and
 * tested, and the part that needs `app` and a zip library is thin enough to
 * read in one go.
 *
 * JSZip rather than `decompress-zip`, which the old extension loader used and
 * which this replaces. The app already carries JSZip for `.ngt` and
 * `.cttpl`, one zip library is enough, and `decompress-zip`'s callback API
 * made the old loader's "did it work?" unanswerable.
 */

import * as fsp from "fs/promises";
import path from "path";
import JSZip from "jszip";

import { installedDirFor, planExtractions, stagingDirFor, MANIFEST_ENTRY, MAX_ARCHIVE_BYTES } from "./install";
import { resolveContained } from "./paths";
import { validateManifest, type ExtensionManifest } from "./manifest";

export type InstallOutcome =
  | { ok: true; id: string; dir: string; manifest: ExtensionManifest; replaced: boolean }
  | { ok: false; reason: string };

/**
 * Read the archive and say what it is, without writing anything.
 *
 * Two steps rather than one so the Extensions panel can show the permissions
 * before a single file is extracted. A user who declines at that point must
 * not already have an extension on disk.
 */
export async function inspectArchive(file: string): Promise<
  { ok: true; manifest: ExtensionManifest; files: string[]; bytes: Buffer } | { ok: false; reason: string }
> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(file);
  } catch (error) {
    return { ok: false, reason: "could not read the file: " + String(error) };
  }

  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    return { ok: false, reason: "that file is " + bytes.byteLength + " bytes, which is too large to be an extension" };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, reason: "that file is not a zip archive" };
  }

  const plan = planExtractions(Object.keys(zip.files).filter((name) => !zip.files[name].dir));
  if (!plan.ok) {
    return { ok: false, reason: plan.reason };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await zip.file(MANIFEST_ENTRY)!.async("string")) as unknown;
  } catch (error) {
    return { ok: false, reason: "its " + MANIFEST_ENTRY + " is not readable JSON: " + String(error) };
  }

  // Validated against no folder name: the folder does not exist yet, and the
  // manifest's own id is what will name it.
  const result = validateManifest(manifestJson, "");
  if (!result.ok) {
    return { ok: false, reason: result.errors.join("; ") };
  }

  return { ok: true, manifest: result.manifest, files: plan.files, bytes };
}

/**
 * Write an inspected archive into place.
 *
 * Staged then renamed, so there is no instant in which the extension's
 * directory exists and holds half of it. The superseded directory is removed
 * *before* the rename rather than after, because a rename onto an existing
 * directory fails on every platform; the window that opens is the one case
 * where an interrupted install leaves nothing rather than leaves a mixture,
 * which is the better of the two.
 */
export async function installInspected(
  root: string,
  manifest: ExtensionManifest,
  files: readonly string[],
  bytes: Buffer,
): Promise<InstallOutcome> {
  const staging = stagingDirFor(root, manifest.id);
  const target = installedDirFor(root, manifest.id);

  try {
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    const zip = await JSZip.loadAsync(bytes);
    for (const name of files) {
      const destination = resolveContained(staging, name);
      if (destination == null) {
        // `planExtractions` already refused every unsafe name, so reaching
        // here means the two disagree. Refusing rather than continuing keeps
        // that a bug report instead of a write outside the staging folder.
        await fsp.rm(staging, { recursive: true, force: true });
        return { ok: false, reason: "the archive entry `" + name + "` did not resolve inside the install folder" };
      }
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, await zip.file(name)!.async("nodebuffer"));
    }

    let replaced = false;
    try {
      await fsp.stat(target);
      replaced = true;
      await fsp.rm(target, { recursive: true, force: true });
    } catch {
      replaced = false;
    }

    await fsp.rename(staging, target);
    return { ok: true, id: manifest.id, dir: target, manifest, replaced };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove an installed extension. The id has already passed the id pattern. */
export async function uninstallExtension(root: string, id: string): Promise<void> {
  await fsp.rm(installedDirFor(root, id), { recursive: true, force: true });
}
