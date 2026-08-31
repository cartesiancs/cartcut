/**
 * Reading and validating a clip's blend mode.
 *
 * Two functions with deliberately different tempers, the same split the frame
 * rate uses between `normalizeFps` and `coerceFps`:
 *
 *  - **`blendOf` guards reads.** It runs inside the paint loop, once per element
 *    per frame, and must never throw. A project written by a newer build, a
 *    hand-edited `timeline.json`, a field someone set to `null` — all of them
 *    answer `"source-over"` and the frame draws.
 *  - **`coerceBlend` validates writes.** It runs once, at the boundary where a
 *    value arrives from the panel or from an agent, and returns `null` for
 *    anything it does not recognise so the caller can report it. Past this
 *    point an unusable mode is unrepresentable.
 *
 * DOM-free and store-free, so it runs under `environment: "node"` alongside the
 * pure ops that import it.
 */

import { BLEND_MODES, type BlendMode, type TimelineElement } from "../../@types/timeline";

/**
 * Plain stacking — what every clip did before this feature existed, and what an
 * absent field means.
 *
 * Note that this is also the value that *deletes* the field: see
 * `features/timeline/blendOps.ts#setClipBlend`.
 */
export const DEFAULT_BLEND: BlendMode = "source-over";

/** `O(1)` membership, built once. `BLEND_MODES.includes` is a scan per frame. */
const KNOWN = new Set<string>(BLEND_MODES);

/**
 * The blend mode this element is composited with.
 *
 * Never throws, and never returns anything outside `BLEND_MODES` — which is the
 * whole point, because the result is assigned straight to
 * `globalCompositeOperation`. An unknown string there is not an error in any
 * engine: it is silently ignored, so the clip would keep drawing normally and
 * nothing would say why.
 */
export function blendOf(element: TimelineElement | undefined | null): BlendMode {
  const blend = (element as { blend?: unknown } | undefined | null)?.blend;
  return typeof blend === "string" && KNOWN.has(blend)
    ? (blend as BlendMode)
    : DEFAULT_BLEND;
}

/**
 * Whether this mode needs the clip drawn in isolation before it is composited.
 *
 * Only `"source-over"` does not: it is associative over the sub-draws a renderer
 * makes, so a text clip's background box, glow, shadow, outline and fill can go
 * straight onto the frame in order and land correctly. Every other mode is not,
 * which is why anything else pays for a layer — see `renderer/element.ts`.
 */
export function isBlendIsolating(blend: BlendMode): boolean {
  return blend !== DEFAULT_BLEND;
}

/**
 * A caller-supplied value as a `BlendMode`, or `null` if it is not one.
 *
 * Exact match only — no trimming, no case folding. A mode arrives either from a
 * `<select>` built out of `BLEND_MODES` or from a tool whose schema enumerates
 * them, so a near-miss is a bug somewhere upstream and should be reported
 * rather than guessed at.
 */
export function coerceBlend(value: unknown): BlendMode | null {
  return typeof value === "string" && KNOWN.has(value)
    ? (value as BlendMode)
    : null;
}
