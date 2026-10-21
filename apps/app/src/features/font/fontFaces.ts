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
  /**
   * Absolute path, the literal "default", or `local:<postscriptName>` for a face
   * installed on the machine a browser build runs on (`localFonts.ts`).
   */
  path: string;
  name: string;
  /** File extension, which is what `@font-face`'s `format()` wants; "local" for a local face. */
  type: string;
  /**
   * Where the face sits in its family, when something better than the file
   * name says so. Only a local face has one: the browser hands over its real
   * family and style, and guessing them back from the postscript name would
   * file "Noto Sans KR" under "NotoSansKR". In memory only; no element stores it.
   */
  face?: { family: string; weight: number; italic: boolean };
  /** A human name for a list that shows faces rather than families. In memory only. */
  label?: string;
};

/** What a text element carries when it has not been given a font. */
export const DEFAULT_FONT: FontEntry = {
  path: "default",
  name: "notosanskr",
  type: "otf",
};

/**
 * The prefix of a `fontpath` naming a face installed on this machine by its
 * postscript name. Drawn with `src: local(...)`, which needs no permission, so
 * a project using one draws wherever that font is installed.
 */
export const LOCAL_FONT_PREFIX = "local:";

/** What `fonttype` holds for a local face. Nothing reads it as a format. */
export const LOCAL_FONT_TYPE = "local";

export function isLocalFontPath(path: unknown): boolean {
  return typeof path === "string" && path.startsWith(LOCAL_FONT_PREFIX);
}

/** The `fontpath` of a local face. */
export function localFontPath(postscriptName: string): string {
  return LOCAL_FONT_PREFIX + postscriptName;
}

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

  // Before the path split: a postscript name is not a file, and the CSS family
  // has to be the postscript name itself so that a project opened later
  // registers exactly the family its clips name.
  if (isLocalFontPath(fontPath)) {
    const postscriptName = fontPath.slice(LOCAL_FONT_PREFIX.length);
    return postscriptName === ""
      ? { ...DEFAULT_FONT }
      : { path: fontPath, name: postscriptName, type: LOCAL_FONT_TYPE };
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

/**
 * How a face's path becomes the URL its `@font-face` loads.
 *
 * The desktop app reads the file straight off disk. A browser build has no
 * `file://` to read, so it installs the rule its media already follows
 * (`functions/mediaUrl.ts`): a site path for the demo, the file route for a
 * self-hosted server. Without that, a font a template ships beside its media
 * registers and never loads, and every clip set in it draws in the fallback.
 */
let fontUrl: (path: string) => string = (path) => "file://" + path;

export function installFontUrlResolver(resolve: (path: string) => string): void {
  fontUrl = resolve;
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
 * The built-in face needs nothing: it is in the app's own stylesheet.
 */
export function ensureFontFace(entry: FontEntry): void {
  ensureFontFaces([entry]);
}

/**
 * Register every face in `entries` that is not registered yet, as one text
 * node. Returns how many were added.
 *
 * One node for the lot because each node appended to the sheet has Blink
 * re-parse the whole of it: a machine with three thousand faces registered one
 * at a time spends seconds doing that.
 *
 * A text node, not `insertAdjacentHTML`, and every string escaped. The name
 * and the path used to be spliced into markup as they were, which was safe
 * while only the font picker supplied them; a graphic's font parameter can
 * come from an agent or a downloaded preset, and a `"` in it would end the
 * string and write whatever followed into the editor's global stylesheet.
 */
export function ensureFontFaces(entries: readonly FontEntry[]): number {
  const fresh: FontEntry[] = [];
  const named = new Set<string>();

  for (const entry of entries ?? []) {
    if (
      entry == null ||
      entry.path === "default" ||
      registered.has(entry.name) ||
      named.has(entry.name)
    ) {
      continue;
    }
    named.add(entry.name);
    fresh.push(entry);
  }

  if (fresh.length === 0) {
    return 0;
  }

  const style = styleElement();
  if (style == null) {
    return 0;
  }

  style.appendChild(document.createTextNode(fresh.map(fontFaceRule).join("\n")));
  for (const entry of fresh) {
    registered.add(entry.name);
  }
  return fresh.length;
}

/**
 * The `@font-face` rule for one face.
 *
 * No `font-weight` descriptor, including for a variable font. Measured in
 * Chromium: a variable face gives all nine rungs from `ctx.font` with or
 * without one, because the engine reads the file's own `fvar` axis and does
 * not need to be told. Declaring a range that changes nothing would be a
 * second, silent source of truth about what a face covers.
 *
 * Decided by the path's prefix rather than by `type`, because some callers
 * (`textTilePainter.faceOf`) build an entry straight from an element's fields.
 */
export function fontFaceRule(entry: FontEntry): string {
  const src = isLocalFontPath(entry.path)
    ? `local(${cssQuoted(entry.path.slice(LOCAL_FONT_PREFIX.length))})`
    : `url(${cssQuoted(fontUrl(entry.path))})`;
  return `@font-face { font-family: ${cssQuoted(entry.name)}; src: ${src}; }`;
}

/**
 * A CSS string literal. Backslash and quote escaped; line breaks, which cannot
 * appear in a CSS string at all, replaced. Exported for the tests.
 */
export function cssQuoted(text: string): string {
  return (
    '"' +
    String(text)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, " ") +
    '"'
  );
}

/** Families this module has injected. Exported for tests. */
export function loadedFontFamilies(): string[] {
  return [...registered];
}

/**
 * Register every font a loaded document refers to.
 *
 * Opening a `.ngt` used to inject nothing at all: the only callers of
 * `ensureFontFace` are the font *picker* paths, so a text element that named a
 * font nobody had picked this session drew in the fallback (in the preview and
 * in the export, and on the machine that authored it), not just after the
 * project was carried somewhere else. The element kept the right `fontname`
 * and there was simply no `@font-face` for the canvas to resolve it against,
 * which is what made it silent.
 *
 * Returns how many families it added, which is only useful for tests:
 * `ensureFontFace` is idempotent, so calling this twice is free.
 */
export function registerDocumentFonts(
  elements: Record<string, unknown>,
): number {
  return ensureFontFaces(documentFontEntries(elements));
}

/**
 * Every face a document's text clips name, its own and its runs', once each and
 * without the built-in one.
 *
 * Read straight off the stored fields rather than through `runsOf`, because
 * this runs before the document is in the store and a face is worth
 * registering even if the run turns out to be junk. A per-range font is a face
 * no element's own `fontpath` names, so without the runs the styled stretch
 * alone would draw in the fallback the next time the project was opened.
 */
export function documentFontEntries(
  elements: Record<string, unknown>,
): FontEntry[] {
  const found = new Map<string, FontEntry>();
  const add = (path: unknown) => {
    if (typeof path !== "string" || path === "") {
      return;
    }
    const entry = parseFontPath(path);
    if (entry.path !== DEFAULT_FONT.path && !found.has(entry.name)) {
      found.set(entry.name, entry);
    }
  };

  for (const element of Object.values(elements ?? {})) {
    if (element == null || typeof element !== "object") {
      continue;
    }
    const { filetype, fontpath, runs } = element as {
      filetype?: string;
      fontpath?: unknown;
      runs?: unknown;
    };
    if (filetype !== "text") {
      continue;
    }
    add(fontpath);
    if (Array.isArray(runs)) {
      for (const run of runs) {
        add((run as { style?: { fontpath?: unknown } } | null)?.style?.fontpath);
      }
    }
  }

  return [...found.values()];
}

/** Long enough for a local file; a face that takes longer draws in the fallback. */
const FACE_LOAD_TIMEOUT_MS = 3000;

const ready = new Map<string, Promise<void>>();

/**
 * Resolves once `face` can be drawn, or once waiting stops being worth it.
 * Memoised per family, and free without a document.
 *
 * A canvas given a family that has not loaded draws in the fallback and says
 * nothing, so anything that draws a face once and keeps the result (a text
 * tile, an exported frame) waits on this first.
 */
export function faceReady(face: FontEntry): Promise<void> {
  const known = ready.get(face.name);
  if (known != null) {
    return known;
  }
  const fonts =
    typeof document === "undefined"
      ? undefined
      : (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.load == null) {
    return Promise.resolve();
  }
  ensureFontFace(face);
  const loading = Promise.race([
    fonts.load(`16px ${cssQuoted(face.name)}`).catch(() => []),
    new Promise<void>((resolve) => setTimeout(resolve, FACE_LOAD_TIMEOUT_MS)),
  ]).then(() => undefined);
  ready.set(face.name, loading);
  return loading;
}
