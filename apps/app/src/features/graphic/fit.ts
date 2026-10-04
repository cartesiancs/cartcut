/**
 * `data-fit`: the largest scale at which an element's text still fits its box.
 *
 * The search is here and the measuring is the host's, so the rule (largest
 * fitting value, never past the author's ceiling, the floor when nothing fits)
 * is checked under `environment: "node"` against a fake `fits`. The host sets
 * the answer as `--fit` on the element, and the author's CSS multiplies a size
 * by it: `font-size: calc(var(--size) * var(--fit, 1) * 1px)`.
 */

export type FitMode = "width" | "box";

export const FIT_FLOOR = 0.05;
export const FIT_CEILING = 8;
const STEPS = 14;

/** The attribute's mode, or `null` for a value that names none. */
export function fitModeOf(value: string | null): FitMode | null {
  if (value === "" || value === "width") {
    return "width";
  }
  return value === "box" ? "box" : null;
}

/** `data-fit-max`: how far the text may grow, 1 (shrink only) by default. */
export function fitMaxOf(value: string | null): number {
  const parsed = value == null ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.min(FIT_CEILING, Math.max(FIT_FLOOR, parsed));
}

/**
 * Binary search for the largest scale in `[FIT_FLOOR, max]` where `fits` holds,
 * assuming it holds for every smaller scale too. Returns `max` when that fits
 * and the floor when nothing does, so a title too long for its box is drawn as
 * small as allowed rather than not at all.
 */
export function fitScale(fits: (scale: number) => boolean, max = 1): number {
  const ceiling = Math.min(FIT_CEILING, Math.max(FIT_FLOOR, max));
  if (fits(ceiling)) {
    return ceiling;
  }
  let lo = FIT_FLOOR;
  let hi = ceiling;
  if (!fits(lo)) {
    return lo;
  }
  for (let step = 0; step < STEPS; step += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.round(lo * 10000) / 10000;
}
