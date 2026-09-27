/**
 * A zoom plan, smoothed into a camera path, sparse enough to be keyframes.
 *
 * `zoomPlan.ts` says when to zoom, how deep, and at what. This says where the
 * picture actually is at each instant, and it exists for two things the segment
 * list cannot express.
 *
 * ## Following the cursor, through a dead zone
 *
 * At 1.9x a drag across the screen leaves the framing entirely, so a zoom that
 * holds one centre for its whole length either ends early or loses the action.
 * Screen Studio follows the cursor; the reason this module is careful about it is
 * the warning the old `planZoom` carried, that panning across the screen at full
 * zoom is the most nauseating thing it could produce. That warning is right about
 * *unbounded* panning between two framings, and the answer is a **dead zone**:
 * the camera holds still while the cursor is inside the middle `DEAD_ZONE` of
 * what is on screen, and moves only enough to put it back on that edge when it
 * leaves. Small hand movement produces no motion at all, which is the property
 * that makes the picture stop swimming.
 *
 * ## Staying inside the picture during an ease
 *
 * The aim a zoom can reach depends on how deep it is: at full zoom a corner click
 * is reachable, at `z = 1` only the centre is. So an ease that travels to its
 * final aim on the same curve as its zoom **shows background part way through**.
 * For a 16:10 capture at 1.5x the overshoot is about 50px at a third of the way
 * in, which is plainly visible and would be invisible in any suite whose fixtures
 * all share one aspect.
 *
 * The bound at `z = 1` is **exactly zero**: there the picture is precisely as wide
 * as the frame and the only legal aim is the centre. So no amount of shrinking a
 * destination helps: any aim that has begun moving before the picture covers the
 * frame leaks, and the fix is for the pan to *start* at the moment the zoom reaches
 * cover. That is one extra instant, at the crossing, with the aim still centred.
 *
 * And once that instant exists, nothing further has to be proved. The clip is
 * written as `size` and `position` keyframes, so what is drawn between two instants
 * is the **linear blend of two boxes**, and "covers the frame" is a pair of linear
 * inequalities in `(x, w)`: `x <= 0` and `x + w >= frameWidth`. A linear blend of
 * two points that both satisfy a linear inequality satisfies it throughout. So
 * every instant covering is enough for every frame between them to cover, by
 * convexity, with no envelope and no per-frame clamp.
 *
 * The crossing instant is what makes that argument available: it is the one pose
 * that is exactly flush (`w = frameWidth`, `x = 0`), so the leg before it stays
 * inside the padded look and every leg after it covers.
 *
 * The **ease out** is the same statement mirrored. Substituting
 * `r = 1 - smoothstep(p)` turns it into the ease in exactly, so it gets the same
 * crossing instant on the way back.
 *
 * One consequence, and it is the reason `referencePose` says what it says: during
 * an ease the blended box is *not* `recordBox` of a blended pose. Holding a source
 * point still needs `x` to be affine in `w`, which is true only while the aim is
 * constant, which holds during a hold and not during an ease. The two differ by a
 * quadratic term
 * worth about 90px at the midpoint of a 2x zoom-in: a slightly different curvature
 * on the way to the same destination, which is why it is a note and not a defect.
 *
 * ## Why the instants come out sparse
 *
 * An ease is exactly `smoothstep` by construction, and `[1/3, 0, 2/3, 1]` is
 * exactly `smoothstep` as a cubic bezier: for those abscissae the unit curve's
 * time remap is the identity, so `y = 3u^2 - 2u^3` bit for bit. So an ease is two
 * keyframes, not forty. Only the follow is simulated, and it is slow by design,
 * so it decimates to a handful of instants within a tolerance stated in **output
 * pixels**.
 *
 * Pure, DOM-free, no store.
 */

import { criticalDamping, type Spring } from "../motion/spring";
import type { CursorSample } from "./inputLog";
import { clampAim, recordBox, type RecordFit, type Size } from "./recordFit";
import { sampleZoom, smoothstep, type ZoomSegment } from "./zoomPlan";

/** `smoothstep` as a cubic bezier. Exact, not an approximation of it. */
export const SMOOTHSTEP_EASING: [number, number, number, number] = [
  1 / 3, 0, 2 / 3, 1,
];

/** Straight interpolation, for the decimated follow. */
export const LINEAR_EASING = "linear" as const;

export type Easing = typeof LINEAR_EASING | [number, number, number, number];

/**
 * `smoothstep` restricted to `[0, at]` and to `[at, 1]`, each renormalised.
 *
 * Inserting the crossing instant would otherwise *change the curve*: two
 * smoothsteps chained at an interior point are not the smoothstep they were cut
 * from, and the difference reaches a few hundred pixels of box width part way
 * through an ease. De Casteljau subdivision is the exact answer, and it is the same
 * operation `keyframes.ts#plantKeyframe` uses to add a keyframe without moving the
 * curve it sits on, so the zoom travels precisely the path `sampleZoom` describes
 * even though it is authored in two pieces.
 *
 * This is also why the two properties can share one easing per instant, which is
 * what keeps their bake grids identical. Over `[at, 1]` the box extent is affine in
 * the eased parameter (`w = coverWidth * z`, and `z` is affine in it) and so is the
 * aim's offset (`(z - 1) / (zoom - 1)`), so a single curve describes both. Over
 * `[0, at]` the aim does not move at all and any curve describes it.
 */
export function splitSmoothstep(at: number): { before: Easing; after: Easing } {
  // The unit curve, as a cubic bezier: `x(u) = u` exactly for these abscissae,
  // which is what makes `y(u) = 3u^2 - 2u^3` the value curve rather than a remap
  // of it.
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 1 / 3, y: 0 };
  const p2 = { x: 2 / 3, y: 1 };
  const p3 = { x: 1, y: 1 };

  const lerp = (a: typeof p0, b: typeof p0, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  const a = lerp(p0, p1, at);
  const b = lerp(p1, p2, at);
  const c = lerp(p2, p3, at);
  const d = lerp(a, b, at);
  const e = lerp(b, c, at);
  const split = lerp(d, e, at);

  return {
    before: normalise(p0, a, d, split),
    after: normalise(split, e, c, p3),
  };
}

/**
 * A sub-curve's control points as an easing quadruple.
 *
 * An easing is stated relative to its own segment's span in both axes, which is
 * what `projectEasing` then maps onto the real times and values. A degenerate span
 * means the sub-segment has no extent, and the honest answer there is a straight
 * line rather than a division by zero.
 */
function normalise(
  q0: { x: number; y: number },
  q1: { x: number; y: number },
  q2: { x: number; y: number },
  q3: { x: number; y: number },
): Easing {
  const spanX = q3.x - q0.x;
  const spanY = q3.y - q0.y;

  if (spanX <= 0 || spanY === 0) {
    return LINEAR_EASING;
  }

  return [
    (q1.x - q0.x) / spanX,
    (q1.y - q0.y) / spanY,
    (q2.x - q0.x) / spanX,
    (q2.y - q0.y) / spanY,
  ];
}

/**
 * One pose, and how to travel away from it.
 *
 * `easing` describes the segment *leaving* this instant, which is the reading
 * `easing.ts` documents and CSS shares.
 */
export type CameraInstant = {
  /** Media ms, from the start of the clip. */
  t: number;
  /** Zoom in cover units. */
  z: number;
  /** Aim, as a fraction of the capture. */
  u: number;
  v: number;
  easing: Easing;
};

/**
 * How much of what is on screen the cursor may wander before the camera moves.
 *
 * A fraction of the visible window, per axis, measured from the centre. At 0.35
 * the cursor has a third of the frame to move in for free. Set it to 1 and the
 * camera never follows, which is the old behaviour and a deliberate escape hatch:
 * this is the part most likely to need tuning against a real recording.
 */
export const DEAD_ZONE = 0.35;

/**
 * How hard the camera chases the cursor.
 *
 * Critically damped. An overshoot here is the camera sailing past the thing it
 * was following and coming back, which reads as a mistake rather than as
 * liveliness, the opposite of the tile hover this repo's other spring drives.
 */
const FOLLOW_SPRING: Spring = {
  stiffness: 26,
  damping: criticalDamping({ stiffness: 26 }),
};

/** The follow is integrated at this rate before being decimated. */
const SIM_HZ = 120;

/**
 * How far the decimated path may stray from the simulated one, in output pixels.
 *
 * Stated in pixels rather than as an abstract epsilon so the number means
 * something: at 1 px nobody can see the difference between the path and its
 * approximation, and the count comes out in the tens rather than the thousands.
 */
export const DECIMATE_TOLERANCE_PX = 1;

/**
 * How far through an ease the picture reaches cover, as an eased fraction.
 *
 * `null` when it is covered the whole way: a capture matching the frame's aspect
 * with no padding rests at `z = 1`, so there is no crossing and no extra instant to
 * insert.
 *
 * In *eased* units rather than in time, because that is what the pose is a function
 * of; `easedTime` inverts it for the instant's timestamp.
 */
export function coverCrossing(base: number, zoom: number): number | null {
  if (base >= 1 || zoom <= 1 || zoom <= base) {
    return null;
  }
  return (1 - base) / (zoom - base);
}

/**
 * The time at which `smoothstep` reaches `eased`, within `[0, 1]`.
 *
 * Newton from the midpoint. `smoothstep` is monotone on the unit interval with a
 * zero derivative at both ends, so the ends are the only places this could stall
 * and they are the two values it is never asked for.
 */
export function easedTime(eased: number): number {
  if (eased <= 0) return 0;
  if (eased >= 1) return 1;

  let p = 0.5;
  for (let index = 0; index < 24; index += 1) {
    const value = p * p * (3 - 2 * p) - eased;
    const slope = 6 * p * (1 - p);
    if (Math.abs(slope) < 1e-12) break;
    const next = p - value / slope;
    p = next < 0 ? 0 : next > 1 ? 1 : next;
  }
  return p;
}

/** Half the visible window, in capture fractions, on one axis. */
function halfWindow(frameExtent: number, boxExtent: number): number {
  return boxExtent <= 0 ? 0.5 : Math.min(0.5, frameExtent / (2 * boxExtent));
}

/**
 * Where the camera should be aiming, given where the cursor is.
 *
 * The dead zone, per axis. Inside it the answer is exactly the current aim, which
 * is what makes "no motion at all" a real state rather than a very slow drift.
 */
export function followTarget(
  aim: { u: number; v: number },
  cursor: { u: number; v: number },
  fit: RecordFit,
  frame: Size,
  z: number,
): { u: number; v: number } {
  return {
    u: followAxis(aim.u, cursor.u, halfWindow(frame.width, fit.cover.width * z)),
    v: followAxis(aim.v, cursor.v, halfWindow(frame.height, fit.cover.height * z)),
  };
}

function followAxis(aim: number, cursor: number, half: number): number {
  const slack = half * DEAD_ZONE;
  const delta = cursor - aim;

  if (Math.abs(delta) <= slack) {
    return aim;
  }
  return delta > 0 ? cursor - slack : cursor + slack;
}

/** The cursor's position at `t`, as a fraction of the capture. */
function cursorAt(
  cursor: readonly CursorSample[],
  capture: Size,
  t: number,
): { u: number; v: number } | null {
  if (cursor.length === 0 || capture.width <= 0 || capture.height <= 0) {
    return null;
  }

  // Binary search for the sample at or before `t`. The track is sorted on the way
  // out of `normalizeInputLog`, so this does not re-sort per call.
  let low = 0;
  let high = cursor.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (cursor[mid].t <= t) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const sample = cursor[low];
  return { u: sample.x / capture.width, v: sample.y / capture.height };
}

/**
 * Advance the spring one step, carrying velocity, **exactly**.
 *
 * `features/motion/spring.ts` answers where a spring is at `t` from rest travelling
 * to a fixed target, in closed form. That cannot be used directly because the
 * target moves every sample. But the closed form for one step with a *constant*
 * target can, and it is short:
 *
 *     d(t) = (d0 + (v0 + w*d0) * t) * e^(-w * t),    w = sqrt(stiffness)
 *
 * for `d = x - target` at critical damping. Exact beats integrating: a
 * semi-implicit Euler step at 120Hz drifts about a percent of the travel from the
 * true response and its stability depends on `dt`, where this is correct at any
 * rate with no accumulating error to reason about. It is also what lets the suite
 * hold it to the closed form to nine places rather than to two.
 *
 * Critical damping is assumed rather than configured, which is why `FOLLOW_SPRING`
 * derives its damping and this reads only the stiffness.
 */
export function springStep(
  state: { x: number; velocity: number },
  target: number,
  dt: number,
): void {
  const w = Math.sqrt(FOLLOW_SPRING.stiffness);
  const d0 = state.x - target;
  const b = state.velocity + w * d0;
  const decay = Math.exp(-w * dt);

  state.x = target + (d0 + b * dt) * decay;
  state.velocity = (b - w * (d0 + b * dt)) * decay;
}

/**
 * The follow, across one hold.
 *
 * Zoom is constant here, because the eases own the zoom, so the clamp bound is constant
 * too, and clamping every sample is both cheap and safe. No shrink is needed and
 * none is applied.
 */
function simulateHold(
  fromMs: number,
  toMs: number,
  z: number,
  aim: { u: number; v: number },
  cursor: readonly CursorSample[],
  capture: Size,
  fit: RecordFit,
  frame: Size,
): CameraInstant[] {
  const dt = 1 / SIM_HZ;
  const stepMs = 1000 / SIM_HZ;

  const u = { x: aim.u, velocity: 0 };
  const v = { x: aim.v, velocity: 0 };

  const samples: CameraInstant[] = [];

  for (let t = fromMs; t <= toMs; t += stepMs) {
    const at = cursorAt(cursor, capture, t);

    if (at != null) {
      const target = followTarget({ u: u.x, v: v.x }, at, fit, frame, z);
      springStep(u, target.u, dt);
      springStep(v, target.v, dt);
    }

    // Zoom is constant across a hold, so this instant's clamp is the whole
    // constraint and there is nothing to anticipate.
    const clamped = clampAim(fit, frame, z, u.x, v.x);
    u.x = clamped.u;
    v.x = clamped.v;

    samples.push({ t, z, u: u.x, v: v.x, easing: LINEAR_EASING });
  }

  return samples;
}

/**
 * Drop the instants a straight line between their neighbours already covers.
 *
 * A greedy forward pass rather than Ramer-Douglas-Peucker. RDP measures a
 * perpendicular distance, which needs a metric across four unrelated numbers;
 * this measures what is actually visible, the largest error in the drawn box in
 * pixels, and bounds it directly. `strokeRender.ts#simplifyStroke` is the RDP in
 * this codebase and it is the right shape for a 2D pen path and the wrong one
 * here.
 */
export function decimate(
  samples: readonly CameraInstant[],
  fit: RecordFit,
  frame: Size,
  tolerancePx = DECIMATE_TOLERANCE_PX,
): CameraInstant[] {
  if (samples.length <= 2) {
    return samples.slice();
  }

  const kept: CameraInstant[] = [samples[0]];
  let anchor = 0;

  for (let index = 2; index < samples.length; index += 1) {
    if (withinTolerance(samples, anchor, index, fit, frame, tolerancePx)) {
      continue;
    }
    // `index` broke it, so the last instant a line could reach was the one before.
    kept.push(samples[index - 1]);
    anchor = index - 1;
  }

  kept.push(samples[samples.length - 1]);
  return kept;
}

function withinTolerance(
  samples: readonly CameraInstant[],
  from: number,
  to: number,
  fit: RecordFit,
  frame: Size,
  tolerancePx: number,
): boolean {
  const a = samples[from];
  const b = samples[to];
  const span = b.t - a.t;
  if (span <= 0) {
    return true;
  }

  for (let index = from + 1; index < to; index += 1) {
    const sample = samples[index];
    const p = (sample.t - a.t) / span;

    const guessed = recordBox(
      fit,
      frame,
      a.z + (b.z - a.z) * p,
      a.u + (b.u - a.u) * p,
      a.v + (b.v - a.v) * p,
    );
    const actual = recordBox(fit, frame, sample.z, sample.u, sample.v);

    const error = Math.max(
      Math.abs(guessed.x - actual.x),
      Math.abs(guessed.y - actual.y),
      Math.abs(guessed.width - actual.width),
      Math.abs(guessed.height - actual.height),
    );

    if (error > tolerancePx) {
      return false;
    }
  }

  return true;
}

/**
 * A curve read from its other end.
 *
 * The ease out travels the ease in's path backwards, so each of its pieces is the
 * corresponding piece of the ease in reflected through the centre of the unit
 * square: `(x, y) -> (1 - x, 1 - y)`, with the two control points swapping places
 * because the direction of travel reversed.
 */
function reverse(easing: Easing): Easing {
  if (easing === LINEAR_EASING) {
    return LINEAR_EASING;
  }
  const [x1, y1, x2, y2] = easing;
  return [1 - x2, 1 - y2, 1 - x1, 1 - y1];
}

/**
 * How small a gap between two moves is no gap at all.
 *
 * Two moves that end and begin at the same instant would otherwise have the
 * camera release fully to the resting pose and start straight back in, which is
 * the pulsing this module's planner spends three rules avoiding. Below this they
 * are **chained**: the camera stays zoomed and travels from one framing to the
 * next, which is what a viewer reads as following the action.
 *
 * Both ends of that travel cover the frame, so it needs no crossing instant and
 * stays covering throughout by the same convexity argument as everything else.
 */
const CHAIN_GAP_MS = 250;

export type CameraOptions = {
  tolerancePx?: number;
  /** Set to 1 to hold each framing still, which is the pre-follow behaviour. */
  deadZone?: number;
};

/**
 * The whole path, as instants.
 *
 * Starts and ends at rest, always. The last instant is the clip's own end at the
 * resting pose, so a clip can never finish mid-zoom looking at a fragment of a
 * screen with no indication of where it was.
 */
export function runCamera(
  segments: readonly ZoomSegment[],
  cursor: readonly CursorSample[],
  capture: Size,
  fit: RecordFit,
  frame: Size,
  durationMs: number,
  options: CameraOptions = {},
): CameraInstant[] {
  const rest = (t: number): CameraInstant => ({
    t,
    z: fit.base,
    u: 0.5,
    v: 0.5,
    easing: LINEAR_EASING,
  });

  if (segments.length === 0 || durationMs <= 0) {
    return [rest(0), rest(Math.max(0, durationMs))];
  }

  const instants: CameraInstant[] = [rest(0)];

  let chained = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    const chainsToNext =
      next != null && next.inStart - segment.outEnd <= CHAIN_GAP_MS;

    const aim = clampAim(fit, frame, segment.zoom, segment.u, segment.v);
    const cross = coverCrossing(fit.base, segment.zoom);
    // Subdivided at the crossing's *time*, not at its eased value: the easing's own
    // parameter is time, and for these abscissae they are the same number anyway.
    const split = cross == null ? null : splitSmoothstep(easedTime(cross));

    // Arriving from the resting pose, unless the move before this one handed the
    // camera over still zoomed.
    if (!chained) {
      // Leaving the resting pose on the exact curve `sampleZoom` describes, or on
      // its first piece, which is the same curve.
      instants.push({
        ...rest(segment.inStart),
        easing: split?.before ?? SMOOTHSTEP_EASING,
      });

      // The crossing, still centred. At `z = 1` the only legal aim is the centre,
      // so the pan cannot have started before here; see the module header.
      if (cross != null && split != null) {
        instants.push({
          t: segment.inStart + (segment.inEnd - segment.inStart) * easedTime(cross),
          z: 1,
          u: 0.5,
          v: 0.5,
          easing: split.after,
        });
      }
    }

    const hold = decimate(
      simulateHold(
        segment.inEnd,
        segment.outStart,
        segment.zoom,
        aim,
        cursor,
        capture,
        fit,
        frame,
      ),
      fit,
      frame,
      options.tolerancePx,
    );

    for (const sample of hold) {
      instants.push(sample);
    }

    if (chainsToNext) {
      // Straight on to the next framing, still zoomed. The travel runs from here
      // to the next move's own first held pose, so it takes the ease out and the
      // ease in together, and one smoothstep describes it.
      instants[instants.length - 1].easing = SMOOTHSTEP_EASING;
      chained = true;
      continue;
    }

    // The follow decides where the ease out starts from, so the last held pose
    // carries the curve rather than the framing this segment was planned with.
    // Mirrored: the ease out's first piece is the reverse of the ease in's second,
    // which is `after` read backwards, and a cubic bezier reversed is its control
    // points swapped and reflected.
    instants[instants.length - 1].easing =
      split == null ? SMOOTHSTEP_EASING : reverse(split.after);

    // ...and the crossing again on the way back, for the same reason mirrored.
    if (cross != null && split != null) {
      instants.push({
        t:
          segment.outEnd -
          (segment.outEnd - segment.outStart) * easedTime(cross),
        z: 1,
        u: 0.5,
        v: 0.5,
        easing: reverse(split.before),
      });
    }

    instants.push(rest(segment.outEnd));
    chained = false;
  }

  const end = Math.max(durationMs, instants[instants.length - 1].t);
  if (end > instants[instants.length - 1].t) {
    instants.push(rest(end));
  }

  return instants;
}

/**
 * The pose at `t`, straight from the plan rather than from the instants.
 *
 * The independent reference the keyframe suite checks the written animation against:
 * it shares no code with `runCamera`'s assembly, with `bakeTrack` or with
 * `localSampleAt`, so agreement between them is evidence rather than a tautology.
 *
 * It is the truth in exactly two places, and the suite only asks it there:
 *
 *  - **At an instant.** Every keyframe is `recordBox` of a planned pose, so this
 *    and the drawn box agree exactly.
 *  - **Throughout a hold**, where the aim is constant and `x` is therefore affine
 *    in `w`, which is the whole of `zoomFocus.test.ts`'s argument.
 *
 * *Between* the instants of an ease the clip draws the linear blend of two boxes,
 * which is not `recordBox` of a blended pose; see the module header. That is a
 * property of writing the animation as `size` and `position` rather than as a
 * camera, and it is what makes covering automatic, so the reference bends to it
 * rather than the other way round.
 *
 * It does not model the follow either, so a hold in which the cursor left the dead
 * zone is outside what it describes.
 */
export function referencePose(
  segments: readonly ZoomSegment[],
  fit: RecordFit,
  frame: Size,
  tMs: number,
): { z: number; u: number; v: number } {
  const view = sampleZoom(segments, tMs);
  const z = fit.base + (view.zoom - fit.base) * view.progress;

  if (view.progress === 0) {
    return { z, u: 0.5, v: 0.5 };
  }

  const aim = clampAim(fit, frame, view.zoom, view.u, view.v);

  // The pan is driven by how far past cover the zoom has travelled, not by the
  // ease's own progress: before cover the only legal aim is the centre. That is
  // the same thing the crossing instant expresses, stated continuously.
  const panned =
    view.zoom <= 1
      ? view.progress
      : Math.max(0, Math.min(1, (z - 1) / (view.zoom - 1)));

  return {
    z,
    u: 0.5 + (aim.u - 0.5) * panned,
    v: 0.5 + (aim.v - 0.5) * panned,
  };
}
