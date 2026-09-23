/**
 * The sixth entry in a `.ngt`, where extensions keep per-project data.
 *
 * `features/project/projectEntries.ts` already states the rule this relies on:
 * an added entry must never move `SCHEMA_VERSION`. The archive reader asks for
 * five entries by name and ignores anything else, so a project written by this
 * build opens in a build without it, minus whatever the extension stored. That
 * is the right failure: the extension is not installed there either.
 *
 * Parsing fails closed, the way `normalizeX` guards every read. A hand-edited
 * or truncated entry costs the extension its stored data and costs the user
 * nothing, where a throw would make the project refuse to open.
 */

import type { JsonValue } from "../../@types/timeline";

export const EXTENSIONS_ENTRY = "extensions.json";

/** Bumped only if the envelope changes. The payload is each extension's own. */
export const EXTENSIONS_ENTRY_VERSION = 1;

export type ProjectExtensionData = Record<string, JsonValue>;

/**
 * Never larger than this in total.
 *
 * The entry is rewritten on every save and hashed on every edit, so an
 * extension that dumps a transcript in here is paid for at edit rate by
 * everyone who opens the project.
 */
export const MAX_PROJECT_DATA_BYTES = 1024 * 1024;

export function parseExtensionsEntry(text: string | null | undefined): ProjectExtensionData {
  if (typeof text !== "string" || text.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const envelope = parsed as { v?: unknown; data?: unknown };
    if (envelope.v !== EXTENSIONS_ENTRY_VERSION) {
      return {};
    }
    const data = envelope.data;
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }
    return data as ProjectExtensionData;
  } catch {
    return {};
  }
}

/**
 * The entry's text, or `null` when there is nothing to write.
 *
 * `null` rather than `"{}"` is the load-bearing half: an empty object would
 * still be a zip entry, and a project nobody ran an extension on would stop
 * being byte-identical to one saved before this existed.
 */
export function serializeExtensionsEntry(data: ProjectExtensionData): string | null {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return null;
  }
  // Sorted, so the same data produces the same bytes. `projectDigest.ts`
  // hashes this text to decide whether the project is dirty, and key order
  // that followed insertion would make an unchanged project look edited.
  const ordered: ProjectExtensionData = {};
  for (const key of keys.sort()) {
    ordered[key] = data[key];
  }
  return JSON.stringify({ v: EXTENSIONS_ENTRY_VERSION, data: ordered });
}

export function withProjectData(
  data: ProjectExtensionData,
  extId: string,
  value: JsonValue | null,
): { ok: true; data: ProjectExtensionData } | { ok: false; reason: string } {
  const had = Object.prototype.hasOwnProperty.call(data, extId);

  if (value === null) {
    if (!had) {
      return { ok: true, data };
    }
    const next = { ...data };
    delete next[extId];
    return { ok: true, data: next };
  }

  let size = 0;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return { ok: false, reason: "that value cannot be stored in a project file" };
  }
  if (size > MAX_PROJECT_DATA_BYTES) {
    return {
      ok: false,
      reason: "that value is " + size + " bytes, over the " + MAX_PROJECT_DATA_BYTES + " byte cap",
    };
  }

  if (had && JSON.stringify(data[extId]) === JSON.stringify(value)) {
    return { ok: true, data };
  }
  return { ok: true, data: { ...data, [extId]: value } };
}
