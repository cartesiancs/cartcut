/**
 * What a recovery ring is keyed by.
 *
 * A project has one of two identities and the key says which:
 *
 * - **`f-<digest>-<basename>`** — a project with a `.ngt` on disk. The ring
 *   holds the divergence since the last save, and a successful save drops it.
 * - **`s-<sessionId>`** — a project never saved. The ring is the *only* copy,
 *   which is the case the whole feature exists for.
 *
 * The digest is what makes an arbitrary path into one legal path segment on
 * every platform; the basename is appended for a human looking in the folder.
 * Neither is ever parsed back — the authoritative anchor lives in the ring's
 * `meta.json` and in the archive itself.
 *
 * **No imports of `node:path`**, the rule `assetPaths.ts` states: it only ever
 * answers for the host platform, which is the wrong one half the time here,
 * and webpack has no `resolve.fallback` so it would not resolve anyway. Path
 * flavour is an explicit parameter, so both branches are covered on one CI
 * host.
 */

import { detectFlavour, stripFileScheme, type PathFlavour } from "./assetPaths";
import { digest64 } from "./projectDigest";

/** A ring key. `f-` for a file-backed project, `s-` for a session. */
export type AutosaveKey = string;

/** Mirrors `electron/lib/autosaveCache.ts#isValidAutosaveKey`. */
const KEY = /^[fs]-[A-Za-z0-9_.-]{1,80}$/;

export function isValidAutosaveKey(key: unknown): key is AutosaveKey {
  return (
    typeof key === "string" &&
    KEY.test(key) &&
    key !== "." &&
    key !== ".." &&
    !key.includes("/") &&
    !key.includes("\\")
  );
}

/** How many characters of the basename ride along for legibility. */
const LABEL_MAX = 40;

/**
 * Collapse `.` and `..` segments, so two spellings of one path agree.
 *
 * **Case is deliberately not folded.** Two spellings that differ only in case
 * give two rings, which is a duplicate recovery point and harmless; folding
 * them would merge two genuinely different files on a case-sensitive volume,
 * which is not. Chosen in the safe direction and recorded as a known limit.
 */
export function normalizeProjectPath(
  localpath: string,
  flavour: PathFlavour = detectFlavour(localpath),
): string {
  const bare = stripFileScheme(localpath);
  const sep = flavour === "win32" ? /[\\/]+/ : /\/+/;

  const parts = bare.split(sep);
  // A leading empty part is the posix root, or a Windows drive/UNC prefix.
  const root = parts.length > 0 ? parts[0] : "";
  const out: string[] = [];

  for (const part of parts.slice(1)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }

  const joiner = flavour === "win32" ? "\\" : "/";
  return `${root}${joiner}${out.join(joiner)}`;
}

/** The last segment of a path, whatever separator it uses. */
export function basenameOf(
  localpath: string,
  flavour: PathFlavour = detectFlavour(localpath),
): string {
  const bare = stripFileScheme(localpath);
  const parts = bare.split(flavour === "win32" ? /[\\/]+/ : /\/+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "") {
      return parts[i];
    }
  }
  return "";
}

/**
 * The part of a project's name that is safe in a path segment.
 *
 * Everything outside `[A-Za-z0-9_.-]` becomes `-`, then runs of `-` collapse
 * and the ends are trimmed, so a Korean or emoji filename does not produce a
 * segment of dashes that looks like corruption. An empty result is dropped
 * entirely rather than padded: the digest already identifies the ring, so the
 * label is decoration and a project whose whole name is non-ASCII simply gets
 * `f-<digest>`.
 *
 * `aux` and friends are not special-cased. Windows reserves those names for a
 * whole path *segment*, and a segment here is always `f-<digest>-aux`.
 */
export function labelSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, LABEL_MAX);
  // `.` and `..` would be a path segment with a meaning of its own.
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}

/**
 * The ring key for a project saved at `localpath`.
 *
 * The digest is over the *normalized* path, so `/a/b/../Film.ngt` and
 * `/a/Film.ngt` are one ring.
 */
export function keyForProjectFile(
  localpath: string,
  flavour: PathFlavour = detectFlavour(localpath),
): AutosaveKey {
  const normalized = normalizeProjectPath(localpath, flavour);
  const label = labelSegment(basenameOf(normalized, flavour));
  const key = label === ""
    ? `f-${digest64(normalized)}`
    : `f-${digest64(normalized)}-${label}`;
  // The digest is 16 chars and the label is capped at 40, so this cannot
  // exceed the pattern's 80 — but the pattern is the contract, and a key that
  // fails it would mean a project that silently never autosaves.
  return isValidAutosaveKey(key) ? key : `f-${digest64(normalized)}`;
}

/** The ring key for a project that has never been saved. */
export function keyForSession(sessionId: string): AutosaveKey {
  const key = `s-${digest64(sessionId)}`;
  return isValidAutosaveKey(key) ? key : "s-0";
}

/**
 * What the menu calls a ring.
 *
 * The file's own name for a saved project; for an unsaved one, "Untitled"
 * plus when the session started — two untitled rings in the list are
 * otherwise indistinguishable, which is the one thing a recovery list must
 * never be.
 */
export function ringLabel(
  projectFile: string | null,
  startedAtMs: number,
  formatDate: (atMs: number) => string,
): string {
  if (projectFile != null && projectFile !== "") {
    const name = basenameOf(projectFile);
    if (name !== "") {
      return name;
    }
  }
  return `Untitled (${formatDate(startedAtMs)})`;
}
