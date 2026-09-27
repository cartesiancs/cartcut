/**
 * A camera path as keyframes on the clip.
 *
 * The zoom is **not** baked into the recorded pixels. It lands as an ordinary
 * animation on `size` and `position`, so the user can drag a keyframe, retime a
 * move or delete the lot, and so re-recording is never the way to change a zoom.
 * The composite pass in `apps/overlay-record` still draws the capture 1:1.
 *
 * ## Why `size` and `position`, and not `scale`
 *
 * `apps/app/src/features/animation/zoomFocus.test.ts` is the authority, and its
 * header derives it: with no rotation a source point at normalised `u` lands at
 * `x + u*w`, so holding it at screen `C` means `x(t) = C - u*w(t)`, and `x` being
 * *affine in w* is what makes the pair exact at every sample rather than only at
 * its anchors. It also means `sampledBoxOf` reports the zoomed box, so the
 * selection outline, the eight grips and the hit test follow the picture instead
 * of sitting on the box it started at. `scale` would multiply the matrix about the
 * centre and leave all of that behind.
 *
 * ## The three rules that keep it exact
 *
 * **One instant list for all four lanes.** `bakeTrack`'s sample grid is
 * `t0 + i*step` unioned with the track's own anchor times, and `sampleBaked` snaps
 * to the nearest sample rather than interpolating. Two lanes with different anchor
 * sets therefore have different grids and can be read up to half a bake step
 * apart, which is a wobble in the framing nothing in the document explains.
 * Identical instants make the grids identical by construction.
 *
 * **One easing per instant, on every lane.** `projectEasing` writes handles as
 * fractions of each lane's own span, so one curve means one normalised `f(t)`
 * whatever the values.
 *
 * **`[1/3, 0, 2/3, 1]` is `smoothstep`, exactly.** For those abscissae the unit
 * bezier's time remap is the identity, so `y = 3u^2 - 2u^3` bit for bit. The eases
 * are therefore reproduced rather than approximated, and `"linear"` (which is
 * `[0, 0, 1, 1]`, where the time and value remaps cancel) is a genuinely straight
 * segment, which is what the decimation tolerance was measured against.
 *
 * Pure, DOM-free, no store: the frame size and the bake rate arrive as arguments.
 */

import { recordBox, type RecordFit, type Size } from "./recordFit";
import {
  LINEAR_EASING,
  SMOOTHSTEP_EASING,
  type CameraInstant,
} from "./zoomCamera";

/** How long the forced release below takes, when there is room for it. */
const RELEASE_MS = 550;

/** One keyframe on one property, in the shape `keyframeWrites.ts` takes. */
export type ZoomKeyframeEntry = {
  atMs: number;
  x: number;
  y: number;
  easing: "linear" | [number, number, number, number];
};

export type ZoomKeyframeWrite = {
  elementId: string;
  property: "size" | "position";
  keyframes: ZoomKeyframeEntry[];
  replace: true;
};

/**
 * The two writes for one clip.
 *
 * `atMs` is **absolute timeline milliseconds**, which is what the agent command
 * takes; the instants arrive in media time from the start of the recording, so
 * `startMs` is the clip's own start. `localTime` throws rather than clamping for a
 * time outside the clip, so instants past the end are dropped here where there is
 * something sensible to do about it.
 *
 * `replace: true` on both, which is what makes re-running auto-zoom idempotent
 * instead of additive.
 */
export function zoomKeyframeWrites(
  elementId: string,
  instants: readonly CameraInstant[],
  fit: RecordFit,
  frame: Size,
  startMs: number,
  spanMs: number,
): ZoomKeyframeWrite[] {
  const usable = instants
    .filter((instant) => Number.isFinite(instant.t) && instant.t >= 0)
    .filter((instant) => instant.t <= spanMs);

  if (usable.length < 2) {
    return [];
  }

  // **The clip ends on the whole screen, always.**
  //
  // Not a tidy-up: it is the one thing the user asked for by name, and it is the
  // difference between a clip that can be cut against and one that ends on a
  // fragment of a screen with no indication of where it was. It has to be enforced
  // here rather than trusted to the planner because the instants are planned
  // against a length that can disagree with the clip's: main's media clock and the
  // muxed container differ by a few hundred milliseconds, and a release landing
  // past the end was filtered out above, leaving a take that finished fully zoomed.
  const last = usable[usable.length - 1];

  if (last.t < spanMs || last.z !== fit.base || last.u !== 0.5 || last.v !== 0.5) {
    // A release takes an ease; if there is no room for one the clip snaps out,
    // which is still better than ending mid-zoom.
    const release = Math.max(last.t + 1, spanMs - RELEASE_MS);
    if (release < spanMs) {
      usable.push({ ...last, t: release, easing: SMOOTHSTEP_EASING });
    }
    usable.push({
      t: spanMs,
      z: fit.base,
      u: 0.5,
      v: 0.5,
      easing: LINEAR_EASING,
    });
  }

  const size: ZoomKeyframeEntry[] = [];
  const position: ZoomKeyframeEntry[] = [];

  for (const instant of usable) {
    const box = recordBox(fit, frame, instant.z, instant.u, instant.v);
    const atMs = startMs + instant.t;

    size.push({ atMs, x: box.width, y: box.height, easing: instant.easing });
    position.push({ atMs, x: box.x, y: box.y, easing: instant.easing });
  }

  return [
    { elementId, property: "size", keyframes: size, replace: true },
    { elementId, property: "position", keyframes: position, replace: true },
  ];
}

/**
 * The static pose, for a clip with no plan.
 *
 * A recording still has to be *fitted* even when nothing zooms: `buildVideo`
 * gives every video its native pixels at (0,0), so a 3024-wide capture would
 * otherwise sit quarter-visible against the top left corner. Auto-zoom being off
 * is a reason to write no keyframes, never a reason to leave the clip unplaced.
 */
export function restingBox(fit: RecordFit, frame: Size) {
  return recordBox(fit, frame, fit.base);
}
