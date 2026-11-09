/**
 * Auto Save in a browser: the desktop's rings, kept in IndexedDB.
 *
 * The session (`autosaveSession.ts`) and its source (`autosaveBridge.ts`) are
 * the desktop's, unchanged: the same five-second debounce, the same ceiling,
 * the same back-off, the same archive bytes. Only the writer differs. On the
 * desktop main owns a folder of `.ngt` files (`electron/lib/autosaveCache.ts`);
 * here each ring is one IndexedDB record holding its newest recovery point,
 * the same one-point-per-project rule (`RING_SIZE = 1` there).
 *
 * An entry's `file` is `<ring key>/<written at>`, which is all recovery needs
 * to find the bytes again; it is never a path.
 */

import { AUTOSAVE, idbAll, idbDelete, idbGet, idbPut } from "./webStore";

export type BrowserRingEntry = { file: string; name: string; writtenAtMs: number };

export type BrowserRing = {
  key: string;
  label: string;
  anchor: string | null;
  entries: BrowserRingEntry[];
};

type StoredRing = BrowserRing & { bytes: Uint8Array };

/** The same shape `autosaveBridge.ts` asks of the preload bridge. */
export type BrowserAutosaveApi = {
  write(
    key: string,
    bytes: Uint8Array,
    meta: { label: string; anchor: string | null },
  ): Promise<{ ok: true; file: string; writtenAtMs: number } | { ok: false; error: string }>;
  dropRings(keys: string[]): Promise<void>;
  list(): Promise<BrowserRing[]>;
};

export function browserAutosaveApi(): BrowserAutosaveApi {
  return {
    async write(key, bytes, meta) {
      const writtenAtMs = Date.now();
      const file = `${key}/${writtenAtMs}`;
      const ring: StoredRing = {
        key,
        label: meta.label,
        anchor: meta.anchor,
        entries: [{ file, name: `${meta.label}.ngt`, writtenAtMs }],
        bytes,
      };
      // One write replaces the ring whole, so there is no moment with no
      // recovery point: the old one is the record until this one lands.
      const ok = await idbPut(AUTOSAVE, key, ring);
      return ok
        ? { ok: true, file, writtenAtMs }
        : { ok: false, error: "the browser refused to store the recovery point" };
    },
    async dropRings(keys) {
      for (const key of keys) {
        await idbDelete(AUTOSAVE, key);
      }
    },
    async list() {
      const rings = await idbAll<StoredRing>(AUTOSAVE);
      return rings
        .filter((ring) => ring != null && typeof ring.key === "string" && Array.isArray(ring.entries))
        .map(({ key, label, anchor, entries }) => ({ key, label, anchor, entries }));
    },
  };
}

/** The archive bytes behind an entry's `file`, or `null`. */
export async function readBrowserAutosave(file: string): Promise<Uint8Array | null> {
  const slash = file.lastIndexOf("/");
  if (slash <= 0) {
    return null;
  }
  const ring = await idbGet<StoredRing>(AUTOSAVE, file.slice(0, slash));
  if (ring == null || !ring.entries.some((entry) => entry.file === file)) {
    return null;
  }
  return ring.bytes;
}

/**
 * Ask before the tab closes on unsaved work, the browser's form of the
 * desktop's quit guard (`event.ts`, `forceClose`). The browser words the
 * question itself; a page can only ask that it be asked.
 */
export function installUnloadGuard(isDirty: () => boolean): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty()) {
      return;
    }
    event.preventDefault();
    // Older Chrome and Safari ask only when this is set.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}
