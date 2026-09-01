/**
 * Resolving a mask's five animatable values at a cursor.
 *
 * The mask reads its curves exactly the way the clip reads its own — the same
 * `isActivate` gate, the same "nothing before the element starts" gate, the
 * same nearest-sample snap off the baked lane. This is `transform.ts`'s
 * `localSampleAt` for the mask, and it is a separate function rather than five
 * more fields on `LocalSample` because the two are sampled at different
 * moments: the clip's transform decides where the *layer* goes, and the mask's
 * decides what is cut out of it once it is there.
 *
 * The `isActivate` gate is the reason this cannot simply call `sampleTrack`
 * with the track and be done. `sampleTrack` answers off `ax` whenever `ax`
 * exists, and a track the user has switched *off* still holds the curve they
 * drew — switching a property off is not the same as deleting its keyframes,
 * and the static value has to win while it is off.
 *
 * DOM-free and store-free.
 */

import type { MaskType, TimelineElement } from "../../@types/timeline";
import { sampleTrack, sampleTrackXY } from "../animation/keyframes";
import { type MaskSample, maskStaticSample } from "./place";

/** The track under `property`, but only while it is switched on. */
function activeTrack(element: TimelineElement, property: string): any {
  const track = (element as any)?.animation?.[property];
  return track != null && track.isActivate === true ? track : null;
}

/**
 * The mask as it stands at `cursor`, animation resolved.
 *
 * Every value falls back to what the element statically carries, so a clip with
 * no mask tracks at all — which is every clip until someone keys one — samples
 * to exactly `maskStaticSample(mask)` and costs five null checks.
 */
export function maskSampleAt(
  element: TimelineElement,
  mask: MaskType,
  cursor: number,
): MaskSample {
  const statics = maskStaticSample(mask);
  const startTime = (element as any).startTime;

  const location = sampleTrackXY(
    activeTrack(element, "maskPosition"),
    startTime,
    cursor,
    statics.location.x,
    statics.location.y,
  );
  const size = sampleTrackXY(
    activeTrack(element, "maskSize"),
    startTime,
    cursor,
    statics.size.width,
    statics.size.height,
  );

  return {
    location,
    // `sampleTrackXY` answers in x/y; the size track's two lanes are a width
    // and a height, and the rename happens here rather than in the sampler so
    // that one paired-lane implementation serves both.
    size: { width: Math.max(0, size.x), height: Math.max(0, size.y) },
    rotation: sampleTrack(
      activeTrack(element, "maskRotation"),
      startTime,
      cursor,
      statics.rotation,
    ),
    // Floored, not just sampled: an overshooting curve is *supposed* to leave
    // the range between its keyframes, but a negative feather would reach
    // `blur()` as a negative radius, and a negative size would mirror the mask
    // through its own centre rather than shrink it. The authored curve keeps
    // its shape in the editor; only what reaches the geometry is bounded, which
    // is the rule `MIN_SAMPLED_SCALE` already sets for the clip's own scale.
    feather: Math.max(
      0,
      sampleTrack(
        activeTrack(element, "maskFeather"),
        startTime,
        cursor,
        statics.feather,
      ),
    ),
    roundness: Math.min(
      100,
      Math.max(
        0,
        sampleTrack(
          activeTrack(element, "maskRoundness"),
          startTime,
          cursor,
          statics.roundness,
        ),
      ),
    ),
  };
}
