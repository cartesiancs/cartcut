/**
 * Pure keyframe / animation sampling.
 *
 * Faithful extraction of the sampling logic that was copy-pasted into
 * previewCanvas.ts, controllers/render.ts and offscreen-render.ts as
 * `findNearestY` / `getAnimateScale` / `getAnimatePosition` / `getAnimateRotation`
 * / `zeroIfNegative`. Behaviour is preserved exactly (including quirks) so that
 * preview and export stay bit-for-bit consistent.
 *
 * `cursor` is always the element-relative-ish absolute timeline time in ms; the
 * samplers subtract `element.startTime` internally exactly as the originals did.
 */

import type { RenderElement } from "../model/timeline.types";

/** Nearest-neighbour sampler over baked `[x, y]` point pairs. Returns the `y`
 * of the pair whose `x` is closest to `a`, or `null` for an empty list. Ties
 * keep the earlier pair (strict `<`), matching the original implementation. */
export function findNearestY(
  pairs: ReadonlyArray<ReadonlyArray<number>> | undefined,
  a: number,
): number | null {
  if (!pairs) return null;
  let closestY: number | null = null;
  let closestDiff = Infinity;
  for (const [x, y] of pairs) {
    const diff = Math.abs(x - a);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestY = y;
    }
  }
  return closestY;
}

export function zeroIfNegative(num: number): number {
  return num > 0 ? num : 0;
}

/** Mirrors the `indexPoint < 0` guard used before every animated draw: the
 * original code rounds the cursor to a 16ms frame, remaps to a 20ms grid, and
 * bails when the resulting point precedes the element's start. */
export function isBeforeElementStart(cursor: number, startTime: number): boolean {
  const index = Math.round(cursor / 16);
  const indexToMs = index * 20;
  const indexPoint = Math.round((indexToMs - startTime) / 20);
  return indexPoint < 0;
}

/** Sampled scale multiplier (ax/10), `false` when before start, `null` when the
 * scale track is inactive. Only meaningful when `animation.scale.isActivate`. */
export function sampleScale(
  el: RenderElement,
  cursor: number,
): number | false | null {
  if (el.animation?.scale?.isActivate !== true) return null;
  const startTime = Number(el.startTime);
  if (isBeforeElementStart(cursor, startTime)) return false;
  try {
    const ax = findNearestY(el.animation.scale.ax, cursor - startTime) as number;
    return ax / 10;
  } catch {
    return 1;
  }
}

/** Sampled rotation in radians (`{ ax }`), `false` when before start / on error,
 * `null` when inactive. */
export function sampleRotation(
  el: RenderElement,
  cursor: number,
): { ax: number } | false | null {
  if (el.animation?.rotation?.isActivate !== true) return null;
  const startTime = Number(el.startTime);
  if (isBeforeElementStart(cursor, startTime)) return false;
  try {
    const ax = findNearestY(
      el.animation.rotation.ax,
      cursor - startTime,
    ) as number;
    return { ax: ax * (Math.PI / 180) };
  } catch {
    return false;
  }
}

/** Sampled position (`{ ax, ay }` in project px), `false` when before start / on
 * error, `null` when inactive. */
export function samplePosition(
  el: RenderElement,
  cursor: number,
): { ax: number | null; ay: number | null } | false | null {
  if (el.animation?.position?.isActivate !== true) return null;
  const startTime = Number(el.startTime);
  if (isBeforeElementStart(cursor, startTime)) return false;
  try {
    const ax = findNearestY(el.animation.position.ax, cursor - startTime);
    const ay = findNearestY(el.animation.position.ay, cursor - startTime);
    return { ax, ay };
  } catch {
    return false;
  }
}

/** Sampled opacity as a 0..1 alpha, clamped to >= 0. `false` when before start,
 * `null` when inactive (caller keeps the element's static `opacity/100`). */
export function sampleOpacityAlpha(
  el: RenderElement,
  cursor: number,
): number | false | null {
  if (el.animation?.opacity?.isActivate !== true) return null;
  const startTime = Number(el.startTime);
  if (isBeforeElementStart(cursor, startTime)) return false;
  try {
    const ax = findNearestY(
      el.animation.opacity.ax,
      cursor - startTime,
    ) as number;
    return zeroIfNegative(ax / 100);
  } catch {
    return null;
  }
}
