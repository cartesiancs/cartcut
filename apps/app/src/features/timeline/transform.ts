/**
 * Element transforms, as matrices.
 *
 * This is the single definition of where an element sits. `applyElementTransform`
 * in `features/renderer/element.ts` used to *be* that definition, expressed as a
 * sequence of `ctx.translate/rotate/scale` calls — which meant nothing else could
 * ask the question without reimplementing it. `previewCanvas.collisionCheck` did
 * reimplement it, by hand, for rotation only; the header of
 * `features/preview/elementPosition.ts` documents what that divergence cost.
 *
 * So the ctx sequence moved here and became a matrix, and the renderer became a
 * one-line wrapper around it. Drawing and hit-testing can no longer disagree,
 * because they cannot ask separately.
 *
 * The second thing this file adds is the parent chain. A child's `location` and
 * its `position` keyframes are coordinates **in its parent's space**, so the
 * matrix that puts it on the canvas is the product of every ancestor's matrix
 * with its own. That is the whole of the group feature: move a group and its
 * children follow, with not one keyframe rewritten.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { sampleBaked } from "../animation/keyframes";
import { toRadian } from "../math/geom";
import { MAX_GROUP_DEPTH, parentOf } from "./hierarchy";

/**
 * A 2D affine transform, in the canvas `transform(a, b, c, d, e, f)` order:
 *
 * ```
 * | a c e |
 * | b d f |
 * | 0 0 1 |
 * ```
 */
export type Mat = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

export type Point = { x: number; y: number };

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** `m` then `n`, i.e. the matrix product `m · n`. Apply `n` to a point first. */
export function multiply(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/**
 * The inverse, or `IDENTITY` when the matrix is singular.
 *
 * A zero determinant means a scale of 0, which the scale track can reach — an
 * element scaled to nothing. Refusing to throw keeps hit-testing well defined
 * there: the element covers no pixels, so no point is inside it, and returning
 * identity makes the caller test the pointer against an untransformed rect that
 * it will simply miss.
 */
export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) {
    return IDENTITY;
  }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** A point through `m`, translation included. */
export function applyPoint(m: Mat, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

/**
 * A *vector* through `m` — the linear part only, no translation.
 *
 * This is what a drag delta needs. Sending a delta through `applyPoint` adds the
 * translation twice, which puts the element at roughly double the offset the
 * pointer moved and is the classic way a parented drag runs away from the mouse.
 */
export function applyVector(m: Mat, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/**
 * The uniform scale factor `m` applies.
 *
 * Screen-space quantities — grab radii, handle sizes, outline widths — have to
 * be divided by this to stay the size the user sees. Without it, a child inside
 * a group scaled to 25% has handles a quarter of their intended size and becomes
 * effectively ungrabbable.
 *
 * The column norm rather than `sqrt(|det|)`, so a mirrored transform (negative
 * determinant) still reports a positive scale.
 */
export function scaleOf(m: Mat): number {
  return Math.hypot(m.a, m.b) || 1;
}

/** The rotation `m` applies, in degrees. */
export function rotationOf(m: Mat): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

// ------------------------------------------------------------- local sampling

/** An element's own transform values at a cursor, animation resolved. */
export type LocalSample = {
  x: number;
  y: number;
  rotationDeg: number;
  /** 1 is unscaled. The track stores tenths, so this is `track / 10`. */
  scale: number;
  /** 0..100, matching the element field. */
  opacity: number;
};

function isFinite2(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Sample one track the way the renderer does.
 *
 * Gated on `isActivate`, and on the cursor having reached the element, exactly
 * as `interpolate` is. Kept local rather than importing `interpolate` so that
 * the `track == null` case — a GIF, an audio clip, a shape asked for `scale` —
 * is handled in one place instead of at every call site.
 */
function track(
  element: any,
  property: string,
  lane: "ax" | "ay",
  fallback: number,
  cursor: number,
): number {
  const animation = element?.animation;
  if (animation == null) {
    return fallback;
  }
  const found = animation[property];
  if (found == null || found.isActivate !== true) {
    return fallback;
  }
  const baked = found[lane];
  if (!Array.isArray(baked)) {
    return fallback;
  }
  const startTime = element.startTime;
  if (!isFinite2(startTime) || !isFinite2(cursor) || cursor < startTime) {
    return fallback;
  }
  return sampleBaked(baked, cursor - startTime, fallback);
}

/**
 * The element's own transform at `cursor`, before any parent is applied.
 *
 * `scale` seeds at 10 rather than 1 because there is no static scale field on
 * the element type — an unscaled element is one whose scale track is off, and
 * the track itself stores tenths. `keyframeOps.staticValueOf` encodes the same
 * constant for the same reason.
 */
export function localSampleAt(
  element: TimelineElement | null | undefined,
  cursor: number,
): LocalSample {
  const any = element as any;
  if (any == null) {
    return { x: 0, y: 0, rotationDeg: 0, scale: 1, opacity: 100 };
  }

  const staticX = any.location?.x ?? 0;
  const staticY = any.location?.y ?? 0;

  return {
    x: track(any, "position", "ax", staticX, cursor),
    y: track(any, "position", "ay", staticY, cursor),
    rotationDeg: track(any, "rotation", "ax", any.rotation ?? 0, cursor),
    scale: track(any, "scale", "ax", 10, cursor) / 10,
    opacity: track(any, "opacity", "ax", any.opacity ?? 100, cursor),
  };
}

/**
 * The element's own transform as a matrix.
 *
 * Equal, to the bit, to the sequence `applyElementTransform` used to run:
 *
 * ```
 * translate(x, y)
 * translate(cx, cy) → rotate(θ) → translate(-cx, -cy)
 * translate(cx, cy) → scale(s, s) → translate(-cx, -cy)
 * ```
 *
 * The inner `translate(-cx, -cy) · translate(cx, cy)` cancels, leaving
 * `T(x, y) · T(cx, cy) · R(θ) · S(s) · T(-cx, -cy)` — rotate and scale about the
 * element's centre, then place its top-left at `(x, y)`.
 *
 * `transform.test.ts` pins the equality against a recording context rather than
 * trusting this comment.
 */
export function localMatrixOf(
  element: TimelineElement | null | undefined,
  cursor: number,
): Mat {
  const any = element as any;
  const sample = localSampleAt(element, cursor);

  const cx = (any?.width ?? 0) / 2;
  const cy = (any?.height ?? 0) / 2;

  const theta = toRadian(sample.rotationDeg);
  const s = sample.scale;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const a = s * cos;
  const b = s * sin;
  const c = -s * sin;
  const d = s * cos;

  return {
    a,
    b,
    c,
    d,
    // The centre is a fixed point of `R · S`, so the translation is whatever
    // puts it back where `T(x, y)` wants it.
    e: sample.x + cx - (a * cx + c * cy),
    f: sample.y + cy - (b * cx + d * cy),
  };
}

// ------------------------------------------------------------- world assembly

/**
 * Per-frame cache of resolved world matrices.
 *
 * Shared by every element in one `renderTimelineAtTime` call and thrown away
 * after it: the values depend on the cursor, so a cache that outlived the frame
 * would be wrong on the next one. With it, resolving every element's chain is
 * O(n) rather than O(n · depth).
 */
export type TransformMemo = Map<string, Mat>;

export function createMemo(): TransformMemo {
  return new Map();
}

/**
 * The full chain from the canvas down to and including `elementId`.
 *
 * Walks up to the root and multiplies down, so an ancestor resolved for one
 * child is reused for its siblings through `memo`. `parentOf` already refuses a
 * parent that is missing, is not a group, or would close a cycle, and the depth
 * cap here is a second backstop for a document that never went through
 * `repairHierarchy` — a render path must not be able to hang on bad data.
 */
export function worldMatrixOf(
  elements: Timeline,
  elementId: string,
  cursor: number,
  memo?: TransformMemo,
): Mat {
  const cached = memo?.get(elementId);
  if (cached != null) {
    return cached;
  }

  const element = elements[elementId];
  if (element == null) {
    return IDENTITY;
  }

  // Collect the chain child-first, then multiply root-first.
  const chain: string[] = [];
  let cursorId: string | null = elementId;
  let inherited: Mat | null = null;
  const seen = new Set<string>();

  while (cursorId != null && chain.length <= MAX_GROUP_DEPTH) {
    if (seen.has(cursorId)) {
      break;
    }
    seen.add(cursorId);
    chain.push(cursorId);

    const parentId: string | null = parentOf(elements, cursorId);
    if (parentId == null) {
      break;
    }
    const hit = memo?.get(parentId);
    if (hit != null) {
      // An ancestor is already resolved; everything above it is folded in.
      inherited = hit;
      break;
    }
    cursorId = parentId;
  }

  let acc = inherited ?? IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i];
    acc = multiply(acc, localMatrixOf(elements[id], cursor));
    memo?.set(id, acc);
  }

  return acc;
}

/**
 * The chain *above* `elementId` — the space its `location` is expressed in.
 *
 * This is the matrix a drag has to invert to turn a pointer position into the
 * value that belongs in `location` or in a position keyframe.
 */
export function parentMatrixOf(
  elements: Timeline,
  elementId: string,
  cursor: number,
  memo?: TransformMemo,
): Mat {
  const parentId = parentOf(elements, elementId);
  if (parentId == null) {
    return IDENTITY;
  }
  return worldMatrixOf(elements, parentId, cursor, memo);
}

/**
 * The product of every *ancestor's* opacity, as a 0..1 multiplier.
 *
 * Excludes the element's own opacity, which `renderElement` applies separately —
 * it already multiplies onto `ctx.globalAlpha`, so the two compose without
 * either knowing about the other.
 *
 * Unlike position, scale and rotation, opacity inheritance is a group
 * convention rather than an After Effects one: AE parenting deliberately does
 * not pass opacity down. Groups here do, so that fading a group fades what is
 * in it — the behaviour the name leads a user to expect.
 */
export function inheritedOpacityOf(
  elements: Timeline,
  elementId: string,
  cursor: number,
): number {
  let alpha = 1;
  let id: string | null = parentOf(elements, elementId);
  let depth = 0;
  const seen = new Set<string>();

  while (id != null && depth <= MAX_GROUP_DEPTH) {
    if (seen.has(id)) {
      break;
    }
    seen.add(id);
    alpha *= clamp01(localSampleAt(elements[id], cursor).opacity / 100);
    id = parentOf(elements, id);
    depth++;
  }

  return alpha;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// --------------------------------------------------------- space conversions

/** A canvas point as a value fit to write into the element's `location`. */
export function worldToParentLocal(
  elements: Timeline,
  elementId: string,
  cursor: number,
  point: Point,
  memo?: TransformMemo,
): Point {
  return applyPoint(
    invert(parentMatrixOf(elements, elementId, cursor, memo)),
    point,
  );
}

/** The inverse: an element's authored `location` as a canvas point. */
export function parentLocalToWorld(
  elements: Timeline,
  elementId: string,
  cursor: number,
  point: Point,
  memo?: TransformMemo,
): Point {
  return applyPoint(parentMatrixOf(elements, elementId, cursor, memo), point);
}

/** A canvas-space drag delta as a delta in the element's parent space. */
export function worldVectorToParentLocal(
  elements: Timeline,
  elementId: string,
  cursor: number,
  delta: Point,
  memo?: TransformMemo,
): Point {
  return applyVector(
    invert(parentMatrixOf(elements, elementId, cursor, memo)),
    delta,
  );
}

/**
 * The element's four corners on the canvas, in TL, TR, BR, BL order.
 *
 * For hit-testing bounds, selection chrome and snap guides, all of which need
 * the real quadrilateral rather than the axis-aligned rect the element would
 * occupy unrotated.
 */
export function worldCornersOf(
  elements: Timeline,
  elementId: string,
  cursor: number,
  memo?: TransformMemo,
): [Point, Point, Point, Point] {
  const element = elements[elementId] as any;
  const w = element?.width ?? 0;
  const h = element?.height ?? 0;
  const m = worldMatrixOf(elements, elementId, cursor, memo);
  return [
    applyPoint(m, { x: 0, y: 0 }),
    applyPoint(m, { x: w, y: 0 }),
    applyPoint(m, { x: w, y: h }),
    applyPoint(m, { x: 0, y: h }),
  ];
}

/** The axis-aligned bounding box of `worldCornersOf`. */
export function worldBoundsOf(
  elements: Timeline,
  elementId: string,
  cursor: number,
  memo?: TransformMemo,
): { x: number; y: number; w: number; h: number } {
  const corners = worldCornersOf(elements, elementId, cursor, memo);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
}
