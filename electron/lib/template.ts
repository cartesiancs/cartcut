/**
 * Serving template folders to the renderer.
 *
 * The walk is in `templateScan.ts`, which imports no Electron and is therefore
 * testable; this file adds only the two things that need `app` — where the
 * built-ins live inside the packaged resources, and where a user's own
 * templates go — plus the one write that removes one.
 *
 * The same division `preset.ts` makes, with one deliberate difference:
 * **installing is not here.** A `.cttpl` is a zip, and the renderer already
 * owns the app's only zip library (JSZip, in `functions/project.ts`); it also
 * has to parse and validate the archive before anything is written, since
 * `features/template/archive.ts` is where the "template.ngt at the root or it
 * is not a template" rule lives. Extracting in main would mean a second zip
 * dependency and a second copy of that rule. So the renderer extracts and
 * writes through the ordinary `filesystem:writeFile` channel, and this side
 * stays as incurious about a template as `presetScan.ts` is about a preset.
 */

import path from "path";
import * as fsp from "fs/promises";
import isDev from "electron-is-dev";
import { app } from "electron";
import { scanTemplateRoot, type RawTemplatePayload } from "./templateScan.js";

export type { RawTemplatePayload };

/**
 * Where the templates that ship with the app live.
 *
 * `app.getAppPath()` in development rather than a bare `"."`, for the reason
 * `preset.ts#builtinPresetPath` spells out: `"."` resolves against the process
 * working directory, which is the repository only when the app was started as
 * `electron .` from inside it.
 */
function builtinTemplatePath(): string {
  const root = isDev === true ? app.getAppPath() : process.resourcesPath;
  return path.join(root, "assets", "templates");
}

/** Where imported templates live. Created on demand, never assumed. */
export function userTemplatePath(): string {
  return path.join(app.getPath("userData"), "templates");
}

/** Whether `child` really sits under `parent`, for the delete guard below. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export const templateLib = {
  /**
   * Built-in and user templates, in that order.
   *
   * Both roots go through the same scanner, so a built-in template is not
   * privileged in any way — the only honest test of the format, as
   * `presetLib.list` puts it. Built-ins are enumerated first so that when two
   * folders claim one id the shipped one is the one the registry keeps.
   */
  list: async (): Promise<{ templates: RawTemplatePayload[] }> => {
    const builtin = await scanTemplateRoot(builtinTemplatePath(), "builtin");
    const user = await scanTemplateRoot(userTemplatePath(), "user");
    return { templates: [...builtin, ...user] };
  },

  /** The folder to reveal, and the one the renderer extracts into. */
  userDirectory: async (): Promise<{ path: string }> => {
    const dir = userTemplatePath();
    await fsp.mkdir(dir, { recursive: true });
    return { path: dir.split(path.sep).join("/") };
  },

  /**
   * Delete an installed template.
   *
   * A recursive delete driven by a string from the renderer, so the guard is
   * the whole of it: the id must be one path segment, and the folder it names
   * must genuinely sit inside `userData/templates`. A built-in cannot be
   * removed at all — it would come back on the next install anyway, and
   * `process.resourcesPath` is inside the application bundle.
   */
  remove: async (id: string): Promise<{ ok: boolean; reason?: string }> => {
    if (typeof id !== "string" || id === "" || id !== path.basename(id)) {
      return { ok: false, reason: "not a template id" };
    }

    const root = userTemplatePath();
    const dir = path.join(root, id);
    if (!isInside(root, dir)) {
      return { ok: false, reason: "not an installed template" };
    }

    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
