/**
 * On-screen annotation: pen strokes and click ripples, as geometry.
 *
 * Both are recorded as **events, not pixels**. A stroke is the list of points
 * the pointer visited; a click is one instant and one place. Nothing is
 * rasterised until the composite pass, and that is what makes annotation
 * survive the auto-zoom: a line drawn at 1× and then zoomed 2× would be a
 * two-pixel-wide blur if it had been burned into the capture, and is a crisp
 * line when it is re-stroked at the zoomed transform instead.
 *
 * It also means the overlay window can draw the live preview from the same data
 * with the same functions, so what the user sees while drawing is what lands in
 * the file.
 *
 * Coordinates are **frame pixels of the screen capture**. The overlay works in
 * CSS pixels and converts on the way in; doing it the other way round would put
 * a display's scale factor into the recorded data, where it would be wrong the
 * moment the file is opened anywhere else.
 *
 * Pure geometry, DOM-free.
 */

export type StrokePoint = { t: number; x: number; y: number };

export type Stroke = {
  id: string;
  color: string;
  /** Line width in frame pixels, before any zoom. */
  width: number;
  points: StrokePoint[];
};

export type ClickMark = { t: number; x: number; y: number };

/** How long a finished stroke stays at full opacity before it starts to go. */
export const STROKE_HOLD_MS = 2_500;

/** ...and how long it takes to go. */
export const STROKE_FADE_MS = 900;

/** A click ripple's whole life. Short: it is punctuation, not annotation. */
export const RIPPLE_MS = 550;

/** The ripple's final radius, in frame pixels at 1×. */
export const RIPPLE_MAX_RADIUS = 44;

function lastPointTime(stroke: Stroke): number {
  const points = stroke.points;
  return points.length > 0 ? points[points.length - 1].t : 0;
}

/**
 * How visible a stroke is at `tMs`.
 *
 * Zero before it was started, one while it is being drawn and for
 * `STROKE_HOLD_MS` after, then eased to nothing. Strokes fade rather than
 * vanishing on a timer because a hard cut draws the eye to the disappearance,
 * which is precisely where the attention should not be by then.
 *
 * Linear, not smoothstep. A fade is a change in a quantity nobody is tracking
 * frame to frame, and the eased version is indistinguishable from it — this is
 * not `zoomPlan.ts`, where the eye is following the motion itself.
 */
export function strokeAlphaAt(stroke: Stroke, tMs: number): number {
  if (stroke.points.length === 0 || !Number.isFinite(tMs)) {
    return 0;
  }

  const start = stroke.points[0].t;
  if (tMs < start) {
    return 0;
  }

  const fadeStart = lastPointTime(stroke) + STROKE_HOLD_MS;
  if (tMs <= fadeStart) {
    return 1;
  }

  const progress = (tMs - fadeStart) / STROKE_FADE_MS;
  return progress >= 1 ? 0 : 1 - progress;
}

/**
 * The part of a stroke that has been drawn by `tMs`.
 *
 * A stroke appears as it was made rather than all at once — the viewer watches
 * the line arrive, which is the only reason to draw on a recording at all. The
 * points carry their own timestamps, so this is a prefix, not an interpolation.
 */
export function strokePrefix(stroke: Stroke, tMs: number): StrokePoint[] {
  const drawn = stroke.points.filter((point) => point.t <= tMs);

  // One point is not a line, but it is a dot, and a tap should leave one.
  return drawn;
}

/** Strokes with anything to show at `tMs`, with the opacity to show them at. */
export function visibleStrokes(
  strokes: readonly Stroke[],
  tMs: number,
): { stroke: Stroke; alpha: number; points: StrokePoint[] }[] {
  const visible: { stroke: Stroke; alpha: number; points: StrokePoint[] }[] = [];

  for (const stroke of strokes) {
    const alpha = strokeAlphaAt(stroke, tMs);
    if (alpha <= 0) {
      continue;
    }
    const points = strokePrefix(stroke, tMs);
    if (points.length === 0) {
      continue;
    }
    visible.push({ stroke, alpha, points });
  }

  return visible;
}

/**
 * A click's ripple at `tMs`, or `null` once it is over.
 *
 * Radius eases out and opacity falls linearly, which is the combination that
 * reads as "something happened here" rather than as an expanding disc. The
 * radius is in 1× frame pixels: the composite pass draws it under the zoom
 * transform, so a ripple inside a 2× zoom is twice as large on screen, the same
 * as the thing that was clicked.
 */
export function rippleAt(
  click: ClickMark,
  tMs: number,
): { radius: number; alpha: number } | null {
  if (!Number.isFinite(tMs) || tMs < click.t || tMs >= click.t + RIPPLE_MS) {
    return null;
  }

  const progress = (tMs - click.t) / RIPPLE_MS;

  return {
    radius: RIPPLE_MAX_RADIUS * (1 - (1 - progress) * (1 - progress)),
    alpha: 1 - progress,
  };
}

/**
 * Perpendicular distance from `point` to the segment `a`–`b`.
 *
 * Segment, not the infinite line: for a stroke that doubles back, the line
 * through the endpoints can pass arbitrarily close to a point the segment is
 * nowhere near, and simplification would eat the fold.
 */
function distanceToSegment(
  point: StrokePoint,
  a: StrokePoint,
  b: StrokePoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }

  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );

  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker: drop the points that were never doing anything.
 *
 * A pointer event stream is 100+ samples a second, most of them a pixel apart
 * on a straight run. Keeping them all costs nothing to draw but a great deal to
 * store and to transport over IPC, and the extra vertices make the Catmull-Rom
 * pass below wobble — it interpolates *through* every point it is given, so
 * sampling noise becomes visible waviness in the line.
 *
 * Endpoints are always kept, so a simplified stroke starts and ends exactly
 * where the pointer did.
 */
export function simplifyStroke(
  points: readonly StrokePoint[],
  tolerance = 1.2,
): StrokePoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const first = points[0];
  const last = points[points.length - 1];

  let worstIndex = 0;
  let worstDistance = 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(points[index], first, last);
    if (distance > worstDistance) {
      worstIndex = index;
      worstDistance = distance;
    }
  }

  if (worstDistance <= tolerance) {
    return [first, last];
  }

  const left = simplifyStroke(points.slice(0, worstIndex + 1), tolerance);
  const right = simplifyStroke(points.slice(worstIndex), tolerance);

  // `worstIndex` is in both halves; drop the duplicate.
  return left.slice(0, -1).concat(right);
}

export type Cubic = {
  from: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  to: { x: number; y: number };
};

/**
 * A stroke as cubic bezier segments, through every point.
 *
 * Catmull-Rom converted to Bezier: for a segment `p1 -> p2`, the control points
 * are `p1 + (p2 - p0)/6` and `p2 - (p3 - p1)/6`. The ends are handled by
 * duplicating the terminal points, which gives the curve zero curvature there
 * rather than an invented flick.
 *
 * Cubics rather than a polyline for the same reason `features/mask/geometry.ts`
 * uses them: an affine transform maps a cubic's control points exactly, so the
 * curve survives the zoom transform with nothing re-approximated. A polyline
 * would be fine too — but then the composite pass would need enough segments
 * for the *most* zoomed-in moment at every moment.
 */
export function strokeCubics(points: readonly StrokePoint[]): Cubic[] {
  if (points.length < 2) {
    return [];
  }

  const at = (index: number) =>
    points[Math.max(0, Math.min(points.length - 1, index))];

  const cubics: Cubic[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);

    cubics.push({
      from: { x: p1.x, y: p1.y },
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      to: { x: p2.x, y: p2.y },
    });
  }

  return cubics;
}
