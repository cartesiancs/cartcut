/**
 * Turning an inline program into a preset folder, minus the filesystem.
 *
 * The renderer has validated the program and hands over a manifest, its
 * sources and its assets. This decides where each of them goes, and it is a
 * security boundary for the same reason `lutInstall.ts` is: the preset id names
 * the folder, the source names name files inside it, and every one of those
 * strings arrived from an agent.
 *
 * So nothing is cleaned up and used: a name that is not already a plain
 * file name is refused, which keeps "the string checked" and "the path written"
 * the same string. No Electron import, so it is tested directly.
 */

import path from "path";

/** The renderer's `presetValidate.ts#ID_PATTERN`, restated: `electron/` may not import it. */
export const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A file directly inside the folder: no separator, no leading dot, no `..`. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What an asset may be: the renderer's `inlineProgram.ts#ASSET_NAME` types. */
const COPYABLE = /\.(png|jpe?g|webp|gif|svg|woff2|ttf|otf)$/i;

/** The prefix inline programs own. A folder may not claim it. */
const INLINE_PREFIX = "inline.";

export type ProgramSavePlan = {
  /** Folder name under `userData/presets`. */
  folder: string;
  /** Relative name to text, for every source and the manifest. */
  files: Record<string, string>;
  /** Relative name to the absolute path it is copied from. */
  copies: Record<string, string>;
};

/**
 * Everything `presetLib.saveProgram` writes, decided. Throws with a message the
 * agent can act on when any name is unusable.
 */
export function planProgramSave(
  id: string,
  manifestJson: string,
  sources: Record<string, string>,
  assets: Record<string, string>,
): ProgramSavePlan {
  if (typeof id !== "string" || !PRESET_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error("a preset id is letters, digits, dots, dashes and underscores, like com.me.glow");
  }
  if (id.startsWith(INLINE_PREFIX)) {
    throw new Error('a preset id may not start with "inline."');
  }

  const files: Record<string, string> = { "manifest.json": manifestJson };
  for (const [name, text] of Object.entries(sources ?? {})) {
    if (!FILE_NAME.test(name) || name.includes("..") || name === "manifest.json") {
      throw new Error(`"${name}" is not a usable source file name`);
    }
    files[name] = String(text);
  }

  const copies: Record<string, string> = {};
  for (const [name, from] of Object.entries(assets ?? {})) {
    if (!FILE_NAME.test(name) || name.includes("..") || files[name] != null) {
      throw new Error(`"${name}" is not a usable asset file name`);
    }
    if (typeof from !== "string" || !path.isAbsolute(from)) {
      throw new Error(`asset "${name}" does not name an absolute path`);
    }
    // The one place main reads a path the renderer chose, so it is held to the
    // kinds of file a graphic can show. A program cannot use this to copy a
    // key file into a folder it can then read back as an "asset".
    if (!COPYABLE.test(from) || !COPYABLE.test(name)) {
      throw new Error(`asset "${name}" is not an image or a font file`);
    }
    copies[name] = from;
  }

  return { folder: id, files, copies };
}
