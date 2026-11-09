/**
 * How a project saved in a browser finds its media again.
 *
 * A browser hands the editor a `File`, and the timeline names it by an object
 * URL (`blob:<origin>/<uuid>#name.ext`, `mediaRegistry.ts`) that dies with the
 * page. So a `.ngt` saved in a browser carries, beside those URLs, what each
 * one was: name, size, modification time and type, in an optional seventh
 * entry, `webMedia.json`. Opening the project maps every dead URL to a live one
 * for the same file, found one of two ways:
 *
 *  - **remembered**: in Chrome and Edge a picked file comes with a
 *    `FileSystemFileHandle`, kept in IndexedDB under the file's identity
 *    (`webStore.ts`) and opened again with the user's permission;
 *  - **picked again**: anything else is matched against files the user picks,
 *    by name, then size, then modification time (`matchPicked`).
 *
 * The entry follows the optional-field rule: absent when the project names no
 * `blob:` media, so a project saved anywhere else is unchanged. Only `blob:`
 * values are recorded; a site path (`/examples/...`) or a server path
 * (`/api/file?path=...`) still resolves after a reload. Pure and DOM-free.
 */

export const WEB_MEDIA_ENTRY = "webMedia.json";

export type MediaIdentity = {
  name: string;
  /** Bytes, or `null` when the archive did not say (an older save, a path with only a name). */
  size: number | null;
  lastModified: number | null;
  type: string;
};

/** The key a remembered handle is filed under; the same as `importedMedia.ts#identityOf`. */
export function identityKey(identity: { name: string; size: number | null; lastModified: number | null }): string {
  return `${identity.name}\u0000${identity.size ?? ""}\u0000${identity.lastModified ?? ""}`;
}

/** Every `blob:` string anywhere in a value, in the order met. */
export function blobPathsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (value.startsWith("blob:")) {
      into.add(value);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      blobPathsIn(item, into);
    }
    return into;
  }
  if (value != null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      blobPathsIn(item, into);
    }
  }
  return into;
}

/** The file name a `blob:` path carries in its fragment, or `""`. */
export function nameFromPath(path: string): string {
  const hash = path.indexOf("#");
  if (hash === -1) {
    return "";
  }
  const raw = path.slice(hash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The entry's text, or `null` when there is nothing to record. `identityOf`
 * answers for a path this session can still read, `null` for one it cannot.
 */
export function webMediaEntry(
  paths: Iterable<string>,
  identityOf: (path: string) => MediaIdentity | null,
): string | null {
  const files: Record<string, MediaIdentity> = {};
  for (const path of paths) {
    const identity = identityOf(path);
    if (identity != null) {
      files[path] = identity;
    }
  }
  return Object.keys(files).length === 0 ? null : JSON.stringify({ v: 1, files });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What an archive said each `blob:` path was. Never throws; a bad entry reads as empty. */
export function parseWebMediaEntry(text: string | null | undefined): Map<string, MediaIdentity> {
  const out = new Map<string, MediaIdentity>();
  if (text == null || text === "") {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (files == null || typeof files !== "object") {
    return out;
  }
  for (const [path, raw] of Object.entries(files as Record<string, unknown>)) {
    if (!path.startsWith("blob:") || raw == null || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name !== "" ? record.name : nameFromPath(path);
    if (name === "") {
      continue;
    }
    out.set(path, {
      name,
      size: numberOrNull(record.size),
      lastModified: numberOrNull(record.lastModified),
      type: typeof record.type === "string" ? record.type : "",
    });
  }
  return out;
}

/**
 * What every dead path in a project was: from the entry where it says, else
 * the name in the path's own fragment, which is all an older save carries.
 */
export function identitiesFor(
  paths: Iterable<string>,
  entry: Map<string, MediaIdentity>,
): Map<string, MediaIdentity> {
  const out = new Map<string, MediaIdentity>();
  for (const path of paths) {
    const known = entry.get(path);
    if (known != null) {
      out.set(path, known);
      continue;
    }
    const name = nameFromPath(path);
    if (name !== "") {
      out.set(path, { name, size: null, lastModified: null, type: "" });
    }
  }
  return out;
}

export type PickedCandidate = { name: string; size: number; lastModified: number };

/**
 * Which picked file answers each missing path, by index into `picked`.
 *
 * A name must match, exactly or else ignoring case. Where the archive knew the
 * size it must match too, because two takes called `clip.mp4` are different
 * files; the modification time breaks a tie between same-named, same-sized
 * picks, and is not required, because copying a file to another disk can
 * change it. One file may answer several paths: a project can name the same
 * file under two object URLs from two sessions.
 */
export function matchPicked(
  missing: ReadonlyMap<string, MediaIdentity>,
  picked: readonly PickedCandidate[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, want] of missing) {
    let best = -1;
    let bestScore = -1;
    picked.forEach((candidate, index) => {
      const exactName = candidate.name === want.name;
      const looseName = exactName || candidate.name.toLowerCase() === want.name.toLowerCase();
      if (!looseName) {
        return;
      }
      if (want.size != null && candidate.size !== want.size) {
        return;
      }
      const score =
        (exactName ? 2 : 0) +
        (want.size != null ? 4 : 0) +
        (want.lastModified != null && candidate.lastModified === want.lastModified ? 1 : 0);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0) {
      out.set(path, best);
    }
  }
  return out;
}

/**
 * `value` with every string equal to a key of `map` replaced by its value,
 * copied only where something changed: what nothing touched comes back by
 * identity.
 */
export function rewritePaths<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (map.size === 0) {
    return value;
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return map.get(node) ?? node;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => {
        const out = walk(item);
        changed ||= out !== item;
        return out;
      });
      return changed ? next : node;
    }
    if (node != null && typeof node === "object") {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        const out = walk(item);
        changed ||= out !== item;
        next[key] = out;
      }
      return changed ? next : node;
    }
    return node;
  };
  return walk(value) as T;
}
