/**
 * Reading and validating a clip's LUT reference.
 *
 * The same two-tempered split `blend.ts` uses, for the same reasons:
 *
 *  - **`lutOf` guards reads.** It runs inside the paint loop, once per element
 *    per frame, and must never throw. A hand-edited `timeline.json`, a field a
 *    newer build wrote, an `intensity` of `"80"` — all of them answer something
 *    usable, or `null`, and the frame draws.
 *  - **`coerceLutRef` validates writes.** It runs once, where a value arrives
 *    from the panel or from an agent, and returns `null` for anything it does
 *    not recognise so the caller can report it.
 *
 * One deliberate asymmetry with `blendOf`: this does **not** check that the
 * preset is installed. It cannot — that would mean importing the registry,
 * which reads the disk, into a module the node suites load. The missing-preset
 * case is handled where the LUT is resolved (`renderer/lut/apply.ts`), and it
 * degrades to drawing the clip ungraded, which is the same contract
 * `planFrame.ts` gives a missing effect preset.
 *
 * DOM-free and store-free, so it runs under `environment: "node"` alongside the
 * pure ops that import it.
 */

import type { LutRef, TimelineElement } from "../../@types/timeline";

/** Full strength. What a freshly applied LUT gets. */
export const DEFAULT_LUT_INTENSITY = 100;

/**
 * The grade on this element, or `null`.
 *
 * `intensity` comes back clamped to 0-100 and finite, because it is multiplied
 * into a mix in the shader and a `NaN` there blackens the clip rather than
 * failing visibly.
 */
export function lutOf(element: TimelineElement | undefined | null): LutRef | null {
  const lut = (element as { lut?: unknown } | undefined | null)?.lut;
  if (lut == null || typeof lut !== "object") {
    return null;
  }
  const { presetId, intensity } = lut as { presetId?: unknown; intensity?: unknown };
  if (typeof presetId !== "string" || presetId === "") {
    return null;
  }
  return { presetId, intensity: clampIntensity(intensity) };
}

/**
 * Whether this grade changes anything.
 *
 * An intensity of zero is a *stored* A/B — the user has dialled the grade off
 * to compare, and the LUT must stay on the clip — but it is also a frame the
 * renderer can draw down the untouched fast path. Both are true at once, which
 * is why this is a separate question from "is there a LUT".
 */
export function isLutActive(lut: LutRef | null): boolean {
  return lut != null && lut.intensity > 0;
}

/**
 * A caller-supplied value as a `LutRef`, or `null` if it is not one.
 *
 * Unlike `lutOf` this refuses a missing or malformed `intensity` outright
 * rather than defaulting it — a write is a place where a caller can be told it
 * got something wrong, and silently substituting 100 for a mistyped number
 * would hide the mistake until someone noticed the grade was too strong.
 */
export function coerceLutRef(value: unknown): LutRef | null {
  if (value == null || typeof value !== "object") {
    return null;
  }
  const { presetId, intensity } = value as {
    presetId?: unknown;
    intensity?: unknown;
  };
  if (typeof presetId !== "string" || presetId.trim() === "") {
    return null;
  }
  if (
    intensity !== undefined &&
    (typeof intensity !== "number" || !Number.isFinite(intensity))
  ) {
    return null;
  }
  return {
    presetId,
    intensity:
      intensity === undefined
        ? DEFAULT_LUT_INTENSITY
        : clampIntensity(intensity),
  };
}

/** 0-100, finite. Anything else becomes full strength. */
export function clampIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LUT_INTENSITY;
  }
  return value < 0 ? 0 : value > 100 ? 100 : value;
}
