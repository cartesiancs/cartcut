/**
 * Where the Auto Save cache lives, and the list the File menu draws from.
 *
 * The thin Electron half. `autosaveCache.ts` holds everything with logic in it
 * and takes `root` as a parameter, so it is tested against a real filesystem;
 * this knows `userData` and owns the cached ring list. The
 * `reverse.ts`/`reversePipeline.ts` split.
 *
 * **Main owns the directory, and the renderer never names a path inside it.**
 * `app.getPath("userData")` is not reachable from the renderer anyway, but the
 * stronger reason is the delete: a write hands over bytes and main mints the
 * filename, and a drop takes a *key* that `isValidAutosaveKey` has to accept.
 * There is no call shape in which the renderer can ask for an arbitrary path
 * to be removed.
 *
 * The list is cached because Electron builds a submenu synchronously — there is
 * no `menu-will-show` hook that can await a read — so the menu is rebuilt when
 * the cache changes rather than populated when it is opened. Every mutation
 * here goes through `refresh`, which is also the only thing that calls back
 * into the menu.
 */

import path from "path";
import { app } from "electron";
import {
  RING_SIZE,
  dropRing,
  listRings,
  pruneRoot,
  writeEntry,
  type AutosaveRing,
  type RingMeta,
} from "./autosaveCache";
import { shouldRebuild, signatureOf } from "./autosaveMenu";

export function autosaveRoot(): string {
  return path.join(app.getPath("userData"), "autosave");
}

/** The last list read from disk. The menu draws this, never the disk. */
let rings: AutosaveRing[] = [];

/** The model the installed menu was built from. */
let installed: AutosaveRing[] = [];

/** Rebuilds the application menu. Set by `main.ts` to avoid a cycle. */
let rebuild: (() => void) | null = null;

/**
 * Whether a menu is open right now.
 *
 * `Menu.setApplicationMenu` closes an open menu on macOS, so an autosave
 * landing while someone reads the File menu would snap it shut under them. The
 * rebuild is held and flushed on close instead.
 */
let menuOpen = false;
let rebuildPending = false;

export function autosaveRings(): AutosaveRing[] {
  return rings;
}

/** Called by `main.ts` with something that reinstalls the menu. */
export function onAutosaveChange(handler: () => void): void {
  rebuild = handler;
}

/** Told by `main.ts` from the `menu-will-show` / `menu-will-close` events. */
export function setMenuOpen(open: boolean): void {
  menuOpen = open;
  if (!open && rebuildPending) {
    rebuildPending = false;
    applyRebuild();
  }
}

function applyRebuild(): void {
  installed = rings;
  rebuild?.();
}

async function refresh(): Promise<void> {
  rings = await listRings(autosaveRoot());

  if (shouldRebuild(installed, rings, menuOpen)) {
    applyRebuild();
    return;
  }

  // Declined. If it was declined *only* because a menu is open, the rebuild
  // has to be remembered rather than dropped, or the new recovery point would
  // not appear until the next write.
  if (menuOpen && signatureOf(installed) !== signatureOf(rings)) {
    rebuildPending = true;
  }
}

/**
 * Read the cache and sweep it, once, at startup.
 *
 * The sweep is here rather than on a timer because the things it collects are
 * all consequences of a previous run: a ring nobody came back for, a `.part`
 * from a crashed write. Nothing accumulates within a session that the
 * per-write ring prune does not already handle.
 */
export async function initAutosave(): Promise<void> {
  try {
    const swept = await pruneRoot(autosaveRoot(), { nowMs: Date.now() });
    if (swept.droppedRings.length > 0 || swept.droppedParts > 0) {
      console.log(
        `[autosave] swept ${swept.droppedRings.length} ring(s) and ` +
          `${swept.droppedParts} partial write(s)`,
      );
    }
  } catch (error) {
    // A cache that cannot be swept is still a cache worth reading.
    console.warn("[autosave] could not sweep the cache", error);
  }
  await refresh();
}

export async function writeAutosave(
  key: string,
  bytes: Uint8Array,
  meta: RingMeta,
): Promise<{ file: string; writtenAtMs: number }> {
  const written = await writeEntry(
    autosaveRoot(),
    key,
    bytes,
    meta,
    Date.now(),
    RING_SIZE,
  );
  await refresh();
  return written;
}

/**
 * Drop rings whole. What a successful save does.
 *
 * Takes several keys because one save can retire two identities: saving an
 * untitled project as `Film.ngt` supersedes both the session's own ring and
 * any ring already sitting at `Film.ngt` from an earlier crash.
 */
export async function dropAutosaveRings(keys: string[]): Promise<number> {
  const root = autosaveRoot();
  let dropped = 0;
  for (const key of keys) {
    if (await dropRing(root, key)) {
      dropped += 1;
    }
  }
  await refresh();
  return dropped;
}
