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
 */

import path from "path";
import * as fsp from "fs/promises";
import isDev from "electron-is-dev";
import { app } from "electron";
import { scanPresetRoot, type RawPresetPayload } from "./presetScan.js";

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
    const user = await scanPresetRoot(userPresetPath(), "user");
    return { presets: [...builtin, ...user] };
  },

  /** The folder to reveal when the user asks where to put presets. */
  userDirectory: async (): Promise<{ path: string }> => {
    const dir = userPresetPath();
    await fsp.mkdir(dir, { recursive: true });
    return { path: dir.split(path.sep).join("/") };
  },
};
