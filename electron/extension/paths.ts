/**
 * Every place a string from an extension becomes a path.
 *
 * Three callers, one rule: `scheme.ts` turning a URL into a file to serve,
 * `install.ts` turning a zip entry name into a file to write, and `api.ts`
 * deciding whether a `cartcut.fs` call stays inside what the extension was
 * given. Each of those is a boundary where a wrong answer is a read or a write
 * somewhere it was not meant to go, so they share one implementation rather
 * than three that drift.
 *
 * `isSafeRelativePath` is a hand copy of `features/fx/presetValidate.ts`.
 * `electron/` may not import from `apps/app/src` (`.tsconfig` pins `rootDir`,
 * and widening it relocates the whole build out of `main/`), so the copy is
 * unavoidable; `paths.test.ts` dynamically imports both and asserts they agree
 * on a table of inputs, which is the same guard `tools.test.ts` uses for
 * `FILETYPES`.
 */

import path from "path";

/**
 * A plain relative path, with no way out of the folder it is relative to.
 *
 * Refuses a backslash outright rather than normalising it. On Windows a
 * backslash is a separator and on posix it is a legal filename character, so
 * one string would mean two things; refusing it means a manifest cannot be
 * written that resolves to one file on the author's machine and another on the
 * user's.
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  if (value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Whether `child` really sits under `parent`.
 *
 * The same check `electron/lib/template.ts` makes before a delete, lifted here
 * because three more callers need it. Case-folded on Windows: NTFS is case
 * insensitive, so `C:\Users\me\Ext` and `c:\users\me\ext` are one directory,
 * and comparing them as written would let a differently-spelled parent look
 * like an escape.
 */
export function isInside(parent: string, child: string): boolean {
  const a = process.platform === "win32" ? parent.toLowerCase() : parent;
  const b = process.platform === "win32" ? child.toLowerCase() : child;
  const rel = path.relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a relative path against a root, or refuse.
 *
 * Both halves matter. `isSafeRelativePath` rejects the spellings that are
 * obviously an escape, and the `isInside` re-check after `path.resolve`
 * catches the ones that are not: a symlinked segment, a trailing dot on
 * Windows, a name that normalises to something else. Returning `null` rather
 * than throwing is what lets the scheme handler answer 404 instead of turning
 * one bad URL into an unhandled rejection in main.
 */
export function resolveContained(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  return isInside(resolvedRoot, target) ? target : null;
}

/**
 * The POSIX spelling of a path, for anything that crosses to the renderer.
 *
 * The renderer compares these strings to decide two clips share a source, so
 * one separator has to win. The same conversion `presetScan.ts` does, and for
 * the same reason.
 */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
