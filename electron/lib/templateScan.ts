/**
 * Walking installed template folders. Plain `fs`, no Electron.
 *
 * Split from `template.ts` for the reason `presetScan.ts` is split from
 * `preset.ts`: a module that imports `electron` cannot be loaded by Vitest, and
 * this half is where every rule worth pinning lives.
 *
 * Like the preset scanner it is **deliberately incurious**. A folder is a
 * template if it holds a `template.ngt`, and that is the whole test — the
 * renderer's `features/template/` owns what is inside one. `template.json`
 * crosses as a string this side has never parsed, and the `.ngt` crosses as a
 * **path** rather than as bytes, which is the same choice `.cube` gets in
 * `presetScan.ts` and for the same reason: a library of thirty templates is
 * tens of megabytes of documents, and a project using none of them should read
 * none of them.
 *
 * `electron/` may not import from `apps/app/src` — `.tsconfig` pins `rootDir`,
 * and widening it relocates the whole build out of `main/` — so the two names
 * below are the boundary. `templateScan.test.ts` pins them against the
 * renderer's own constants.
 */

import path from "path";
import * as fsp from "fs/promises";

/** What makes a folder a template. Must match `features/template/archive.ts`. */
export const TEMPLATE_DOCUMENT = "template.ngt";
/** The optional sidecar. Must match `features/template/archive.ts`. */
export const TEMPLATE_MANIFEST = "template.json";

const THUMBNAILS = ["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];

/** A manifest larger than this is not one. Guards a hand-edited folder. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

export type RawTemplatePayload = {
  id: string;
  origin: "builtin" | "user";
  /** The folder, POSIX-separated so the renderer sees one spelling. */
  dir: string;
  ngtPath: string;
  thumbnailPath: string | null;
  /** Raw `template.json`, never parsed on this side. */
  manifestJson: string | null;
};

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Whether this name is a folder name we are willing to use as an id. */
function isUsableId(name: string): boolean {
  return name !== "" && !name.startsWith(".") && name !== "__MACOSX";
}

async function firstPresent(
  dir: string,
  names: readonly string[],
): Promise<string | null> {
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(dir, name));
      if (stat.isFile()) {
        return path.join(dir, name);
      }
    } catch {
      // Not there. Next.
    }
  }
  return null;
}

/**
 * One folder, if it is a template.
 *
 * Answers `null` rather than throwing for anything that is not one — a stray
 * directory under `userData/templates` is not an error, it is a stray
 * directory, and one bad folder must not take the whole library down.
 */
export async function readTemplateDir(
  dir: string,
  origin: "builtin" | "user",
): Promise<RawTemplatePayload | null> {
  const id = path.basename(dir);
  if (!isUsableId(id)) {
    return null;
  }

  const ngtPath = await firstPresent(dir, [TEMPLATE_DOCUMENT]);
  if (ngtPath == null) {
    return null;
  }

  let manifestJson: string | null = null;
  const manifestPath = await firstPresent(dir, [TEMPLATE_MANIFEST]);
  if (manifestPath != null) {
    try {
      const stat = await fsp.stat(manifestPath);
      if (stat.size <= MAX_MANIFEST_BYTES) {
        manifestJson = await fsp.readFile(manifestPath, "utf8");
      }
    } catch {
      // Unreadable manifest, readable template. The renderer falls back to the
      // folder name, which is what `parseTemplateManifest` promises.
    }
  }

  const thumbnailPath = await firstPresent(dir, THUMBNAILS);

  return {
    id,
    origin,
    dir: toPosix(dir),
    ngtPath: toPosix(ngtPath),
    thumbnailPath: thumbnailPath == null ? null : toPosix(thumbnailPath),
    manifestJson,
  };
}

/**
 * Every template directly under `root`, sorted by id.
 *
 * Deliberately **one level deep**, unlike `scanPresetRoot`, which also looks
 * inside a folder someone dropped a preset bundle into. A template's own media
 * lives in subdirectories of its folder, so descending would find the same
 * template again through whatever nesting the author chose.
 */
export async function scanTemplateRoot(
  root: string,
  origin: "builtin" | "user",
): Promise<RawTemplatePayload[]> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    // No such directory. Normal for `userData/templates` until someone
    // installs something, so it is not an error.
    return [];
  }

  const found: RawTemplatePayload[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const payload = await readTemplateDir(path.join(root, entry.name), origin);
    if (payload != null) {
      found.push(payload);
    }
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}
