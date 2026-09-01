/**
 * The arithmetic a mask path is built out of.
 *
 * One representation carries the whole pipeline: a **closed list of
 * `MaskNode`s**, anchors absolute and handles stored as offsets from their
 * anchor. Templates are authored in it, corner rounding rewrites it, placement
 * scales and rotates it, and the device mapping runs it through a `Mat`. Only
 * `draw.ts` ever turns it into canvas calls.
 *
 * **Everything is cubic**, including a straight edge — a segment whose two
 * handles are absent is the cubic whose control points sit on its endpoints,
 * which is exactly a line. That uniformity is what makes the affine step below
 * correct without a case analysis: an affine matrix maps a cubic's four control
 * points to the four control points of the transformed cubic, exactly, so a
 * rotated or stretched path is the same curve seen from somewhere else and not
 * an approximation of it. An `arcTo` or a `roundRect` in the middle of this
 * would not survive a non-uniform scale, which is why corner rounding produces
 * beziers rather than arcs (`round.ts`).
 *
 * DOM-free, so the whole geometry is node-testable without a canvas.
 */

import type { MaskNode } from "../../@types/timeline";
import { applyPoint, applyVector, type Mat, type Point } from "../timeline/transform";

export type { Point };

/** A cubic from `from` to `to`. What `draw.ts` and the bounds maths consume. */
export type CubicSegment = {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
};

export type Box = { width: number; height: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** The absolute position of a node's outgoing control point. */
export function outControlOf(node: MaskNode): Point {
  return { x: node.p[0] + (node.ce?.[0] ?? 0), y: node.p[1] + (node.ce?.[1] ?? 0) };
}

/** The absolute position of a node's incoming control point. */
export function inControlOf(node: MaskNode): Point {
  return { x: node.p[0] + (node.cs?.[0] ?? 0), y: node.p[1] + (node.cs?.[1] ?? 0) };
}

/** Whether a node has neither handle — the definition of a corner. */
export function isCorner(node: MaskNode): boolean {
  return node.cs === undefined && node.ce === undefined;
}

/**
 * Whether the segment from `a` to `b` is a straight line.
 *
 * Only the two handles that *face along it* matter: `a`'s outgoing and `b`'s
 * incoming. A node can be a cusp — a corner on one side and curved on the other
 * — and this has to answer per side, which is what `round.ts` needs in order to
 * trim along an edge that really is an edge.
 */
export function isStraight(a: MaskNode, b: MaskNode): boolean {
  return a.ce === undefined && b.cs === undefined;
}

/**
 * The closed path as segments, one per edge, wrapping from the last node back
 * to the first.
 *
 * A single node yields nothing: there is no edge, and emitting a degenerate
 * self-segment would put a stray `bezierCurveTo` in front of `closePath` and
 * paint a dot.
 */
export function segmentsOf(nodes: readonly MaskNode[]): CubicSegment[] {
  if (nodes.length < 2) {
    return [];
  }
  const out: CubicSegment[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    out.push({
      from: { x: a.p[0], y: a.p[1] },
      c1: outControlOf(a),
      c2: inControlOf(b),
      to: { x: b.p[0], y: b.p[1] },
    });
  }
  return out;
}

// ------------------------------------------------------------------- bounds

/** The two roots of `at² + bt + c`, whichever are real and inside `(0, 1)`. */
function interiorRoots(a: number, b: number, c: number): number[] {
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) {
      const t = -c / b;
      if (t > 0 && t < 1) {
        out.push(t);
      }
    }
    return out;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return out;
  }
  const root = Math.sqrt(discriminant);
  for (const t of [(-b + root) / (2 * a), (-b - root) / (2 * a)]) {
    if (t > 0 && t < 1) {
      out.push(t);
    }
  }
  return out;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * The extremes of one cubic coordinate, endpoints and turning points alike.
 *
 * The turning points are what make this more than a scan of the control
 * polygon. A bezier is contained by its control points, so the hull is a
 * *bound* — but it is a loose one, and for the heart it is loose by enough that
 * normalising the template against it would leave the shape visibly not filling
 * the box it claims to. Solving the derivative gives the real extent.
 */
function axisExtent(p0: number, p1: number, p2: number, p3: number): [number, number] {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  // d/dt of the cubic, as `at² + bt + c` with the shared factor 3 divided out.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  for (const t of interiorRoots(a, b, c)) {
    const value = cubicAt(p0, p1, p2, p3, t);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/**
 * The true bounding box of the closed path — the curve's, not its hull's.
 *
 * Used twice, and it has to be the same answer both times: to normalise the
 * built-in templates onto the unit square at module load, and to derive the box
 * a freshly drawn pen path is expressed in. If those disagreed, a pen mask and
 * a built-in one of the same nominal size would not be the same size.
 */
export function boundsOf(nodes: readonly MaskNode[]): Bounds | null {
  if (nodes.length === 0) {
    return null;
  }
  if (nodes.length === 1) {
    const [x, y] = nodes[0].p;
    return { minX: x, minY: y, maxX: x, maxY: y };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const segment of segmentsOf(nodes)) {
    const [x0, x1] = axisExtent(segment.from.x, segment.c1.x, segment.c2.x, segment.to.x);
    const [y0, y1] = axisExtent(segment.from.y, segment.c1.y, segment.c2.y, segment.to.y);
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  }

  return { minX, minY, maxX, maxY };
}

// --------------------------------------------------------------- transforms

/**
 * Every node through `m`.
 *
 * Anchors go through `applyPoint` and handles through `applyVector`, and the
 * difference is the whole correctness of it: a handle is an *offset*, so
 * sending it through `applyPoint` would add the translation a second time and
 * bow every curve towards the origin by the mask's own position.
 *
 * A handle that was absent stays absent, so a corner stays a corner through any
 * transform and `round.ts` keeps agreeing with itself about what it may round.
 */
export function transformNodes(nodes: readonly MaskNode[], m: Mat): MaskNode[] {
  return nodes.map((node) => {
    const p = applyPoint(m, { x: node.p[0], y: node.p[1] });
    const out: MaskNode = { p: [p.x, p.y] };
    if (node.cs !== undefined) {
      const v = applyVector(m, { x: node.cs[0], y: node.cs[1] });
      out.cs = [v.x, v.y];
    }
    if (node.ce !== undefined) {
      const v = applyVector(m, { x: node.ce[0], y: node.ce[1] });
      out.ce = [v.x, v.y];
    }
    return out;
  });
}

/** Scale about the origin, one factor per axis. */
export function scaleMat(sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Rotate about the origin, degrees, clockwise in a y-down space. */
export function rotateMat(degrees: number): Mat {
  const theta = (degrees * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function translateMat(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}
