/**
 * Path arithmetic for portable projects — the half that is pure string work.
 *
 * A `.ngt` records where its media lives. Until now it recorded only absolute
 * paths, so handing someone a folder containing a project and its clips gave
 * them the timeline and nothing to play: every path named a directory on the
 * author's machine. This module is what lets the same folder answer for itself
 * on another one.
 *
 * Three constraints shape every function here, and none of them are stylistic.
 *
 * **No imports at all.** Not `node:path`, not `node:url`. The renderer is
 * bundled by webpack 5 with no `resolve.fallback`, so a node-core import is a
 * build failure rather than a runtime one — but even if it resolved it would be
 * wrong, because `node:path` only ever answers for the *host* platform and the
 * entire point is reading a project written on the other one. `fileURLToPath`
 * is worse than unavailable: on the malformed Windows form this app mints (see
 * below) it does not throw, it silently returns `/C:/Users/…` when run on
 * posix, and it truncates `file:///Users/me/a?b.mp4` at the `?`.
 *
 * **`flavour` is an explicit parameter, never `process.platform`.** Same rule
 * `utils/platform.ts` states for `isMac`, and for the same reason: a test that
 * leans on the host covers one branch on one CI machine, and the branch it
 * misses is exactly the cross-platform case this module exists for. Callers
 * derive it from the `.ngt`'s own path with `detectFlavour`.
 *
 * **Never `decodeURIComponent`, never `new URL`.** `functions/path.ts#encode`
 * escapes `#` and nothing else — no code in this app percent-encodes a space,
 * a `%` or a `?`. So a localpath carries those literally, `decodeURIComponent`
 * throws on a file named `100%.mp4`, and `new URL().pathname` eats everything
 * after a `?`. The exact inverse of `encode` is `%23` → `#`, and that is all
 * `toFsPath` does. Note that `encode` is **not injective** — `a#b` and `a%23b`
 * both mint `a%23b` — so decoding is a deliberate choice of the common case.
 *
 * The relative paths this produces are always POSIX-separated, because that is
 * the one form both readers can parse. Separator conversion happens on the way
 * back out, in `resolveInside`.
 */

export type PathFlavour = "posix" | "win32";

/** Whether a `localpath` was stored as a `file://` URL or as a bare path. */
export type PathShape = "url" | "bare";

/** `{ root, segs }` for an absolute path, or `null` if it is not one. */
export type SplitPath = {
  /** `""` on posix, `"C:"` for a drive, `"\\\\server\\share"` for a UNC share. */
  root: string;
  /** Path segments below the root, with `""` and `"."` already removed. */
  segs: string[];
};

/**
 * Which platform's path syntax a string is written in.
 *
 * Derived from the `.ngt`'s own path, which arrives from a native file dialog
 * and so is always in the host's syntax.
 *
 * The ordering matters: the leading-slash test has to come **before** the
 * backslash sniff, because a backslash is a perfectly legal character in a
 * posix filename and `/Users/me/we\ird/p.ngt` is a posix path.
 */
export function detectFlavour(pathOrUrl: string): PathFlavour {
  const p = stripFileScheme(pathOrUrl);

  if (/^[A-Za-z]:[\\/]/.test(p)) {
    return "win32";
  }
  if (/^[\\/]{2}/.test(p)) {
    return "win32";
  }
  if (p.startsWith("/")) {
    return "posix";
  }
  if (p.includes("\\")) {
    return "win32";
  }
  return "posix";
}

/**
 * Drop a `file://` prefix if there is one.
 *
 * Deliberately dumb. `file:///Users/x` leaves `/Users/x`; the Windows form
 * `file://C:\p\a` leaves `C:\p\a`, already native. `file://localhost/Users/x`
 * — a form this app never mints — leaves `localhost/Users/x`, which is not
 * absolute, so `splitSegments` returns `null` and the caller keeps the path
 * untouched. Degrading to "leave it alone" is the right failure here.
 */
export function stripFileScheme(value: string): string {
  const match = /^file:\/\/([\s\S]*)$/i.exec(value);
  return match ? match[1] : value;
}

/**
 * A `localpath` as something the filesystem — and `existFile` — will accept.
 *
 * Three shapes arrive here, all of them real:
 *  - `file:///Users/me/a.mp4` from `element/mediaProbe.ts#toLocalPath`
 *  - a bare absolute path, from `rasterizeText.ts` and the screen recorders
 *  - `file://C:\Users\me\a.mp4` on Windows, where `toLocalPath` concatenates
 *    without converting separators, so the drive letter lands where a URL host
 *    goes. Chromium tolerates it, which is why it has survived.
 */
export function toFsPath(localpath: string, flavour: PathFlavour): string {
  let value = stripFileScheme(localpath);

  // `file:///C:/p/a.mp4` — the well-formed Windows file URL. Nothing in this
  // app mints it today, but a hand-edited project or a future fix to
  // `toLocalPath` would, and dropping the leading slash costs one test.
  if (flavour === "win32" && /^\/[A-Za-z]:/.test(value)) {
    value = value.slice(1);
  }

  return value.replace(/%23/g, "#");
}

/**
 * The inverse: a filesystem path as the app's own `localpath`.
 *
 * **This deliberately reproduces the malformed Windows form.** The rule is not
 * "mint a correct URL", it is "mint exactly what `toLocalPath` would have minted
 * for this file on this platform" — because `timeline/mergeOps.ts` decides two
 * clips share a source by comparing these strings, `loadedAssetStore` keys its
 * cache on them, and `timeline/strip/tiles.ts` keys decoded filmstrips on them.
 * Producing a second, tidier string for the same file would make a clip that
 * came from a template refuse to merge with one freshly imported from the same
 * path, and would decode every filmstrip twice.
 *
 * `assetPaths.test.ts` pins the agreement against the real `toLocalPath`, so a
 * future fix there fails this suite rather than silently splitting the format
 * in two.
 */
export function mintLocalPath(fsPath: string, shape: PathShape): string {
  return shape === "url" ? `file://${fsPath.replace(/#/g, "%23")}` : fsPath;
}

/** Which form a stored `localpath` was in, so a rewrite can preserve it. */
export function shapeOf(localpath: string): PathShape {
  return /^file:\/\//i.test(localpath) ? "url" : "bare";
}

/**
 * Break an absolute path into a root and its segments, or `null`.
 *
 * The single comparison primitive. Everything else in this module is phrased in
 * terms of it, which is what keeps the `/p/proj` vs `/p/proj2` trap from having
 * to be remembered at each call site — segments never `startsWith`.
 *
 * `null` means "not something we are willing to reason about": a relative path,
 * a bare drive (`C:proj`), a `\\?\` long-path prefix, a UNC without both a
 * server and a share, or any path containing `..`. Callers read `null` as
 * "leave this path absolute", which is always safe.
 *
 * `..` is refused rather than collapsed. Collapsing it textually is a lie when
 * a symlink is involved, and asset paths come from file dialogs and `readdir`,
 * so they are already canonical — there is nothing to collapse in practice.
 */
export function splitSegments(
  p: string,
  flavour: PathFlavour,
): SplitPath | null {
  let root: string;
  let raw: string[];

  if (flavour === "win32") {
    if (/^[\\/]{2}/.test(p)) {
      // `\\?\C:\…` and `\\.\device` are namespace prefixes, not shares.
      if (/^[\\/]{2}[?.][\\/]/.test(p)) {
        return null;
      }
      const parts = p.slice(2).split(/[\\/]+/);
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        return null;
      }
      root = `\\\\${parts[0]}\\${parts[1]}`;
      raw = parts.slice(2);
    } else {
      const drive = /^([A-Za-z]):[\\/]/.exec(p);
      if (drive == null) {
        return null;
      }
      // Uppercased so `c:\proj` and `C:\proj` produce the same root. This is
      // the one canonicalisation this module performs, and it is why a Windows
      // save-then-reload can change a path's text without changing its meaning.
      root = `${drive[1].toUpperCase()}:`;
      raw = p.slice(3).split(/[\\/]+/);
    }
  } else {
    if (!p.startsWith("/")) {
      return null;
    }
    root = "";
    // Only `/`. A backslash is a legal character in a posix filename and must
    // not be treated as a separator here.
    raw = p.slice(1).split("/");
  }

  const segs = raw.filter((s) => s !== "" && s !== ".");

  if (segs.some((s) => s === ".." || s.includes("\0"))) {
    return null;
  }

  return { root, segs };
}

/**
 * Segment equality.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: only the locale-aware form applies
 * the Turkish dotless-i mapping, which would make `I` and `ı` compare equal for
 * a user whose locale happens to be `tr`.
 */
function segEq(a: string, b: string, flavour: PathFlavour): boolean {
  return flavour === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The project file's own directory, as segments below `root`. */
function projectDir(
  projectFile: string,
  flavour: PathFlavour,
): SplitPath | null {
  const split = splitSegments(toFsPath(projectFile, flavour), flavour);
  // A project path with no filename is not a project path.
  if (split == null || split.segs.length < 1) {
    return null;
  }
  return { root: split.root, segs: split.segs.slice(0, -1) };
}

/**
 * `assetPath` relative to the project's folder, POSIX-separated — or `null` if
 * it is not inside it.
 *
 * Both arguments go through `toFsPath` first, so either may be a bare path or
 * any of the `file://` forms. Normalising one and not the other would be a
 * footgun: the only caller holds a `localpath`, whose shape it does not choose.
 *
 * Never produces `../`. That is the whole design: a path that climbs out of the
 * project folder breaks the moment the folder alone is moved, which is the one
 * thing a template has to survive. Anything outside stays absolute.
 */
export function relativizeInside(
  assetPath: string,
  projectFile: string,
  flavour: PathFlavour,
): string | null {
  const asset = splitSegments(toFsPath(assetPath, flavour), flavour);
  const dir = projectDir(projectFile, flavour);

  if (asset == null || dir == null) {
    return null;
  }
  // Different drive, or a different UNC share.
  if (!segEq(asset.root, dir.root, flavour)) {
    return null;
  }
  // Equal length means the asset *is* the directory; shorter means it is above.
  if (asset.segs.length <= dir.segs.length) {
    return null;
  }
  for (let i = 0; i < dir.segs.length; i += 1) {
    if (!segEq(asset.segs[i], dir.segs[i], flavour)) {
      return null;
    }
  }

  const tail = asset.segs.slice(dir.segs.length);

  // Only reachable on posix, where `a\b.mp4` is one legal filename. Storing it
  // would hand a win32 reader a string it must split into two segments, so the
  // stored format keeps the stronger property — a backslash in a relative path
  // is *always* a separator error — and this one pathological name stays
  // absolute. `fx/presetValidate.ts#isSafeRelativePath` refuses backslashes for
  // the same reason rather than normalising them.
  if (tail.some((s) => s.includes("\\"))) {
    return null;
  }

  return tail.join("/");
}

/**
 * A stored relative path back to an absolute one in `flavour`'s syntax.
 *
 * Rejects anything that could escape the project folder. `rel` comes out of a
 * file someone else wrote, so this is a trust boundary: `../`, an absolute
 * path, a drive letter, a backslash and an embedded NUL are all refused rather
 * than sanitised, and the caller falls back to the absolute path it already had.
 */
export function resolveInside(
  rel: unknown,
  projectFile: string,
  flavour: PathFlavour,
): string | null {
  if (typeof rel !== "string" || rel === "") {
    return null;
  }
  if (rel.includes("\\") || rel.includes("\0")) {
    return null;
  }
  // A drive-relative path (`C:x`) or a drive-absolute one (`C:/x`).
  if (/^[A-Za-z]:/.test(rel)) {
    return null;
  }

  const segs = rel.split("/");
  // `""` covers a leading `/`, a trailing `/` and a doubled `//` in one test.
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }

  const dir = projectDir(projectFile, flavour);
  if (dir == null) {
    return null;
  }

  const sep = flavour === "win32" ? "\\" : "/";
  return dir.root + sep + [...dir.segs, ...segs].join(sep);
}
