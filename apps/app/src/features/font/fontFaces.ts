/**
 * Registering a font family with the page, so the canvas can actually draw it.
 *
 * This is not cosmetic. `renderer/text.ts` sets
 * `ctx.font = "… ${fontSize}px ${textElement.fontname}"`, and a canvas resolves
 * that family against the document's font faces like any CSS consumer. If no
 * `@font-face` has been injected for the name, the text silently renders in
 * the fallback — in the preview *and* in the export, since the export composites
 * through the same renderers.
 *
 * Until now only `optionText.insertFontLists()` injected them, and only for the
 * fonts that panel had enumerated. Anything that sets a font from elsewhere has
 * to do this too.
 */

export type FontEntry = {
  /** Absolute path, or the literal "default". */
  path: string;
  name: string;
  /** File extension, which is what `@font-face`'s `format()` wants. */
  type: string;
};

/** What a text element carries when it has not been given a font. */
export const DEFAULT_FONT: FontEntry = {
  path: "default",
  name: "notosanskr",
  type: "otf",
};

/**
 * Split a font path into the three fields a text element stores.
 *
 * Mirrors the derivation in `optionText.handleChangeTextFont`, which takes the
 * last path segment and splits on ".". Done here rather than at each call site
 * because the three fields have to agree — a name without its matching path
 * draws in the fallback, and a path without its type produces an `@font-face`
 * with the wrong `format()`.
 */
export function parseFontPath(fontPath: string): FontEntry {
  if (fontPath == null || fontPath === "" || fontPath === "default") {
    return { ...DEFAULT_FONT };
  }

  const segments = fontPath.split(/[\\/]/);
  const filename = segments[segments.length - 1] ?? "";
  const dot = filename.lastIndexOf(".");

  // A directory with a dot in it must not be mistaken for the extension, which
  // is why this splits the *filename* and takes the last dot rather than the
  // first dot of the whole path.
  const name = dot > 0 ? filename.slice(0, dot) : filename;
  const type = dot > 0 ? filename.slice(dot + 1) : "";

  if (!name) {
    return { ...DEFAULT_FONT };
  }

  return { path: fontPath, name, type };
}

/** Families already injected, so a repeated call is free. */
const registered = new Set<string>([DEFAULT_FONT.name]);

/** The stylesheet `optionText` also writes into, created on first use. */
function styleElement(): HTMLStyleElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  let style = document.querySelector("style#fontStyles") as HTMLStyleElement | null;
  if (style == null) {
    style = document.createElement("style");
    style.id = "fontStyles";
    document.head.appendChild(style);
  }
  return style;
}

/**
 * Make `entry.name` usable as a canvas font family. Idempotent.
 *
 * The built-in face needs nothing — it is in the app's own stylesheet.
 */
export function ensureFontFace(entry: FontEntry): void {
  if (entry.path === "default" || registered.has(entry.name)) {
    return;
  }

  const style = styleElement();
  if (style == null) {
    return;
  }

  style.insertAdjacentHTML(
    "beforeend",
    `@font-face { font-family: "${entry.name}"; src: url("file://${entry.path}"); }`,
  );
  registered.add(entry.name);
}

/** Families this module has injected. Exported for tests. */
export function loadedFontFamilies(): string[] {
  return [...registered];
}
