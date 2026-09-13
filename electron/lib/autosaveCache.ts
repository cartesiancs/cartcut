/**
 * The Auto Save cache on disk: one ring of recovery points per project.
 *
 * No Electron in here — `root` is a parameter — so `autosaveCache.test.ts`
 * drives the real thing against a real temporary directory. `autosave.ts` is
 * the thin layer that knows where `userData` is. The same split
 * `reverse.ts`/`reversePipeline.ts` and `template.ts`/`templateScan.ts` make,
 * for the same reason.
 *
 * ```
 * <root>/
 *   f-3a9c1e77b2d40915-Film/          a project saved as Film.ngt
 *     meta.json                       { v, label, anchor }
 *     20260913T142530-123Z-a1b2.ngt
 *     20260913T142631-088Z-7f3e.ngt
 *   s-9d41c0a2fe8b5613/               a project never saved
 *     meta.json                       { v, label, anchor: null }
 *     20260913T094102-401Z-c55d.ngt
 * ```
 *
 * ## Four rules, each paid for by a failure mode
 *
 * - **The filename carries the time**, zero-padded and fixed-width, so a
 *   lexicographic sort is chronological and the menu can be built without
 *   opening a single zip. `contactSheet.ts` makes the same choice
 *   ("the filename carries the range so a directory of them is readable") and
 *   `reversePipeline.ts` relies on the same sortability for its segments.
 *   `filesystem:getDirectory` reports no mtime anyway, so the name is the only
 *   place the time can live.
 * - **`.part` then rename**, the `reverse.ts` idiom. A truncated autosave that
 *   the menu offers is worse than no autosave at all: it looks like a recovery
 *   point and restores nothing.
 * - **A ring with an unreadable `meta.json` is still listed**, labelled from
 *   its directory name. Never hide a recovery point because its label could
 *   not be read.
 * - **A missing root is `[]`, not a throw.** The `scanTemplateRoot` rule, and
 *   here it is load-bearing twice over: this list builds the File menu, and a
 *   throw would take the whole menu bar with it.
 *
 * ## On pruning at all
 *
 * `electron/mcp/contactSheet.ts` states a policy against sweeping — *"a tool
 * that deletes files it did not create is a worse trade than a few
 * kilobytes"* — and this module is the repo's first prune, so it owes an
 * answer. It is this: **every file this prune deletes is one this module
 * wrote, in a directory this module created, named by a pattern this module
 * mints, and matched against that pattern before it is unlinked.** That is a
 * different act from sweeping a directory it does not own. A contact sheet is
 * also a few kilobytes; a ring of ten projects is not.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/** How many recovery points a ring keeps. */
export const RING_SIZE = 10;

/** A ring untouched for this long is dropped at startup. */
export const ORPHAN_TTL_DAYS = 14;

/** At most this many rings survive a startup prune, newest first. */
export const MAX_RINGS = 20;

/** A `.part` older than this is the debris of a crashed write. */
export const PART_TTL_MS = 60 * 60 * 1000;

/** What `meta.json` holds. Presentation and the anchor, nothing else. */
export type RingMeta = {
  v: 1;
  /** What the menu calls this project, e.g. `Film.ngt`. */
  label: string;
  /**
   * The `.ngt` this ring stands in for, or `null` for a project never saved.
   *
   * Path arithmetic, never an identity: recovery relinks against it and
   * leaves the recovered session detached. See `projectEntries.ts`.
   */
  anchor: string | null;
};

export type AutosaveEntry = {
  /** Absolute path of the `.ngt`. */
  file: string;
  /** Basename, as `parseEntryName` accepted it. */
  name: string;
  writtenAtMs: number;
};

export type AutosaveRing = {
  key: string;
  label: string;
  anchor: string | null;
  /** Newest first. Never empty — an empty ring is not listed. */
  entries: AutosaveEntry[];
};

/**
 * A key is one path segment of a restricted alphabet.
 *
 * Checked on the way in *and* again before any delete. The renderer supplies
 * keys, so this is the boundary that stops `..` or an absolute path reaching
 * `rm`. `path.basename(key) === key` is the same belt-and-braces check
 * `template.ts` makes before its recursive delete.
 */
const KEY = /^[fs]-[A-Za-z0-9_.-]{1,80}$/;

export function isValidAutosaveKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    KEY.test(key) &&
    key !== "." &&
    key !== ".." &&
    path.basename(key) === key
  );
}

/**
 * `YYYYMMDDTHHMMSS-mmmZ-<4 hex>.ngt`, in UTC.
 *
 * No colons: they are illegal in a Windows filename and Finder displays them
 * as `/`. The four hex characters break a collision between two app launches
 * writing in the same millisecond — `Date.now()` alone is what made the old
 * checkpoint table lose entries.
 */
const ENTRY = /^(\d{8})T(\d{6})-(\d{3})Z-[0-9a-f]{4}\.ngt$/;

export function entryName(atMs: number, salt?: string): string {
  const at = new Date(atMs);
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");

  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}` +
    `T${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}` +
    `-${pad(at.getUTCMilliseconds(), 3)}Z`;

  const tail = (salt ?? randomSalt()).toLowerCase();
  return `${stamp}-${tail}.ngt`;
}

function randomSalt(): string {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
}

/** The instant in an entry name, or `null` if it is not one of ours. */
export function parseEntryName(name: string): number | null {
  const match = ENTRY.exec(name);
  if (match == null) {
    return null;
  }
  const [, date, time, ms] = match;
  const at = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
    Number(ms),
  );
  return Number.isFinite(at) ? at : null;
}

function ringDir(root: string, key: string): string {
  return path.join(root, key);
}

/**
 * Write one recovery point, and prune the ring behind it.
 *
 * The rename is what makes this safe to interrupt: until it happens the new
 * entry is a `.part`, which `listRings` does not match and the startup prune
 * sweeps. A crash mid-write therefore costs the *new* entry and leaves every
 * older one intact — the opposite trade from overwriting in place.
 */
export async function writeEntry(
  root: string,
  key: string,
  bytes: Uint8Array,
  meta: RingMeta,
  atMs: number,
  keep: number = RING_SIZE,
): Promise<{ file: string; writtenAtMs: number }> {
  if (!isValidAutosaveKey(key)) {
    throw new Error(`Refusing to write an autosave under ${String(key)}`);
  }

  const dir = ringDir(root, key);
  // Lazily, in the write branch only — the `reverse.ts` arrangement. Nothing
  // creates the cache until something is about to go in it.
  await fsp.mkdir(dir, { recursive: true });

  const name = entryName(atMs);
  const file = path.join(dir, name);
  const part = `${file}.part`;

  try {
    await fsp.writeFile(part, bytes);
    await fsp.rename(part, file);
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw error;
  }

  // After the entry lands, so a failure to record the label cannot cost the
  // recovery point. `listRings` copes with a missing `meta.json`.
  await fsp
    .writeFile(path.join(dir, "meta.json"), JSON.stringify(meta))
    .catch(() => {});

  await pruneRing(dir, keep);

  return { file, writtenAtMs: parseEntryName(name) ?? atMs };
}

/** Entry basenames in a ring directory, newest first. */
async function entryNamesIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  // The name pattern is the filter, so nothing outside it is ever counted or
  // deleted — a `.part`, a `meta.json`, or anything a user dropped in here.
  return names
    .filter((name) => parseEntryName(name) != null)
    .sort()
    .reverse();
}

/** Keep the newest `keep` entries in one ring directory. */
export async function pruneRing(
  dir: string,
  keep: number = RING_SIZE,
): Promise<number> {
  const names = await entryNamesIn(dir);
  let dropped = 0;
  for (const name of names.slice(Math.max(keep, 0))) {
    try {
      await fsp.unlink(path.join(dir, name));
      dropped += 1;
    } catch {
      // A file that has already gone is the outcome we wanted.
    }
  }
  return dropped;
}

async function readMeta(dir: string): Promise<RingMeta | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
    if (raw == null || typeof raw !== "object") {
      return null;
    }
    const label = typeof raw.label === "string" ? raw.label : null;
    if (label == null) {
      return null;
    }
    return {
      v: 1,
      label,
      anchor: typeof raw.anchor === "string" ? raw.anchor : null,
    };
  } catch {
    return null;
  }
}

/**
 * Every ring that holds at least one recovery point, newest ring first.
 *
 * `[]` for a root that is not there, rather than a throw: this list builds the
 * File menu, and a menu that fails to build takes the whole menu bar with it.
 */
export async function listRings(root: string): Promise<AutosaveRing[]> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }

  const rings: AutosaveRing[] = [];

  for (const name of names) {
    // Dot-prefixed and `__MACOSX` skipped, the `scanTemplateRoot` rule. An
    // invalid key cannot be one of ours, so it is not ours to report either.
    if (name.startsWith(".") || name === "__MACOSX" || !isValidAutosaveKey(name)) {
      continue;
    }

    const dir = ringDir(root, name);
    try {
      if (!(await fsp.stat(dir)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const entryNames = await entryNamesIn(dir);
    // An empty ring is a bug rather than a state, and offering it would be a
    // menu row that recovers nothing.
    if (entryNames.length === 0) {
      continue;
    }

    const meta = await readMeta(dir);
    rings.push({
      key: name,
      // A ring whose label could not be read is still listed. Falling back to
      // the key is ugly in the menu and better than a hidden recovery point.
      label: meta?.label ?? name,
      anchor: meta?.anchor ?? null,
      entries: entryNames.map((entry) => ({
        file: path.join(dir, entry),
        name: entry,
        writtenAtMs: parseEntryName(entry) as number,
      })),
    });
  }

  // Newest ring first, by its newest entry.
  return rings.sort(
    (a, b) => b.entries[0].writtenAtMs - a.entries[0].writtenAtMs,
  );
}

/**
 * Drop one ring whole. What a successful save does.
 *
 * Three guards before anything is removed, because the key comes from the
 * renderer: the pattern, the single-segment check inside
 * `isValidAutosaveKey`, and `isInside` on the resolved path — the same
 * containment check `template.ts` makes before its recursive delete.
 */
export async function dropRing(root: string, key: string): Promise<boolean> {
  if (!isValidAutosaveKey(key)) {
    return false;
  }
  const dir = path.resolve(ringDir(root, key));
  if (!isInside(path.resolve(root), dir)) {
    return false;
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export type RootPruneOptions = {
  nowMs: number;
  ttlDays?: number;
  maxRings?: number;
  partTtlMs?: number;
};

/**
 * The startup sweep: aged-out rings, surplus rings, and crashed `.part` files.
 *
 * **A ring is never dropped because its `.ngt` has gone.** That is precisely
 * the case where the ring is the only copy — the user deleted the file, or the
 * volume is not mounted — so the file's absence is a reason to keep the ring,
 * not to collect it. It ages out on time like everything else.
 */
export async function pruneRoot(
  root: string,
  options: RootPruneOptions,
): Promise<{ droppedRings: string[]; droppedParts: number }> {
  const ttlDays = options.ttlDays ?? ORPHAN_TTL_DAYS;
  const maxRings = options.maxRings ?? MAX_RINGS;
  const partTtlMs = options.partTtlMs ?? PART_TTL_MS;

  const rings = await listRings(root);
  const droppedRings: string[] = [];

  const cutoff = options.nowMs - ttlDays * 24 * 60 * 60 * 1000;
  const survivors: AutosaveRing[] = [];

  for (const ring of rings) {
    if (ring.entries[0].writtenAtMs < cutoff) {
      if (await dropRing(root, ring.key)) {
        droppedRings.push(ring.key);
      }
      continue;
    }
    survivors.push(ring);
  }

  // `listRings` already sorted newest first, so the surplus is the tail.
  for (const ring of survivors.slice(Math.max(maxRings, 0))) {
    if (await dropRing(root, ring.key)) {
      droppedRings.push(ring.key);
    }
  }

  const droppedParts = await sweepParts(root, options.nowMs - partTtlMs);
  return { droppedRings, droppedParts };
}

/** Unlink `.part` debris older than `before`. */
async function sweepParts(root: string, before: number): Promise<number> {
  let keys: string[];
  try {
    keys = await fsp.readdir(root);
  } catch {
    return 0;
  }

  let dropped = 0;
  for (const key of keys) {
    if (!isValidAutosaveKey(key)) {
      continue;
    }
    const dir = ringDir(root, key);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".ngt.part")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < before) {
          await fsp.unlink(file);
          dropped += 1;
        }
      } catch {
        // Gone already, or unreadable. Either way, not ours to chase.
      }
    }
  }
  return dropped;
}

/** Whether anything is cached at all. Cheap, for gating a menu rebuild. */
export function rootExists(root: string): boolean {
  return fs.existsSync(root);
}
