/**
 * Animation presets contributed by an extension.
 *
 * `PresetName` is a closed union of nineteen moves and stays one. That is not
 * an obstacle to work around: it is what makes a missing entry in `LABELS` or
 * `GROUPS` a compile error, and what lets the MCP tool advertise a fixed list
 * that `tools.test.ts` pins. An extension's preset cannot be a member of it.
 *
 * So it is not made one. A contributed preset is a `PresetShape` under a
 * namespaced id, and `applyPresetShape` runs it through exactly the same code
 * the built-in table runs through: the same every-property-or-none check, the
 * same clamp to the clip, the same anchor rule, the same focus counter-move.
 * There is no second implementation of what a preset means.
 *
 * Validation is the renderer's job, as it is for FX presets, and for the same
 * reason: main stays incurious about a format it would otherwise have to keep
 * a second copy of. Nothing here executes anything. A preset is stops and
 * numbers, and a file that is not that is refused with a reason.
 */

import { easingNames, type EasingName } from "../animation/easing";
import { forgetPreviewSamples } from "../animation/presetPreview";
import type { Move, PresetShape, Stop } from "../animation/presets";

/** Bumped only when the file format changes in a way an older app cannot read. */
export const ANIMATION_PRESET_SCHEMA = 1;

/** `ext:<extId>:<name>`, which is how one is named everywhere outside this file. */
export const EXT_PRESET_PREFIX = "ext:";

/** A name inside one extension. Kept to the same shape as a command id. */
export const PRESET_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

/**
 * Most stops one curve may have.
 *
 * A move is a handful of stops; this is not a limit any real preset meets. It
 * is a cap so a hand-edited file cannot ask the baker to write a hundred
 * thousand keyframes on one property, which it would do without complaint.
 */
export const MAX_STOPS = 64;

/** Longest a contributed preset may run. An hour is not a move. */
export const MAX_DEFAULT_MS = 600_000;

export type ExtensionAnimationPreset = {
  /** `ext:<extId>:<name>`. */
  id: string;
  extId: string;
  name: string;
  label: string;
  shape: PresetShape;
};

export type PresetValidation =
  | { ok: true; preset: ExtensionAnimationPreset }
  | { ok: false; errors: string[] };

const EASINGS = new Set<string>(easingNames());

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStops(
  raw: unknown,
  property: string,
  errors: string[],
): Stop[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    errors.push(property + ": needs at least two stops");
    return undefined;
  }
  if (raw.length > MAX_STOPS) {
    errors.push(property + ": has " + raw.length + " stops, over the " + MAX_STOPS + " cap");
    return undefined;
  }

  const stops: Stop[] = [];
  let previousAt = -1;

  for (const [index, entry] of raw.entries()) {
    const at = (entry as { at?: unknown })?.at;
    const value = (entry as { value?: unknown })?.value;
    const easing = (entry as { easing?: unknown })?.easing;
    const where = property + "[" + index + "]";

    if (!isFinitePositive(at) || at < 0 || at > 1) {
      errors.push(where + ".at: must be a fraction of the preset's duration, 0 to 1");
      continue;
    }
    // Ascending, so the stops describe a curve rather than a set. `writeTrack`
    // would accept them in any order and produce a track that doubles back on
    // itself, which is a move nobody meant to write.
    if (at <= previousAt) {
      errors.push(where + ".at: must come after the stop before it");
      continue;
    }
    previousAt = at;

    if (!isFinitePositive(value)) {
      errors.push(where + ".value: must be a number");
      continue;
    }
    if (easing !== undefined && !EASINGS.has(String(easing))) {
      errors.push(where + ".easing: `" + String(easing) + "` is not a curve this app has");
      continue;
    }

    stops.push({ at, value, ...(easing === undefined ? {} : { easing: easing as EasingName }) });
  }

  return stops.length === raw.length ? stops : undefined;
}

function readMoves(raw: unknown, errors: string[]): Move[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    errors.push("position: needs at least two stops");
    return undefined;
  }
  if (raw.length > MAX_STOPS) {
    errors.push("position: has " + raw.length + " stops, over the " + MAX_STOPS + " cap");
    return undefined;
  }

  const moves: Move[] = [];
  let previousAt = -1;

  for (const [index, entry] of raw.entries()) {
    const at = (entry as { at?: unknown })?.at;
    const x = (entry as { x?: unknown })?.x;
    const y = (entry as { y?: unknown })?.y;
    const easing = (entry as { easing?: unknown })?.easing;
    const where = "position[" + index + "]";

    if (!isFinitePositive(at) || at < 0 || at > 1) {
      errors.push(where + ".at: must be a fraction of the preset's duration, 0 to 1");
      continue;
    }
    if (at <= previousAt) {
      errors.push(where + ".at: must come after the stop before it");
      continue;
    }
    previousAt = at;

    if (!isFinitePositive(x) || !isFinitePositive(y)) {
      errors.push(where + ": needs numeric `x` and `y`");
      continue;
    }
    if (easing !== undefined && !EASINGS.has(String(easing))) {
      errors.push(where + ".easing: `" + String(easing) + "` is not a curve this app has");
      continue;
    }

    moves.push({ at, x, y, ...(easing === undefined ? {} : { easing: easing as EasingName }) });
  }

  return moves.length === raw.length ? moves : undefined;
}

/**
 * Turn one file into a preset, or say why not.
 *
 * Never throws and never partially accepts. A preset with one bad stop is
 * refused whole, because half a move written onto a clip is worse than no move
 * at all: the user would have to find and undo something they did not ask for.
 */
export function validateAnimationPreset(
  extId: string,
  fileName: string,
  json: unknown,
): PresetValidation {
  const errors: string[] = [];

  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, errors: [fileName + ": is not a JSON object"] };
  }
  const source = json as Record<string, unknown>;

  if (source.schema !== ANIMATION_PRESET_SCHEMA) {
    errors.push(
      "schema: this app reads version " +
        ANIMATION_PRESET_SCHEMA +
        ", the file says " +
        String(source.schema),
    );
  }

  const name = typeof source.name === "string" ? source.name : "";
  if (!PRESET_NAME_PATTERN.test(name)) {
    errors.push("name: `" + name + "` is not a usable preset name");
  }

  const defaultMs = source.defaultMs;
  if (!isFinitePositive(defaultMs) || defaultMs < 1 || defaultMs > MAX_DEFAULT_MS) {
    errors.push("defaultMs: must be between 1 and " + MAX_DEFAULT_MS);
  }

  if (source.positionUnit !== undefined && source.positionUnit !== "px" && source.positionUnit !== "box") {
    errors.push('positionUnit: must be "px" or "box"');
  }

  const scale = readStops(source.scale, "scale", errors);
  const opacity = readStops(source.opacity, "opacity", errors);
  const rotation = readStops(source.rotation, "rotation", errors);
  const position = readMoves(source.position, errors);

  if (scale == null && opacity == null && rotation == null && position == null) {
    errors.push("a preset has to drive at least one of scale, opacity, rotation or position");
  }

  // Focus works by counter-animating position, so a preset that already moves
  // the clip has nowhere to put it. The built-in table states the same rule;
  // here it is checked rather than trusted.
  const focusable = source.focusable === true;
  if (focusable && (position != null || scale == null)) {
    errors.push("focusable: only a preset that changes scale and nothing positional can be focusable");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const shape: PresetShape = {
    defaultMs: defaultMs as number,
    ...(source.fromEnd === true ? { fromEnd: true as const } : {}),
    ...(source.positionUnit === "box" ? { positionUnit: "box" as const } : {}),
    ...(focusable ? { focusable: true as const } : {}),
    ...(scale == null ? {} : { scale }),
    ...(opacity == null ? {} : { opacity }),
    ...(rotation == null ? {} : { rotation }),
    ...(position == null ? {} : { position }),
  };

  return {
    ok: true,
    preset: {
      id: EXT_PRESET_PREFIX + extId + ":" + name,
      extId,
      name,
      label: typeof source.label === "string" && source.label.trim() !== "" ? source.label.trim() : name,
      shape,
    },
  };
}

/** Whether a preset name names a contributed one rather than a built-in. */
export function isExtensionPresetId(value: string): boolean {
  return value.startsWith(EXT_PRESET_PREFIX);
}

// --------------------------------------------------------------- registry

/**
 * Keyed by the namespaced id, so two extensions naming a move `wobble` are two
 * presets rather than a collision.
 *
 * A module-level map and a listener set, the shape `presetRegistry.ts` uses and
 * for the same reasons: the set only changes when an extension loads or
 * unloads, and a panel that re-read it on every render would stall.
 */
const presets = new Map<string, ExtensionAnimationPreset>();
const listeners = new Set<() => void>();

export function subscribeAnimationPresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Replace everything one extension contributes. Returns what was refused. */
export function setAnimationPresetsOf(
  extId: string,
  files: ReadonlyArray<{ fileName: string; json: unknown }>,
): Array<{ fileName: string; errors: string[] }> {
  const failures: Array<{ fileName: string; errors: string[] }> = [];
  let changed = false;

  for (const [id, preset] of presets) {
    if (preset.extId === extId) {
      presets.delete(id);
      // The thumbnail is cached by this id, and reloading an extension keeps
      // the id while changing the move. Without this a developer editing a
      // preset sees the previous one until they restart the app.
      forgetPreviewSamples(id);
      changed = true;
    }
  }

  for (const file of files) {
    const result = validateAnimationPreset(extId, file.fileName, file.json);
    if (!result.ok) {
      // Reported rather than thrown. One bad file in an extension must not cost
      // the user that extension's other presets, which is the promise
      // `presetRegistry.ts` already makes about a bad preset folder.
      failures.push({ fileName: file.fileName, errors: result.errors });
      continue;
    }
    presets.set(result.preset.id, result.preset);
    changed = true;
  }

  if (changed) {
    notify();
  }
  return failures;
}

export function removeAnimationPresetsOf(extId: string): void {
  let changed = false;
  for (const [id, preset] of presets) {
    if (preset.extId === extId) {
      presets.delete(id);
      forgetPreviewSamples(id);
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
}

export function animationPresetById(id: string): ExtensionAnimationPreset | null {
  return presets.get(id) ?? null;
}

/** Everything contributed, sorted by label so a list does not shuffle. */
export function animationPresets(): ExtensionAnimationPreset[] {
  return [...presets.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * Test-only: start from nothing so one suite cannot see another's presets.
 *
 * Evicts the thumbnails too, for the reason the real paths do: the cache is
 * keyed by preset id and outlives the registry, so clearing only the map
 * leaves one suite's samples answering the next suite's question about the
 * same id.
 */
export function __clearAnimationPresetsForTesting(): void {
  for (const id of presets.keys()) {
    forgetPreviewSamples(id);
  }
  presets.clear();
}
