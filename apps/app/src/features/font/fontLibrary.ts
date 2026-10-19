/**
 * Every typeface the app can offer, loaded once: the bundled ones under
 * `assets/fonts/google` and the system's.
 *
 * The text panel and `ControlText` each fetch these lists for themselves; a
 * graphic's font parameter needs them too, and synchronously at draw time to
 * resolve `bundled:<file>`. So the lists are fetched here once and kept, and
 * `bundledPath` answers from the cache (`null` until it has arrived, which
 * draws in the default face, the contract a missing font already has).
 */

import { parseFontPath, type FontEntry } from "./fontFaces";
import { localFontStore } from "./localFonts";

type Listing = { path: string; name: string; type: string };

let bundled: FontEntry[] | null = null;
let system: FontEntry[] | null = null;
let loading: Promise<void> | null = null;

function fontBridge(): any {
  return (globalThis as any)?.electronAPI?.req?.font;
}

function entries(result: any): FontEntry[] {
  const list: Listing[] = Array.isArray(result?.fonts) ? result.fonts : [];
  return list
    .filter((font) => typeof font?.path === "string" && font.path !== "")
    .map((font) => parseFontPath(font.path));
}

/** Fetch both lists, once. Never throws; a missing bridge leaves them empty. */
export function loadFontLibrary(): Promise<void> {
  if (loading != null) {
    return loading;
  }
  loading = (async () => {
    try {
      bundled = entries(await fontBridge()?.getPresetFontLists?.());
    } catch {
      bundled = [];
    }
    try {
      system = entries(await fontBridge()?.getLists?.());
    } catch {
      system = [];
    }
  })();
  return loading;
}

/** The bundled faces, or `[]` before `loadFontLibrary` has finished. */
export function bundledFonts(): FontEntry[] {
  return bundled ?? [];
}

/**
 * The system's faces, or `[]` before `loadFontLibrary` has finished.
 *
 * In a browser build that is the fonts on this computer, once the user has let
 * the browser list them (`localFonts.ts`). They arrive after startup, so this
 * is read from their store on every call rather than cached with the rest;
 * subscribe to `localFontStore` to hear of them.
 */
export function systemFonts(): FontEntry[] {
  const local = localFontStore.getState().fonts;
  return local.length === 0 ? system ?? [] : [...(system ?? []), ...local];
}

/** The absolute path of a bundled face by file name, or `null`. */
export function bundledPath(file: string): string | null {
  for (const entry of bundled ?? []) {
    const name = entry.path.split(/[\\/]/).pop();
    if (name === file) {
      return entry.path;
    }
  }
  return null;
}

/** For tests: answer as if the lists had loaded with these. */
export function __setFontLibraryForTesting(next: {
  bundled?: FontEntry[];
  system?: FontEntry[];
}): void {
  bundled = next.bundled ?? [];
  system = next.system ?? [];
  loading = Promise.resolve();
}
