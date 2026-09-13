/**
 * An effect's numbers at one instant, animation resolved.
 *
 * The counterpart to `effectTime.ts`: that answers *when* an effect thinks it
 * is, this answers *what it is set to*. Both are pure, take the element and the
 * cursor, and are called from `planFrame` so that the preview and the export
 * ask the same question of the same code.
 *
 * Two tracks families reach the shader through here, and they are stored in
 * different places for a reason `@types/timeline.ts` sets out:
 *
 *  - `intensity` is a field on the element, because every effect has one
 *    whatever preset is behind it.
 *  - `fx:<key>` names a preset parameter, whose keys come from a manifest on
 *    disk and so cannot be written down ahead of time.
 *
 * Neither is seeded. A track exists only while it is animated, so the common
 * case is that `animation` holds neither and this returns the element's own
 * `intensity` and `params` **by identity**: no allocation, and `applyParams`
 * goes on uploading exactly the object it always did.
 */

import type { EffectElementType, FxParams } from "../../../@types/timeline";
import { fxParamKeyOf, isFxParamTrack } from "../../../@types/timeline";
import { sampleTrack } from "../../animation/keyframes";

export type EffectSample = {
  /** 0-100, the number the Intensity row shows. */
  intensity: number;
  /** The element's parameters with every live track substituted. */
  params: FxParams;
};

/** The track under `property`, but only while it is switched on. */
function activeTrack(element: EffectElementType, property: string): any {
  const track = (element as any)?.animation?.[property];
  return track != null && track.isActivate === true ? track : null;
}

/**
 * Clamp to the range `setEffectIntensity` enforces on the write side.
 *
 * The same argument `transform.ts#MIN_SAMPLED_SCALE` makes: an overshooting
 * curve is supposed to leave the range between its keyframes, and clamping here
 * rather than in the curve keeps the authored shape intact and readable in the
 * editor. Only what reaches the uniform is bounded.
 *
 * A preset parameter is *not* clamped here, because this module does not hold
 * the manifest that states its range. `glslWrap.ts#uniformValueOf` does, and
 * clamps there.
 */
function clampIntensity(value: number): number {
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

/**
 * An effect's intensity and numeric parameters at `cursor`.
 *
 * `cursor` is absolute timeline ms, as it is for every other public sampler;
 * `sampleTrack` converts with the element's own `startTime` and answers the
 * static value for a cursor that has not reached the clip yet.
 */
export function effectSampleAt(
  element: EffectElementType,
  cursor: number,
): EffectSample {
  const animation = (element as any)?.animation;
  const startTime = element.startTime;

  const intensityTrack = activeTrack(element, "intensity");
  const intensity =
    intensityTrack == null
      ? element.intensity
      : clampIntensity(
          sampleTrack(intensityTrack, startTime, cursor, element.intensity),
        );

  let params = element.params;
  if (animation != null) {
    for (const property of Object.keys(animation)) {
      if (!isFxParamTrack(property)) {
        continue;
      }
      const track = activeTrack(element, property);
      if (track == null) {
        continue;
      }
      const key = fxParamKeyOf(property);
      const fallback = element.params?.[key];
      if (typeof fallback !== "number") {
        // The parameter has gone, or was never a number. `carriesTrack` says
        // this track is an orphan and `normalizeAnimation` will collect it on
        // the next ingress; until then it drives nothing, which is the same
        // thing a missing preset does.
        continue;
      }
      const value = sampleTrack(track, startTime, cursor, fallback);
      if (value === fallback) {
        continue;
      }
      // Copied at the first substitution and not before, so an effect with
      // tracks that all happen to sit on their static value this frame still
      // hands the compositor the element's own object.
      if (params === element.params) {
        params = { ...element.params };
      }
      params[key] = value;
    }
  }

  return { intensity, params };
}
