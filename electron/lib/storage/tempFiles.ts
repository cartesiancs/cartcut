/**
 * Temporary files, counted and removed. Plain `fs`, no Electron.
 *
 * A sweep is a folder main chose and a test on the names in it; nothing here
 * takes a path from the renderer. `storageSession.ts` names the folders.
 *
 * Two guards keep a job that is still running from losing its files. A sweep
 * can set `minAgeMs`, measured from the newest write anywhere under an entry,
 * so a transcode or a download that is still writing always looks fresh. And
 * `keep` names entries to leave whatever their age: a recording paused for an
 * hour writes nothing and is still in use.
 */

import * as fsp from "fs/promises";
import type { Stats } from "fs";
import path from "path";

export type Sweep = {
  /** A folder main chose. A missing one sweeps nothing. */
  root: string;
  /** Whether an entry is temporary, by its name alone. */
  match: (name: string) => boolean;
  /** Look for matches in subfolders too. A matching folder still goes whole. */
  recursive?: boolean;
  /** Leave an entry written to more recently than this. */
  minAgeMs?: number;
};

export type SweepOptions = {
  nowMs: number;
  /** Entries to leave, by absolute path. */
  keep?: Iterable<string>;
};

type Found = { path: string; bytes: number };

async function entriesOf(dir: string) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // Not created yet, which is the usual state of most of these folders.
    return [];
  }
}

/**
 * Bytes under an entry and the time of its newest write. Links are not
 * followed, so nothing outside is counted, and a link's own time is its age.
 */
async function measure(full: string, stat: Stats): Promise<{ bytes: number; newestMs: number }> {
  if (!stat.isDirectory()) {
    return { bytes: stat.isFile() ? stat.size : 0, newestMs: stat.mtimeMs };
  }
  let bytes = 0;
  let newestMs = stat.mtimeMs;
  for (const entry of await entriesOf(full)) {
    const child = path.join(full, entry.name);
    const childStat = await fsp.lstat(child).catch(() => null);
    if (childStat == null) {
      continue;
    }
    const measured = await measure(child, childStat);
    bytes += measured.bytes;
    newestMs = Math.max(newestMs, measured.newestMs);
  }
  return { bytes, newestMs };
}

async function collect(
  dir: string,
  sweep: Sweep,
  options: SweepOptions,
  keep: ReadonlySet<string>,
  found: Map<string, Found>,
): Promise<void> {
  for (const entry of await entriesOf(dir)) {
    const full = path.join(dir, entry.name);
    if (keep.has(path.resolve(full))) {
      continue;
    }
    const stat = await fsp.lstat(full).catch(() => null);
    if (stat == null) {
      continue;
    }
    if (sweep.match(entry.name)) {
      const { bytes, newestMs } = await measure(full, stat);
      if (sweep.minAgeMs != null && options.nowMs - newestMs < sweep.minAgeMs) {
        continue;
      }
      found.set(path.resolve(full), { path: full, bytes });
    } else if (sweep.recursive === true && stat.isDirectory()) {
      await collect(full, sweep, options, keep, found);
    }
  }
}

/** What every sweep would remove, each entry once even where two sweeps overlap. */
async function findAll(sweeps: readonly Sweep[], options: SweepOptions): Promise<Found[]> {
  const keep = new Set(Array.from(options.keep ?? [], (entry) => path.resolve(entry)));
  const found = new Map<string, Found>();
  for (const sweep of sweeps) {
    await collect(sweep.root, sweep, options, keep, found);
  }
  return [...found.values()];
}

/** The size of what `removeSweeps` would remove at the same instant. */
export async function summarizeSweeps(
  sweeps: readonly Sweep[],
  options: SweepOptions,
): Promise<{ bytes: number }> {
  let bytes = 0;
  for (const entry of await findAll(sweeps, options)) {
    bytes += entry.bytes;
  }
  return { bytes };
}

/**
 * Remove every matching entry. One at a time, so an entry that cannot go (a
 * file Windows holds open) is counted as failed and the rest still go.
 */
export async function removeSweeps(
  sweeps: readonly Sweep[],
  options: SweepOptions,
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const entry of await findAll(sweeps, options)) {
    try {
      await fsp.rm(entry.path, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
