/**
 * Walking preset folders. Plain `fs`, no Electron.
 *
 * Split from `preset.ts` for the reason `ffmpegArgs.ts` is split from the rest
 * of the render path: a module that imports `electron` cannot be loaded by
 * Vitest, and the two lists below are hand-copied across a boundary the build
 * forbids importing over. `electron/` may not import from `apps/app/src` —
 * `.tsconfig` pins `rootDir`, and widening it relocates the whole build out of
 * `main/`. So `presetValidate.ts` has its own copy of these extensions, and
 * `presetScan.test.ts` asserts the two agree, exactly as `ffmpegArgs.test.ts`
 * does for `isAudible`.
 *
 * The scanner is deliberately incurious. It reads text out of shader files,
 * resolves paths for media, and passes `manifest.json` along as a string it has
 * never parsed. Everything that decides what a preset *means* lives in the
 * renderer's validator.
 *
 * The one judgement it does make is about the filesystem: only these extensions
 * are opened. A `.js` in a preset folder is never read, which matters because
 * presets are downloadable content and the renderer that consumes them has
 * `window.electronAPI` in scope.
 */

import path from "path";
import * as fsp from "fs/promises";

/** Read as text into the payload. Must match `presetValidate.ts`. */
export const SHADER_EXTENSIONS = [".frag", ".vert", ".glsl"];

/** Exposed as absolute paths. Must match `presetValidate.ts`. */
export const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mov",
];

/**
 * Largest shader file worth reading, in bytes.
 *
 * A fragment shader is a few kilobytes; this is not a limit any real preset
 * meets. It is a cap so that a folder containing a 500 MB file named `.glsl`
 * cannot be pulled into the renderer's memory at startup.
 */
export const MAX_SHADER_BYTES = 512 * 1024;

/** How many levels of subdirectory inside a preset are searched. */
const PRESET_SUBDIR_DEPTH = 1;

export type RawPresetPayload = {
  id: string;
  dir: string;
  origin: "builtin" | "user";
  manifestJson: string;
  sources: Record<string, string>;
  assets: Record<string, string>;
};

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Read one preset folder.
 *
 * Returns `null` for a directory with no `manifest.json`, which is how a stray
 * folder is skipped rather than reported as broken.
 *
 * Descends one level so a preset may keep its shaders in `shaders/`. The
 * relative key preserves that path, and the renderer's `isSafeRelativePath`
 * accepts exactly this shape.
 */
export async function readPresetDir(
  dir: string,
  origin: "builtin" | "user",
): Promise<RawPresetPayload | null> {
  let manifestJson: string;
  try {
    manifestJson = await fsp.readFile(path.join(dir, "manifest.json"), "utf8");
  } catch {
    return null;
  }

  const sources: Record<string, string> = {};
  const assets: Record<string, string> = {};

  const collect = async (base: string, prefix: string, depth: number) => {
    let entries;
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      const full = path.join(base, entry.name);

      if (entry.isDirectory()) {
        if (depth > 0) {
          await collect(full, relative, depth - 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (SHADER_EXTENSIONS.includes(extension)) {
        try {
          const stat = await fsp.stat(full);
          if (stat.size > MAX_SHADER_BYTES) {
            continue;
          }
          sources[relative] = await fsp.readFile(full, "utf8");
        } catch {
          // A file that cannot be read is simply not offered. The validator
          // then reports the manifest's reference as missing, which is the
          // message an author can act on.
        }
        continue;
      }

      if (ASSET_EXTENSIONS.includes(extension)) {
        assets[relative] = toPosix(full);
      }
      // Everything else — `.js` above all — is neither read nor listed.
    }
  };

  await collect(dir, "", PRESET_SUBDIR_DEPTH);

  return {
    id: path.basename(dir),
    dir: toPosix(dir),
    origin,
    manifestJson,
    sources,
    assets,
  };
}

/**
 * Every preset folder under one root.
 *
 * Accepts both `<root>/<preset>/manifest.json` and
 * `<root>/<group>/<preset>/manifest.json`. The manifest declares its own
 * `kind`, so a `transitions/` or `effects/` directory is organisational rather
 * than meaningful — which is what lets a user drop a single preset folder
 * straight into `userData/presets/` without knowing the convention.
 */
export async function scanPresetRoot(
  root: string,
  origin: "builtin" | "user",
): Promise<RawPresetPayload[]> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    // No such directory. Normal for `userData/presets` until someone installs
    // something, so it is not an error.
    return [];
  }

  const found: RawPresetPayload[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);

    const direct = await readPresetDir(dir, origin);
    if (direct != null) {
      found.push(direct);
      continue;
    }

    let inner;
    try {
      inner = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of inner) {
      if (!child.isDirectory()) {
        continue;
      }
      const payload = await readPresetDir(path.join(dir, child.name), origin);
      if (payload != null) {
        found.push(payload);
      }
    }
  }

  return found;
}
