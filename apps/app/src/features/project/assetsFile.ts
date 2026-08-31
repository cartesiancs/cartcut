/**
 * The `assetPaths.json` entry of a `.ngt` project, written and read.
 *
 * This is what makes a project folder portable: alongside the absolute paths
 * `timeline.json` has always carried, it records a **relative** path for every
 * asset that sits inside the project's own folder. Copy the folder to another
 * machine and the relative paths still name the files; the absolute ones do not.
 *
 * Same shape as `renderOptionsFile.ts` and for the same reason — `project.ts`
 * reaches for `document.querySelector`, `window.electronAPI` and JSZip within a
 * few lines of every branch, so a question like "does a template survive being
 * moved" had no way to be asked of it. Here it is a round trip between two
 * functions, one of them pure and the other pure apart from an injected
 * existence check.
 *
 * **The invariant this file defends: the in-memory document is always
 * absolute.** A relative path exists only inside the archive. That is why
 * `loadedAssetStore`, `ffmpegArgs`, the MCP tools, the preview and the export
 * needed no changes at all — the conversion happens at the two file boundaries
 * and nowhere else.
 *
 * **Why a sidecar, and not a rewritten `localpath`.** The absolute path has to
 * survive as a fallback. The most common thing a user does is move the `.ngt`
 * *alone* — onto the desktop, into Dropbox — and if the rewrite had eaten the
 * absolute path, every clip in a project that used to work would break. A
 * sidecar makes the relative path a *preference* rather than a *replacement*:
 * try relative, fall back to the absolute that was always there. Strictly more
 * projects open than before, and none that opened stop.
 *
 * **Why not a `relpath` field on the element.** Because then it is element
 * *state*: it enters `@types/timeline.ts`, flows through `normalizeDocument`,
 * is copied into every undo snapshot, becomes a decision for
 * `agent/serialize.ts`'s whitelist and for MCP output — and goes stale the
 * moment `localpath` changes, with no op maintaining it. A relative path is a
 * derived, save-time artifact, not state. Please do not "simplify" it into the
 * element.
 *
 * The schema version does not move for this. `renderOptionsFile.ts` states the
 * convention: a new entry that older files simply lack, answered by a default
 * on the way in, is not a format change. An old build ignores an entry it does
 * not know and opens the project from the absolute paths; a new build opening
 * an old project finds no entry and behaves exactly as it did before.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  detectFlavour,
  mintLocalPath,
  relativizeInside,
  resolveInside,
  shapeOf,
  splitSegments,
  toFsPath,
  type PathFlavour,
} from "./assetPaths";

/** The two element fields that name a file on disk. */
export type AssetField = "localpath" | "fontpath";

/**
 * One recorded path.
 *
 * `abs` is not redundant. Both entries are written from the same `elements`
 * object in the same call, so they always agree unless the archive was edited
 * or half-merged — and at load `rel` is trusted only when `abs` still matches
 * the element byte for byte. Without that check a tampered archive could point
 * a clip at a different file and nothing would look wrong: the wrong video
 * simply plays.
 */
export type AssetPathEntry = { rel: string; abs: string };

export type AssetPathsFile = {
  version: 1;
  entries: Record<string, Partial<Record<AssetField, AssetPathEntry>>>;
};

/**
 * `localpath` values that are not paths.
 *
 * Kept as belt and braces behind the `filetype` check below, for elements
 * written by a build whose sentinels differed. `"/TEXTELEMENT"` is the reason
 * the filetype check is the primary one: it begins with a slash, so it *looks*
 * like a posix absolute path, and a project saved at a volume root would
 * relativise it to `TEXTELEMENT` and then fail to find it.
 */
const SENTINELS = new Set([
  "SHAPE",
  "EFFECT",
  "TRANSITION",
  "GROUP",
  "/TEXTELEMENT",
  "default",
]);

/** Schemes `toLocalPath` passes through untouched, none of them local files. */
const FOREIGN_SCHEME = /^(https?|blob|data):/i;

/**
 * Which fields of this element name a real file.
 *
 * Driven by `filetype` rather than by inspecting the string, so it is
 * exhaustive against the nine element types and stays correct if someone
 * invents a tenth sentinel.
 */
export function assetFieldsOf(element: TimelineElement): AssetField[] {
  const filetype = (element as { filetype?: string }).filetype;

  switch (filetype) {
    case "video":
    case "image":
    case "gif":
    case "audio":
      return ["localpath"];
    case "text":
      return ["fontpath"];
    // group, shape, effect, transition carry a sentinel and nothing else.
    default:
      return [];
  }
}

/** Whether a field's value is something worth trying to locate on disk. */
function isRealAssetPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !SENTINELS.has(value) &&
    !FOREIGN_SCHEME.test(value)
  );
}

/** Every `(id, field, value)` in the document that names a file. */
function assetPathsOf(
  elements: Record<string, TimelineElement>,
): { id: string; field: AssetField; value: string }[] {
  const found: { id: string; field: AssetField; value: string }[] = [];

  for (const id of Object.keys(elements)) {
    const element = elements[id];
    if (element == null || typeof element !== "object") {
      continue;
    }
    for (const field of assetFieldsOf(element)) {
      const value = (element as Record<string, unknown>)[field];
      if (isRealAssetPath(value)) {
        found.push({ id, field, value });
      }
    }
  }

  return found;
}

/**
 * Is this a project path we can anchor against?
 *
 * Empty in the demo and web builds, where `#projectFile` is never set and
 * `demo/warningDemoEnv.ts` uses values like `/sample/clip.mp4` that look like
 * absolute paths. Both entry points refuse to do anything without a real one.
 */
function anchorFlavour(projectFile: string): PathFlavour | null {
  if (typeof projectFile !== "string" || projectFile === "") {
    return null;
  }
  const flavour = detectFlavour(projectFile);
  const split = splitSegments(toFsPath(projectFile, flavour), flavour);
  // Needs at least a filename, or it names a directory rather than a project.
  return split != null && split.segs.length >= 1 ? flavour : null;
}

/**
 * Build the entry, from the document and where it is about to be written.
 *
 * `projectDestination` is where the project is being saved *now*, which is not
 * necessarily where it was opened from. Passing the previously opened path
 * would be the bug that makes a relocated template save paths relative to the
 * folder it came from.
 *
 * Assets outside the project folder produce no entry at all — never a `../`.
 * A path that climbs out of the folder breaks the moment the folder alone is
 * moved, which is precisely what a template has to survive.
 *
 * The entry is written even when empty. `{}` means "a build that understands
 * portability looked and found nothing in-folder"; a missing entry means "an
 * older build wrote this". That distinction costs nothing and is worth having.
 */
export function serializeAssetPaths(
  elements: Record<string, TimelineElement>,
  projectDestination: string,
): AssetPathsFile {
  const file: AssetPathsFile = { version: 1, entries: {} };

  const flavour = anchorFlavour(projectDestination);
  if (flavour == null) {
    return file;
  }

  for (const { id, field, value } of assetPathsOf(elements)) {
    const rel = relativizeInside(value, projectDestination, flavour);
    if (rel == null) {
      continue;
    }
    const entry = file.entries[id] ?? (file.entries[id] = {});
    entry[field] = { rel, abs: value };
  }

  return file;
}

/** `raw` as an entries map, or an empty one for anything unreadable. */
function readEntries(raw: unknown): AssetPathsFile["entries"] {
  if (raw == null || typeof raw !== "object") {
    return {};
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (entries == null || typeof entries !== "object") {
    return {};
  }
  return entries as AssetPathsFile["entries"];
}

/** The recorded relative path for one field, if the file records a usable one. */
function recordedRel(
  entries: AssetPathsFile["entries"],
  id: string,
  field: AssetField,
  current: string,
): string | null {
  const entry = entries[id];
  if (entry == null || typeof entry !== "object") {
    return null;
  }
  const record = entry[field];
  if (record == null || typeof record !== "object") {
    return null;
  }
  // The consistency check: trust `rel` only while the archive still agrees
  // with itself about what it describes.
  if (record.abs !== current || typeof record.rel !== "string") {
    return null;
  }
  return record.rel;
}

export type RelinkResult = {
  elements: Record<string, TimelineElement>;
  /** How many fields were pointed somewhere new. */
  relinked: number;
  /** Distinct files that could not be found — not clips. */
  missing: number;
};

/** An `existFile`-shaped probe. The web build's shim answers `"none"`. */
export type ExistsFn = (fsPath: string) => Promise<unknown>;

/**
 * Point every asset at a file that is actually there.
 *
 * Per field, in order: the recorded relative path resolved against *this*
 * project's folder, then the absolute path the document already carried. If
 * neither is on disk the value is left exactly as it was and counted — a
 * project always opens, whatever is missing from it.
 *
 * Returns `elements` **by identity** when nothing moved, which is the same
 * decline convention the pure timeline ops use.
 */
export async function relinkAssets(
  elements: Record<string, TimelineElement>,
  raw: unknown,
  projectFile: string,
  exists: ExistsFn,
): Promise<RelinkResult> {
  const flavour = anchorFlavour(projectFile);
  if (flavour == null) {
    return { elements, relinked: 0, missing: 0 };
  }

  const entries = readEntries(raw);
  const fields = assetPathsOf(elements);

  // Both candidates per field, resolved before anything is probed.
  const plans = fields.map(({ id, field, value }) => {
    const rel = recordedRel(entries, id, field, value);
    return {
      id,
      field,
      value,
      relPath: rel == null ? null : resolveInside(rel, projectFile, flavour),
      absPath: toFsPath(value, flavour),
    };
  });

  // One probe per distinct path. A 200-clip project is usually a dozen files,
  // and when nothing has moved the relative and absolute candidates are the
  // same string, so this collapses to one probe per file. Probing serially
  // would put that many IPC round trips between `clearTimeline()` and
  // `patchDocument`, with the timeline visibly empty for the duration.
  const wanted = new Set<string>();
  for (const plan of plans) {
    if (plan.relPath != null) {
      wanted.add(plan.relPath);
    }
    wanted.add(plan.absPath);
  }

  const paths = [...wanted];
  const results = await Promise.all(
    paths.map(async (p) => {
      try {
        // The web build's shim returns the string "none", which is truthy.
        return (await exists(p)) === true;
      } catch {
        return false;
      }
    }),
  );
  const present = new Map(paths.map((p, i) => [p, results[i]]));

  const updates: { id: string; field: AssetField; value: string }[] = [];
  const missing = new Set<string>();

  for (const plan of plans) {
    if (plan.relPath != null && present.get(plan.relPath) === true) {
      const next = mintLocalPath(plan.relPath, shapeOf(plan.value));
      if (next !== plan.value) {
        updates.push({ id: plan.id, field: plan.field, value: next });
      }
      continue;
    }
    if (present.get(plan.absPath) !== true) {
      missing.add(plan.absPath);
    }
  }

  if (updates.length === 0) {
    return { elements, relinked: 0, missing: missing.size };
  }

  const next: Record<string, TimelineElement> = { ...elements };
  for (const { id, field, value } of updates) {
    next[id] = { ...next[id], [field]: value } as TimelineElement;
  }

  return { elements: next, relinked: updates.length, missing: missing.size };
}
