/**
 * The speed ramp's editing surface, without a canvas.
 *
 * Everything the graph does to a curve lives here: where a point sits on the
 * plot, which point a click is on, and what a drag, an insert or a delete leaves
 * behind. `features/option/controlSpeedCurve.ts` draws it and dispatches to it,
 * and holds no rules of its own, for the reason this codebase has no DOM test
 * environment: a rule kept inside a Lit class is a rule nothing can check.
 *
 * The same split `features/crop/` uses, and the `CropRect` suite is the model.
 *
 * ## Two things the graph must not do
 *
 * **The axes do not move while a drag is in flight.** Editing a ramp changes
 * how long the clip is, so a graph whose x axis was timeline time would resize
 * under the pointer on the frame the drag committed, and the position the
 * pointer is over would name a different instant each repaint: a feedback loop
 * with no fixed point. The x axis is **source** time, which a ramp cannot
 * change, so it stands still.
 *
 * **Points stay in order.** Every edit here clamps a point between its
 * neighbours rather than sorting afterwards, so the list handed to
 * `setClipSpeedCurve` is already sorted and a fast drag past a neighbour stops
 * against it instead of swapping two points under the pointer.
 */

import {
  MAX_SPEED,
  MIN_CURVE_GAP_MS,
  MIN_SPEED,
  type SpeedPoint,
} from "../timeline/speedCurve";

/** The plot rect, and the source window it shows. */
export type GraphViewport = {
  /** Plot rect in CSS px, inside whatever padding the component drew. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source ms at the left and right edges of the plot. */
  fromMs: number;
  toMs: number;
};

/**
 * How much of the source either side of the clip's window the plot shows.
 *
 * A fraction of the window rather than a fixed number of ms, so a two-second
 * clip and a two-minute one both get a visible margin. It exists because the
 * ramp's points are absolute source ms and are deliberately **not** clipped to
 * the trim window: a point left outside by an earlier trim is what makes
 * dragging the trim back out restore the ramp, and a point the user cannot see
 * is a point they cannot fix.
 */
export const MARGIN_FRACTION = 0.1;

/** How near a click has to land to count as being on a point, in CSS px. */
export const HIT_RADIUS_PX = 8;

const LN_MIN = Math.log(MIN_SPEED);
const LN_MAX = Math.log(MAX_SPEED);

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * The plot for one clip's window.
 *
 * Declines with a zero-width window rather than dividing by it, so a caller
 * that renders before the element has loaded draws nothing instead of throwing
 * on every frame.
 */
export function viewportFor(
  trimStartMs: number,
  trimEndMs: number,
  rect: { x: number; y: number; w: number; h: number },
): GraphViewport | null {
  const span = trimEndMs - trimStartMs;
  if (!Number.isFinite(span) || span <= 0 || rect.w <= 0 || rect.h <= 0) {
    return null;
  }
  const margin = span * MARGIN_FRACTION;
  return {
    ...rect,
    fromMs: trimStartMs - margin,
    toMs: trimEndMs + margin,
  };
}

/**
 * Where a rate sits vertically, as a fraction with 0 at the top.
 *
 * **Logarithmic**, so 1x is exactly halfway and a halving and a doubling are
 * the same distance. The linear alternative puts 1x a fifth of the way up and
 * gives the whole of slow motion, which is most of what people reach for, about
 * a twentieth of the height. `levelLine.ts` makes the same argument for the
 * fader's taper.
 */
export function speedToFraction(speed: number): number {
  const clamped = clamp(speed, MIN_SPEED, MAX_SPEED);
  return 1 - (Math.log(clamped) - LN_MIN) / (LN_MAX - LN_MIN);
}

export function fractionToSpeed(fraction: number): number {
  const t = clamp(fraction, 0, 1);
  return Math.exp(LN_MIN + (1 - t) * (LN_MAX - LN_MIN));
}

export function toScreen(
  view: GraphViewport,
  point: SpeedPoint,
): { x: number; y: number } {
  const span = view.toMs - view.fromMs;
  return {
    x: view.x + ((point.t - view.fromMs) / span) * view.w,
    y: view.y + speedToFraction(point.v) * view.h,
  };
}

/** The point a screen position names, clamped into the range but not the window. */
export function toCurve(
  view: GraphViewport,
  x: number,
  y: number,
): SpeedPoint {
  const span = view.toMs - view.fromMs;
  return {
    t: view.fromMs + ((x - view.x) / view.w) * span,
    v: fractionToSpeed((y - view.y) / view.h),
  };
}

/** Index of the point under a screen position, or `null`. */
export function hitTest(
  view: GraphViewport,
  points: readonly SpeedPoint[],
  x: number,
  y: number,
  radius = HIT_RADIUS_PX,
): number | null {
  let best: number | null = null;
  let bestDistance = radius * radius;
  points.forEach((point, index) => {
    const at = toScreen(view, point);
    const distance = (at.x - x) ** 2 + (at.y - y) ** 2;
    // `<=` so the later of two points stacked at one instant wins, which is the
    // one drawn on top and therefore the one the user aimed at.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * Move one point, clamped between its neighbours.
 *
 * Absolute rather than a delta, so re-applying it during a drag is idempotent
 * and the whole gesture collapses to one undo step through `GestureCommit`.
 */
export function movePoint(
  points: readonly SpeedPoint[],
  index: number,
  to: SpeedPoint,
): SpeedPoint[] {
  if (index < 0 || index >= points.length) {
    return [...points];
  }
  const low =
    index === 0 ? -Infinity : points[index - 1].t + MIN_CURVE_GAP_MS;
  const high =
    index === points.length - 1
      ? Infinity
      : points[index + 1].t - MIN_CURVE_GAP_MS;

  const next = [...points];
  next[index] = {
    // `low` can exceed `high` when two neighbours are already at the minimum
    // gap, and `clamp` answers `low` there, which would push the point past its
    // right neighbour. Pinned to the midpoint instead, which is inside both.
    t: low > high ? (low + high) / 2 : clamp(to.t, low, high),
    v: clamp(to.v, MIN_SPEED, MAX_SPEED),
  };
  return next;
}

/**
 * Add a point, or decline when there is no room for one.
 *
 * `null` rather than a silently moved point: a click that cannot become a point
 * should leave the curve alone, and the caller reads `null` as "nothing
 * happened" the same way the pure ops do.
 */
export function insertPoint(
  points: readonly SpeedPoint[],
  at: SpeedPoint,
): SpeedPoint[] | null {
  const tooClose = points.some(
    (point) => Math.abs(point.t - at.t) < MIN_CURVE_GAP_MS,
  );
  if (tooClose) {
    return null;
  }
  const next = [...points, { t: at.t, v: clamp(at.v, MIN_SPEED, MAX_SPEED) }];
  next.sort((left, right) => left.t - right.t);
  return next;
}

/**
 * Take a point out.
 *
 * `null` when fewer than two would be left, which the caller passes straight to
 * `setClipSpeedCurve` and which removes the ramp. Deleting a ramp down to
 * nothing is a reasonable way to mean "make this a constant rate", and the
 * alternative, refusing the last two deletes, leaves the user prodding at a
 * control that has stopped answering.
 */
export function removePoint(
  points: readonly SpeedPoint[],
  index: number,
): SpeedPoint[] | null {
  if (index < 0 || index >= points.length) {
    return [...points];
  }
  const next = points.filter((_, i) => i !== index);
  return next.length >= 2 ? next : null;
}

/**
 * The ramps the panel offers as one click.
 *
 * Laid out as fractions of the clip's source window, so they mean the same
 * thing on a two-second clip and a two-minute one, and all piecewise linear
 * because that is what the format is. A smooth ramp is spelled as points rather
 * than as an easing mode the integral would have to be numeric for.
 */
export type SpeedPreset = {
  id: string;
  /** Locale key, as `LocaleController.t` takes it. */
  label: string;
  build: (trimStartMs: number, trimEndMs: number) => SpeedPoint[] | null;
};

function at(
  trimStartMs: number,
  trimEndMs: number,
  fractions: Array<[number, number]>,
): SpeedPoint[] {
  const span = trimEndMs - trimStartMs;
  return fractions.map(([fraction, v]) => ({
    t: trimStartMs + span * fraction,
    v,
  }));
}

export const SPEED_CURVE_PRESETS: SpeedPreset[] = [
  { id: "constant", label: "setting.speed_ramp_constant", build: () => null },
  {
    id: "rampUp",
    label: "setting.speed_ramp_up",
    build: (from, to) =>
      at(from, to, [
        [0, 1],
        [1, 2],
      ]),
  },
  {
    id: "rampDown",
    label: "setting.speed_ramp_down",
    build: (from, to) =>
      at(from, to, [
        [0, 2],
        [1, 1],
      ]),
  },
  {
    id: "slowMiddle",
    label: "setting.speed_ramp_slow_middle",
    build: (from, to) =>
      at(from, to, [
        [0, 1],
        [0.35, 0.25],
        [0.65, 0.25],
        [1, 1],
      ]),
  },
  {
    id: "fastMiddle",
    label: "setting.speed_ramp_fast_middle",
    build: (from, to) =>
      at(from, to, [
        [0, 1],
        [0.35, 4],
        [0.65, 4],
        [1, 1],
      ]),
  },
  {
    id: "easeIn",
    label: "setting.speed_ramp_ease_in",
    build: (from, to) =>
      // Five points approximating a smooth acceleration. The curve between them
      // is linear, so the integral stays closed form and exact.
      at(from, to, [
        [0, 1],
        [0.25, 1.15],
        [0.5, 1.6],
        [0.75, 2.4],
        [1, 3],
      ]),
  },
  {
    id: "easeOut",
    label: "setting.speed_ramp_ease_out",
    build: (from, to) =>
      at(from, to, [
        [0, 3],
        [0.25, 2.4],
        [0.5, 1.6],
        [0.75, 1.15],
        [1, 1],
      ]),
  },
];
