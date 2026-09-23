/**
 * An extension's settings: the schema it declared, and what the user chose.
 *
 * `resolveConfig` is pure and is where every rule lives, because the rules are
 * all about untrusted input meeting untrusted input: a schema written by an
 * extension author and a file the user may have hand edited. The read path
 * must never throw, the way `normalizeX` never throws, because it runs at
 * activation and a bad config file would otherwise stop the extension from
 * loading at all rather than stopping it from being configured.
 */

import * as fsp from "fs/promises";
import path from "path";

import { configFileFor } from "./dirs";

export type ConfigProperty = {
  type: "string" | "number" | "integer" | "boolean";
  default?: string | number | boolean;
  description?: string;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
};

export type ConfigSchema = Record<string, ConfigProperty>;
export type ConfigValues = Record<string, string | number | boolean>;

function fallbackFor(property: ConfigProperty): string | number | boolean {
  if (property.default !== undefined) {
    return property.default;
  }
  // A property with no declared default still needs a value, because an
  // extension reading it expects its declared type and `undefined` is the one
  // answer that would make `config.get("x") + 1` produce NaN silently.
  if (property.type === "boolean") {
    return false;
  }
  if (property.type === "string") {
    return property.enum != null && property.enum.length > 0 ? String(property.enum[0]) : "";
  }
  return property.minimum ?? 0;
}

function coerce(property: ConfigProperty, value: unknown): string | number | boolean | null {
  if (property.type === "boolean") {
    return typeof value === "boolean" ? value : null;
  }
  if (property.type === "string") {
    if (typeof value !== "string") {
      return null;
    }
    if (property.enum != null && !property.enum.map(String).includes(value)) {
      return null;
    }
    return value;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (property.type === "integer" && !Number.isInteger(value)) {
    return null;
  }
  if (property.minimum != null && value < property.minimum) {
    return null;
  }
  if (property.maximum != null && value > property.maximum) {
    return null;
  }
  if (property.enum != null && !property.enum.includes(value)) {
    return null;
  }
  return value;
}

/**
 * The effective settings: declared defaults, overridden by what survives.
 *
 * A stored value of the wrong type falls back to the default rather than being
 * converted. Converting would mean `"true"` becomes `true` and `""` becomes
 * `0`, and an extension whose setting silently changed meaning across a
 * version is a bug nobody can reproduce. A key the schema does not declare is
 * dropped, so removing a setting removes it rather than leaving a value the
 * panel cannot show and the user cannot clear.
 */
export function resolveConfig(schema: ConfigSchema, stored: unknown): ConfigValues {
  const values: ConfigValues = {};
  const source = stored != null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};

  for (const [key, property] of Object.entries(schema)) {
    const coerced = key in source ? coerce(property, source[key]) : null;
    values[key] = coerced === null ? fallbackFor(property) : coerced;
  }

  return values;
}

/** Whether a single write is allowed, and what it stores. */
export function coerceConfigValue(
  schema: ConfigSchema,
  key: string,
  value: unknown,
): { ok: true; value: string | number | boolean } | { ok: false; reason: string } {
  const property = schema[key];
  if (property == null) {
    return { ok: false, reason: "`" + key + "` is not a setting this extension declares" };
  }
  const coerced = coerce(property, value);
  if (coerced === null) {
    return { ok: false, reason: "`" + key + "` does not accept " + JSON.stringify(value) };
  }
  return { ok: true, value: coerced };
}

/** Reads the file, or answers `{}`. Never throws: it runs during activation. */
export async function readStoredConfig(id: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(configFileFor(id), "utf8")) as unknown;
  } catch {
    return {};
  }
}

export async function writeStoredConfig(id: string, values: ConfigValues): Promise<void> {
  const file = configFileFor(id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // `.part` then rename, the rule `autosaveCache.ts` states: there is no
  // instant in which the file exists and holds half a document, so a crash
  // during a write cannot cost the user every setting they had.
  const part = file + ".part";
  await fsp.writeFile(part, JSON.stringify(values, null, 2), "utf8");
  await fsp.rename(part, file);
}
