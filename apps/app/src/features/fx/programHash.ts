/**
 * The identity of an inline program: its canonical text and the digest of it.
 *
 * Its own module, with one import, because two sides need it and they import
 * each other otherwise: `inlineProgram.ts` mints the hash when a program is
 * written, and `presetValidate.ts` recomputes it to check that an `inline.` id
 * names the content it sits next to.
 *
 * Canonical means key order never matters. A program built by an agent with
 * `{ name, kind }` and one read back out of a `.ngt` as `{ kind, name }` are
 * one program, share one id and therefore one compiled shader.
 */

import { INLINE_PRESET_PREFIX } from "../../@types/timeline";
import { digest64 } from "../project/projectDigest";

/**
 * `JSON.stringify` with every object's keys sorted, and `undefined` dropped the
 * way `JSON.stringify` drops it from an object. Arrays keep their order: a
 * pass list and a parameter list are ordered by meaning.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    // `undefined`, a function or a symbol at the top level. Never reached from
    // a program, which is plain data, but `JSON.stringify` answers `undefined`
    // there and a string is promised.
    return out === undefined ? "null" : out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item ?? null)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) {
      continue;
    }
    parts.push(JSON.stringify(key) + ":" + stableStringify(item));
  }
  return "{" + parts.join(",") + "}";
}

/** The three parts that make a program what it is. `hash` and `id` are derived and excluded. */
export type ProgramContent = {
  manifest: Record<string, unknown>;
  sources: Record<string, string>;
  assets?: Record<string, string>;
};

/**
 * The text a program is hashed from, and compared by.
 *
 * An empty `assets` and an absent one are the same program: the stored form
 * deletes the key when it is empty, and the comparison must not depend on
 * which side did.
 */
export function canonicalProgramText(content: ProgramContent): string {
  const { id: _id, ...manifest } = content.manifest as Record<string, unknown>;
  const assets =
    content.assets != null && Object.keys(content.assets).length > 0
      ? content.assets
      : undefined;
  return stableStringify({ manifest, sources: content.sources, assets });
}

export function hashProgram(content: ProgramContent): string {
  return digest64(canonicalProgramText(content));
}

export function inlinePresetId(hash: string): string {
  return INLINE_PRESET_PREFIX + hash;
}
