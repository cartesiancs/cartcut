/**
 * The renderer's three Auto Save calls.
 *
 * Deliberately narrow. A write hands over bytes and gets back the path main
 * chose; a drop takes keys that `isValidAutosaveKey` must accept; a list is
 * for the renderer's own sanity check and for the e2e suite. There is no
 * `read` — recovery already has the path from the menu payload and
 * `filesystem:readFile` exists — and no call that takes a path inside the
 * cache, which is what makes the delete guard total rather than careful.
 *
 * `start` never rejects: every handler answers a discriminated result, the
 * `ipcReverse` convention, so a failure the renderer must react to cannot
 * arrive as an unhandled rejection on a timer.
 */

import type { IpcMainInvokeEvent } from "electron";
import {
  autosaveRings,
  dropAutosaveRings,
  writeAutosave,
} from "../lib/autosave.js";
import { isValidAutosaveKey, type RingMeta } from "../lib/autosaveCache.js";

export type AutosaveWriteResult =
  | { ok: true; file: string; writtenAtMs: number }
  | { ok: false; error: string };

function meta(raw: unknown): RingMeta | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const { label, anchor } = raw as { label?: unknown; anchor?: unknown };
  if (typeof label !== "string" || label === "") {
    return null;
  }
  return {
    v: 1,
    label: label,
    anchor: typeof anchor === "string" && anchor !== "" ? anchor : null,
  };
}

export const ipcAutosave = {
  write: async (
    _event: IpcMainInvokeEvent,
    key: unknown,
    bytes: unknown,
    rawMeta: unknown,
  ): Promise<AutosaveWriteResult> => {
    if (!isValidAutosaveKey(key)) {
      return { ok: false, error: `Not an autosave key: ${String(key)}` };
    }

    // `Uint8Array` over the bridge arrives as one; anything else is a caller
    // bug rather than something to coerce.
    if (!(bytes instanceof Uint8Array)) {
      return { ok: false, error: "Autosave payload must be a Uint8Array." };
    }

    const parsed = meta(rawMeta);
    if (parsed == null) {
      return { ok: false, error: "Autosave metadata must name a label." };
    }

    try {
      const written = await writeAutosave(key, bytes, parsed);
      return { ok: true, file: written.file, writtenAtMs: written.writtenAtMs };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },

  dropRings: async (
    _event: IpcMainInvokeEvent,
    keys: unknown,
  ): Promise<{ ok: true; dropped: number } | { ok: false; error: string }> => {
    if (!Array.isArray(keys)) {
      return { ok: false, error: "Expected an array of autosave keys." };
    }
    try {
      // The invalid ones are dropped from the request rather than failing it:
      // a save retires two identities and one of them may not exist yet.
      const valid = keys.filter((key): key is string => isValidAutosaveKey(key));
      return { ok: true, dropped: await dropAutosaveRings(valid) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },

  list: async (_event: IpcMainInvokeEvent) => {
    return { ok: true as const, rings: autosaveRings() };
  },
};
