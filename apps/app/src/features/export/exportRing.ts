/**
 * The geometry of the title bar's progress ring.
 *
 * Its own module rather than a function on the component, for the reason every
 * pure module in this codebase is: importing `exportButton.ts` pulls in
 * `exportSession` and through it `loadedAssetStore`, which builds canvases at
 * module load and cannot be imported under `environment: "node"`.
 */

/** The ring's box, sized to sit inside the 34px title bar with room to breathe. */
export const RING_SIZE = 22;
export const RING_STROKE = 2.5;

/**
 * To the stroke's **centre line**, not the outer edge.
 *
 * A stroke straddles the path it follows, so a radius measured to the edge puts
 * half of it outside the viewBox and the ring is drawn with two flat sides.
 */
export const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;

/**
 * The dash pair that draws a ring `percent` full.
 *
 * Clamped and guarded against a non-finite input, because a `NaN` dashoffset
 * draws nothing at all — on screen indistinguishable from an export that never
 * started.
 */
export function ringDash(
  percent: number,
  radius: number = RING_RADIUS,
): { array: number; offset: number } {
  const circumference = 2 * Math.PI * radius;
  const safe = Number.isFinite(percent) ? percent : 0;
  const fraction = Math.max(0, Math.min(1, safe / 100));
  return {
    array: circumference,
    offset: circumference * (1 - fraction),
  };
}
