/**
 * Reading and validating a clip's colour adjustments.
 *
 * The two-tempered split `blend.ts` and `lut.ts` use, for the same reasons:
 *
 *  - **`adjustOf` guards reads.** It runs in the paint loop, once per element
 *    per frame, and must never throw. A hand-edited `timeline.json`, a key a
 *    newer build wrote, a `"40"` where a number belongs — each answers
 *    something usable, and the frame draws. Unknown keys are dropped, values
 *    are clamped to their range, and zeros are dropped, so the result is always
 *    in the canonical sparse form.
 *  - **`coerceAdjustPatch` validates writes.** It runs once, where a value
 *    arrives from the panel or an agent, and *reports* what is wrong rather
 *    than repairing it, so a caller can be told.
 *
 * DOM-free and store-free.
 */

import {
  COLOR_ADJUSTMENT_KEYS,
  type ColorAdjustmentKey,
  type ColorAdjustments,
  type TimelineElement,
} from "../../@types/timeline";
import { ADJUSTMENTS } from "../adjust/spec";

const KNOWN = new Set<string>(COLOR_ADJUSTMENT_KEYS);

export function isAdjustmentKey(key: string): key is ColorAdjustmentKey {
  return KNOWN.has(key);
}

/** A value clamped to its slider's range. Non-finite becomes zero. */
export function clampAdjustment(key: ColorAdjustmentKey, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const { min, max } = ADJUSTMENTS[key];
  return value < min ? min : value > max ? max : value;
}

/**
 * Canonical sparse adjustments from anything: known keys only, clamped, zeros
 * dropped. Always a fresh object in `COLOR_ADJUSTMENT_KEYS` order, so two equal
 * settings stringify identically.
 */
export function normalizeAdjustments(value: unknown): ColorAdjustments {
  const out: ColorAdjustments = {};
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  const source = value as Record<string, unknown>;
  for (const key of COLOR_ADJUSTMENT_KEYS) {
    const v = clampAdjustment(key, source[key]);
    if (v !== 0) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * The adjustments on this element, or `null` when there are none that do
 * anything.
 *
 * `null` for "no field" and for "a field whose every value is zero or junk"
 * alike, because both render identically and both must keep the renderer's
 * fast path.
 */
export function adjustOf(
  element: TimelineElement | undefined | null,
): ColorAdjustments | null {
  const raw = (element as { adjust?: unknown } | undefined | null)?.adjust;
  if (raw == null) {
    return null;
  }
  const values = normalizeAdjustments(raw);
  return Object.keys(values).length === 0 ? null : values;
}

/** Whether a set of adjustments changes nothing. */
export function isAdjustNeutral(values: ColorAdjustments | null | undefined): boolean {
  if (values == null) {
    return true;
  }
  return COLOR_ADJUSTMENT_KEYS.every((key) => clampAdjustment(key, values[key]) === 0);
}

/** Two sets of adjustments that render identically. */
export function sameAdjustments(
  a: ColorAdjustments | null | undefined,
  b: ColorAdjustments | null | undefined,
): boolean {
  const x = normalizeAdjustments(a);
  const y = normalizeAdjustments(b);
  return COLOR_ADJUSTMENT_KEYS.every((key) => (x[key] ?? 0) === (y[key] ?? 0));
}

export type AdjustPatchResult =
  | { ok: true; patch: ColorAdjustments }
  | { ok: false; error: string };

/**
 * A caller-supplied patch, validated.
 *
 * A patch *keeps* its zeros — "set shadows to 0" is how a single slider is
 * reset, and it must survive to the op that merges it. Out-of-range values are
 * clamped rather than refused: the range is a property of the control, and a
 * slider dragged past its end means "as far as it goes". What is refused is a
 * key that names no control and a value that is not a number, because both are
 * mistakes a caller should hear about.
 */
export function coerceAdjustPatch(value: unknown): AdjustPatchResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Adjustments must be an object of slider values." };
  }
  const patch: ColorAdjustments = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isAdjustmentKey(key)) {
      return {
        ok: false,
        error: `Unknown adjustment "${key}". Known: ${COLOR_ADJUSTMENT_KEYS.join(", ")}.`,
      };
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Adjustment "${key}" must be a finite number.` };
    }
    patch[key] = clampAdjustment(key, v);
  }
  return { ok: true, patch };
}

/** Only the given keys, from already-normalized values. */
export function pickAdjustments(
  values: ColorAdjustments,
  keys: readonly ColorAdjustmentKey[],
): ColorAdjustments {
  const out: ColorAdjustments = {};
  for (const key of keys) {
    const v = values[key];
    if (v != null && v !== 0) {
      out[key] = v;
    }
  }
  return out;
}
