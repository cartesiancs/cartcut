/**
 * Serving preset folders to the renderer.
 *
 * The walk itself is in `presetScan.ts`, which imports no Electron and is
 * therefore testable; this file adds only the two things that need `app`: where
 * the built-ins live inside the packaged resources, and where a user's own
 * presets go.
 *
 * Neither half parses a manifest. `electron/` cannot import from
 * `apps/app/src` — widening `rootDir` relocates the whole build out of `main/`
 * and the app stops finding its entry point — so anything this side understood
 * about the preset schema would have to be duplicated by hand and kept in sync.
 * Understanding nothing means there is nothing to duplicate:
 * `features/fx/presetValidate.ts` owns the schema outright.
 *
 * There is deliberately no "read this file" call. Everything a preset needs is
 * read during enumeration, so the renderer never hands back a path to open and
 * there is no second entry point to traverse out of.
 *
 * `installLut` is the one *write*, and it is the same shape: it copies a file
 * the user chose into a folder of its own and writes a manifest for it, then
 * says nothing about what is inside. Importing a LUT this way rather than into
 * a registry of its own means an imported table is a preset like any other —
 * it survives a restart, it appears in search, it gets a thumbnail, and it can
 * be used as an adjustment layer — with no second code path anywhere.
 */

import { listExtensions } from "../extension/host.js";
import { resolveContained } from "../extension/paths.js";
import path from "path";
import * as fsp from "fs/promises";
import isDev from "electron-is-dev";
import { app } from "electron";
import { scanPresetRoot, type RawPresetPayload } from "./presetScan.js";
import { planLutInstall } from "./lutInstall.js";
import { planProgramSave } from "./programSave.js";

export type { RawPresetPayload };

/**
 * Where the presets that ship with the app live.
 *
 * `app.getAppPath()` in development, **not** the `"."` the rest of this
 * codebase uses. A bare `"."` resolves against the process working directory,
 * which is the repository only when the app was started as `electron .` from
 * inside it. Launch the same build any other way — `open -a` on the bundle, a
 * debugger, a launcher — and the cwd is `/`, every bundled asset silently
 * resolves to nothing, and the feature looks broken in a way that has nothing
 * to do with the feature.
 *
 * `getAppPath` is the path Electron was actually given, so it is right under
 * every launch method. In a packaged build assets sit beside the executable
 * rather than inside the asar, which is what `extraResources` puts them at.
 *
 * Computed per call rather than at module load: `app` is not guaranteed
 * populated while this module is still being imported.
 */
function builtinPresetPath(): string {
  const root = isDev === true ? app.getAppPath() : process.resourcesPath;
  return path.join(root, "assets", "presets");
}

/** Where user-installed presets live. Created on demand, never assumed. */
export function userPresetPath(): string {
  return path.join(app.getPath("userData"), "presets");
}

/**
 * The `presets/` folder of every enabled extension that has one.
 *
 * Asked of the extension host's listing rather than walked directly, so a
 * disabled extension contributes nothing and an unpacked one contributes from
 * wherever the developer keeps it. The path is checked before it is used: the
 * folder name comes from a manifest, and `contributes.presets` is a string a
 * stranger wrote.
 */
async function extensionPresetRoots(): Promise<Array<{ extensionId: string; dir: string }>> {
  const roots: Array<{ extensionId: string; dir: string }> = [];

  for (const listing of listExtensions()) {
    if (!listing.enabled || listing.presetsFolder == null || listing.presetsFolder === "") {
      continue;
    }
    // Checked, not trusted. `contributes.presets` is a string a stranger
    // wrote, and it is about to become a directory to walk.
    const folder = resolveContained(listing.dir, listing.presetsFolder);
    if (folder == null) {
      continue;
    }
    roots.push({ extensionId: listing.id, dir: folder });
  }

  return roots;
}

export const presetLib = {
  /**
   * Built-in and user presets, in that order.
   *
   * Both roots go through exactly the same scanner. A built-in preset is not
   * privileged in any way, which is the only honest test of the format: if a
   * third-party preset were going to break, a built-in one would break in the
   * same place.
   *
   * Built-ins are enumerated first so that, when two folders claim one id, the
   * registry's first-wins rule keeps the shipped one.
   */
  list: async (): Promise<{ presets: RawPresetPayload[] }> => {
    const builtin = await scanPresetRoot(builtinPresetPath(), "builtin");

    // Extensions in the middle: after the built-ins, so a shipped preset keeps
    // its id under the registry's first-wins rule, and before the user's own,
    // so a preset someone installed by hand still wins over one an extension
    // brought with it.
    const extension: RawPresetPayload[] = [];
    for (const contributor of await extensionPresetRoots()) {
      extension.push(
        ...(await scanPresetRoot(contributor.dir, "extension", contributor.extensionId)),
      );
    }

    const user = await scanPresetRoot(userPresetPath(), "user");
    return { presets: [...builtin, ...extension, ...user] };
  },

  /** The folder to reveal when the user asks where to put presets. */
  userDirectory: async (): Promise<{ path: string }> => {
    const dir = userPresetPath();
    await fsp.mkdir(dir, { recursive: true });
    return { path: dir.split(path.sep).join("/") };
  },

  /**
   * Copy a LUT file into a preset folder of its own.
   *
   * The renderer has already parsed the bytes and knows they are a LUT — this
   * side stays incurious, as the scanner does. What it decides is *where* the
   * folder goes and what it is called, and that decision lives in
   * `lutInstall.ts` so it can be tested: the name arrives with a file someone
   * downloaded, and a folder name is a path.
   *
   * Returns the preset id so the caller can select the new filter immediately.
   */
  installLut: async (
    name: string,
    extension: string,
    bytes: Uint8Array,
  ): Promise<{ id: string; dir: string }> => {
    const plan = planLutInstall(name, extension);

    const root = userPresetPath();
    await fsp.mkdir(root, { recursive: true });

    // A second import of the same name replaces the first rather than piling
    // up `kodak-2`, `kodak-3`: re-importing is overwhelmingly "I fixed that
    // file", not "I want both".
    const dir = path.join(root, plan.folder);
    await fsp.mkdir(dir, { recursive: true });

    await fsp.writeFile(path.join(dir, plan.source), bytes);
    await fsp.writeFile(path.join(dir, "manifest.json"), plan.manifest, "utf8");

    return { id: plan.id, dir: dir.split(path.sep).join("/") };
  },

  /**
   * Write an inline program out as a user preset folder.
   *
   * The renderer validated it under this id before handing it over
   * (`agent/commands/program.ts#export_program`), so the folder loads on the
   * next `loadPresets`. `programSave.ts` decides every name; this only writes.
   * An existing folder of the same id is replaced, the rule `installLut` keeps
   * for a re-import.
   */
  saveProgram: async (
    id: string,
    manifestJson: string,
    sources: Record<string, string>,
    assets: Record<string, string>,
  ): Promise<{ id: string; dir: string }> => {
    const plan = planProgramSave(id, manifestJson, sources, assets);
    const root = userPresetPath();
    const dir = path.join(root, plan.folder);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(plan.files)) {
      await fsp.writeFile(path.join(dir, name), text, "utf8");
    }
    for (const [name, from] of Object.entries(plan.copies)) {
      await fsp.copyFile(from, path.join(dir, name));
    }
    return { id, dir: dir.split(path.sep).join("/") };
  },
};
