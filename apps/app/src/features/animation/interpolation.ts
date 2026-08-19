import { sampleBaked } from "./keyframes";

/**
 * Sample a baked animation track at a timeline cursor.
 *
 * Despite the name this does not interpolate — it snaps to the nearest baked
 * sample. That is deliberate and unchanged: `bakeTrack` already lays samples
 * down at 60Hz, so the curve is smooth without blending, and blending would
 * move every rendered frame and every golden snapshot.
 *
 * What changed is underneath. The scan this delegated to was linear, and it ran
 * per property, per element, on every frame; `sampleBaked` binary-searches an
 * array `bakeTrack` now guarantees is sorted.
 *
 * The start guard is the other fix. It used to round the cursor onto a 16ms
 * frame, multiply by 20, and compare the result against the element's start —
 * a 16-to-20ms unit mismatch that stretched the cursor by 25%. Its only visible
 * effect was that a cursor up to a fifth of the way *before* an element still
 * fell through and snapped to that element's first keyframe.
 */
export function interpolate(
  initialValue: number,
  animationPoints: number[][],
  elementStartTime: number,
  timelineCursor: number,
): number {
  if (!(timelineCursor >= elementStartTime)) {
    return initialValue;
  }
  return sampleBaked(
    animationPoints,
    timelineCursor - elementStartTime,
    initialValue,
  );
}
