/**
 * What a `font` parameter's value means, and how CSS names it.
 *
 * Three forms, chosen so a project stays portable:
 *
 *  - `"default"`: the app's own face.
 *  - `"bundled:<file>"`: one of the faces in `assets/fonts/google`. Every
 *    install has them, at a path that differs per machine, so the value names
 *    the file and not the path.
 *  - an absolute path: a face the user picked from the system, which travels
 *    the way a text clip's `fontpath` does (`project/assetsFile.ts`).
 *
 * CSS sees `--<key>` as a family list with the default face behind it, so a
 * face that has not loaded yet falls back to something that has Hangul.
 */

import {
  DEFAULT_FONT,
  cssQuoted,
  parseFontPath,
  type FontEntry,
} from "../font/fontFaces";

export const BUNDLED_PREFIX = "bundled:";

/** The face a value names, or the default face when it names nothing usable. */
export function fontEntryFor(
  value: unknown,
  bundledPath: (file: string) => string | null,
): FontEntry {
  if (typeof value !== "string" || value === "" || value === "default") {
    return { ...DEFAULT_FONT };
  }
  if (value.startsWith(BUNDLED_PREFIX)) {
    const path = bundledPath(value.slice(BUNDLED_PREFIX.length));
    return path == null ? { ...DEFAULT_FONT } : parseFontPath(path);
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return parseFontPath(value);
  }
  return { ...DEFAULT_FONT };
}

/** The family list `--<key>` carries for a face. */
export function cssFamilyOf(entry: FontEntry): string {
  const name = entry.name === DEFAULT_FONT.name ? DEFAULT_FONT.name : entry.name;
  return `${cssQuoted(name)}, ${cssQuoted(DEFAULT_FONT.name)}, sans-serif`;
}

/**
 * A text clip's `fontpath` as a font parameter's value: a bundled face by file
 * name, so the converted project stays portable, and any other path as itself.
 */
export function fontValueOfPath(
  fontpath: string,
  bundled: readonly FontEntry[],
): string {
  if (typeof fontpath !== "string" || fontpath === "" || fontpath === "default") {
    return "default";
  }
  for (const entry of bundled) {
    if (entry.path === fontpath) {
      return BUNDLED_PREFIX + (fontpath.split(/[\\/]/).pop() ?? "");
    }
  }
  return fontpath;
}
