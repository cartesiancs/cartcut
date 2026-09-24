/**
 * Named easing curves, and how one lands on a pair of keyframes.
 *
 * The keyframe model has carried full cubic bezier handles from the start, and
 * `handleBounds.ts` deliberately leaves the **value** axis unconstrained
 * "because that is what makes overshoot and bounce easings expressible". What
 * was missing was any way to *write* one except by dragging in the curve
 * editor: `add_keyframes` took `{atMs, value}` and nothing else, so every move
 * an agent authored got the default symmetric handles — an ease-in-out with
 * zero velocity at both ends. That is the softest curve in the set, applied to
 * everything, which is most of why agent-made motion reads as floaty.
 *
 * Curves are written the way CSS writes them, as a normalised `(x1, y1, x2,
 * y2)` in a 0-1 box, and projected onto the segment's own span when applied.
 * Handles in this codebase live in **absolute** `[timeMs, value]` space, so the
 * projection is where a normalised curve becomes a real one.
 *
 * ## Which keyframe an easing belongs to
 *
 * `ce` is the handle *leaving* a keyframe and `cs` the one *arriving* at it, so
 * a segment's shape is set by the earlier keyframe's `ce` and the later one's
 * `cs`. An easing therefore describes **the segment leaving the keyframe it is
 * written on** — the same reading as CSS `transition-timing-function` and After
 * Effects' outgoing interpolation. The last keyframe has no segment after it,
 * so an easing on it is ignored rather than being an error: a caller applying
 * one curve to a whole list should not have to special-case the end.
 *
 * ## No `bounce`
 *
 * A bounce is not a cubic. It reverses direction several times, and a single
 * bezier segment is monotone in that sense — so offering one here would be a
 * curve that is not the thing it is named after. A bounce is authored as
 * several keyframes, which is what it is.
 */

/** A normalised curve in the 0-1 box, as `[x1, y1, x2, y2]`. */
export type CubicPoints = [number, number, number, number];

export type EasingName =
  | "linear"
  | "ease_in"
  | "ease_out"
  | "ease_in_out"
  | "snap"
  | "overshoot"
  | "anticipate";

/**
 * The curves, as CSS control points.
 *
 * The first four are CSS's own, so they behave the way anyone who has written a
 * transition expects. The last three are the ones that make motion read as
 * deliberate rather than drifting:
 *
 *  - `snap` leaves hard and settles: almost all of the distance is covered in
 *    the first third. This is the punch-in's curve.
 *  - `overshoot` passes the target and comes back — `y1 > 1` is what does it,
 *    and is exactly the case `handleBounds` refuses to clamp.
 *  - `anticipate` pulls back before it goes, `y1 < 0`. A move that winds up
 *    reads as intentional; the same move without it reads as a slide.
 */
const CURVES: Record<EasingName, CubicPoints> = {
  linear: [0, 0, 1, 1],
  ease_in: [0.42, 0, 1, 1],
  ease_out: [0, 0, 0.58, 1],
  ease_in_out: [0.42, 0, 0.58, 1],
  snap: [0.16, 1, 0.3, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, -0.56, 0.66, 1],
};

export function easingNames(): EasingName[] {
  return Object.keys(CURVES) as EasingName[];
}

function isFinitePair(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A name or a raw `[x1, y1, x2, y2]` as control points, or `null`.
 *
 * The raw form is the escape hatch: the named set is short on purpose, and a
 * caller that wants a curve nobody named should not have to pick the closest
 * one. `x` is clamped to 0-1 because a control point outside the segment in
 * *time* is not a curve — `bakeTrack` would clamp it anyway, and silently. `y`
 * is left alone, which is the whole point.
 */
export function resolveEasing(easing: unknown): CubicPoints | null {
  if (typeof easing === "string") {
    return CURVES[easing as EasingName] ?? null;
  }
  if (
    Array.isArray(easing) &&
    easing.length === 4 &&
    easing.every(isFinitePair)
  ) {
    const [x1, y1, x2, y2] = easing as CubicPoints;
    return [
      Math.max(0, Math.min(1, x1)),
      y1,
      Math.max(0, Math.min(1, x2)),
      y2,
    ];
  }
  return null;
}

/** One keyframe's anchor, as the projection needs it. */
export type Anchor = { atMs: number; value: number };

/**
 * A normalised curve projected onto the segment between two anchors.
 *
 * Returns the outgoing handle for `from` and the incoming handle for `to`, in
 * the absolute `[timeMs, value]` space the keyframes are stored in. A segment
 * whose two anchors hold the same value collapses the `y` term to zero, which
 * is correct: there is nothing to ease between.
 */
export function projectEasing(
  curve: CubicPoints,
  from: Anchor,
  to: Anchor,
): { ce: [number, number]; cs: [number, number] } {
  const [x1, y1, x2, y2] = curve;
  const spanMs = to.atMs - from.atMs;
  const spanValue = to.value - from.value;

  return {
    ce: [from.atMs + x1 * spanMs, from.value + y1 * spanValue],
    cs: [from.atMs + x2 * spanMs, from.value + y2 * spanValue],
  };
}

/**
 * Evaluate a CSS easing at `x`, in the unit square.
 *
 * A CSS `cubic-bezier(x1, y1, x2, y2)` is a curve from (0,0) to (1,1), so this
 * answers "how far along is the value when the time is `x`". Both axes are
 * clamped into `[0, 1]`, which is what a progress fraction always is; `y` is
 * deliberately *not* clamped, because `overshoot` and `anticipate` leave the
 * range on purpose and clamping them would flatten exactly the part that makes
 * them read.
 *
 * **The absolute-coordinate twin is `keyframes.ts#solveBezierU`,** and the two
 * are separate rather than duplicated by accident. That one inverts x over a
 * segment whose control abscissae are real times a user can drag anywhere, so
 * it carries a bracket and a bisection fallback for a plateau. This one runs on
 * the unit square where x is weakly monotonic by construction, and is called
 * once per unit per frame rather than once per baked sample.
 */
export function easeAt(curve: CubicPoints, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  const [x1, y1, x2, y2] = curve;

  // Linear, and the common case: `[0, 0, 1, 1]` is the identity curve.
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) {
    return t;
  }

  let lo = 0;
  let hi = 1;
  let u = t;

  for (let i = 0; i < 20; i++) {
    const at = unitBezier(x1, x2, u);
    const err = at - t;
    if (Math.abs(err) < 1e-6) {
      break;
    }
    if (err > 0) {
      hi = u;
    } else {
      lo = u;
    }
    const slope = unitBezierSlope(x1, x2, u);
    const next = slope > 1e-9 ? u - err / slope : Number.NaN;
    u = Number.isFinite(next) && next > lo && next < hi ? next : (lo + hi) / 2;
  }

  return unitBezier(y1, y2, u);
}

/** A cubic from 0 to 1 with control values `a` and `b`, at parameter `u`. */
function unitBezier(a: number, b: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
}

function unitBezierSlope(a: number, b: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * a + 6 * v * u * (b - a) + 3 * u * u * (1 - b);
}
