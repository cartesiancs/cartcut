/**
 * A shape's outline, generated from its recipe.
 *
 * Everything here is authored in the **unit square `[-0.5, 0.5]²`** and mapped
 * into a box by `outlineInBox`, which is the arrangement `features/mask/` uses
 * and for the same reason: it lets one recipe mean the same thing at any size,
 * and it is what makes switching a shape from polygon to star keep it the size
 * it was rather than shrinking it by however much empty room a star's
 * circumscribed circle happens to leave.
 *
 * Two rules hold the whole module together.
 *
 * **Everything is a cubic, and a corner is a node with no handles.** That is
 * `features/mask/geometry.ts`'s model, unchanged, and it is what lets
 * `round.ts` round a rectangle, a polygon and a star with no shape name
 * appearing in it: a rectangle is four corners, a star is `2n`, and an
 * ellipse's four nodes all carry handles, so rounding an ellipse correctly does
 * nothing at all.
 *
 * **Every subpath is wound clockwise**, except a hole, which is wound the other
 * way. Two things rest on that. A hole fills as a hole under the default
 * nonzero rule with nobody asking for `"evenodd"`. And per-corner radii are
 * addressed by index, so "the top left corner" is only answerable if the
 * generator's winding is a rule rather than a coincidence of each kind.
 *
 * No memo. Every list is freshly built on every call, which is the contract
 * `mask/templates.ts#templateNodes` states: a shared node list handed to
 * `round.ts` or to a placement step is one a caller that mutated in place could
 * use to rewrite the shape for every clip in the project. The generation is a
 * few dozen objects of arithmetic, and the paint loop calls it once per shape
 * per frame.
 *
 * DOM-free, so the whole thing is node-testable without a canvas.
 */

import type {
  CornerRadii,
  PathNode,
  ShapeGeometry,
  ShapeGeometryKind,
} from "../../@types/timeline";
import { boundsOf, scaleMat, translateMat, transformNodes } from "../mask/geometry";
import { normalized } from "../mask/templates";
import { multiply } from "../timeline/transform";

/** A box in the element's own space, with its top left at the origin. */
export type OutlineBox = { width: number; height: number };

/** How many straight segments a full turn becomes in `flattenOutline`. */
export const ELLIPSE_FLATTEN_SEGMENTS = 50;

/** The bounds of `count`, matching Figma's own polygon and star limits. */
export const MIN_SHAPE_COUNT = 3;
export const MAX_SHAPE_COUNT = 60;

/** Points a `polygon` has when its recipe does not say. */
export const DEFAULT_POLYGON_COUNT = 3;
/** Points a `star` has when its recipe does not say. */
export const DEFAULT_STAR_COUNT = 5;

/** Nothing an arc can be shorter than, in degrees, before it stops being one. */
const MIN_ARC_SWEEP = 0.01;

/** No arc segment spans more than this, which is where a cubic stays accurate. */
const MAX_ARC_SEGMENT = Math.PI / 2;

/**
 * The inner radius a star gets when its recipe does not name one.
 *
 * `cos(2π/n) / cos(π/n)` is the ratio at which the two edges meeting at a point
 * are **collinear across it**, so the star is the `{n/2}` star polygon and the
 * points do not visibly bend. At `n = 5` it is exactly `1/φ²`, the constant
 * `mask/templates.ts` names, which is what lets the two stars be pinned equal.
 *
 * Below five it is zero or negative: a triangle and a square have no `{n/2}`
 * star, so there is no collinear ratio to find and a plain half is the only
 * sensible answer.
 */
export function starInnerRatioFor(count: number): number {
  const n = clampCount(count);
  if (n < 5) {
    return 0.5;
  }
  return Math.cos((2 * Math.PI) / n) / Math.cos(Math.PI / n);
}

function clampCount(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  if (!Number.isFinite(n)) {
    return MIN_SHAPE_COUNT;
  }
  return Math.min(MAX_SHAPE_COUNT, Math.max(MIN_SHAPE_COUNT, n));
}

/** The points a kind has, resolved from the recipe or from the kind's default. */
export function countOf(geometry: ShapeGeometry): number {
  const fallback =
    geometry.kind === "star" ? DEFAULT_STAR_COUNT : DEFAULT_POLYGON_COUNT;
  return clampCount(geometry.count ?? fallback);
}

/** The star's inner radius over its outer one, resolved. */
export function innerRatioOf(geometry: ShapeGeometry): number {
  const count = countOf(geometry);
  const raw = geometry.innerRatio;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return starInnerRatioFor(count);
  }
  return Math.min(1, Math.max(0, raw));
}

/** The ellipse's hole, as a fraction of its radius. 0 when there is none. */
export function holeOf(geometry: ShapeGeometry): number {
  const raw = geometry.hole;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.min(1, Math.max(0, raw));
}

/** The ellipse's wedge in radians, `{ start, sweep }`, a full turn by default. */
export function arcOf(geometry: ShapeGeometry): { start: number; sweep: number } {
  const raw = geometry.arc;
  const start = typeof raw?.start === "number" && Number.isFinite(raw.start) ? raw.start : 0;
  const sweep =
    typeof raw?.sweep === "number" && Number.isFinite(raw.sweep) ? raw.sweep : 360;
  const clamped = Math.min(360, Math.max(0, sweep));
  return {
    // Authored clockwise from 12 o'clock; the unit square is y-down, so a
    // quarter turn of `start` has to land the wedge on the right-hand side.
    start: (start * Math.PI) / 180 - Math.PI / 2,
    sweep: (clamped * Math.PI) / 180,
  };
}

/**
 * The four corner radii, in the order the generator emits its nodes.
 *
 * A bare number answers for every corner. The array form is Figma's, clockwise
 * from the top left, and it is passed straight through: the generators author
 * clockwise from the top left too, which is the whole reason that ordering can
 * be a contract rather than a comment.
 */
export function cornerRadiiOf(geometry: ShapeGeometry): CornerRadii {
  const raw = geometry.radius;
  if (Array.isArray(raw)) {
    return [finiteOrZero(raw[0]), finiteOrZero(raw[1]), finiteOrZero(raw[2]), finiteOrZero(raw[3])];
  }
  const one = finiteOrZero(raw);
  return [one, one, one, one];
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The radius to apply at each node index, for a shape with `nodeCount` nodes.
 *
 * Only a rectangle reads all four entries, because only a rectangle has four
 * corners to tell apart. Every other kind takes the first, which is what a
 * single-value `radius` collapses to anyway, so "one radius" and "four radii on
 * a polygon" mean the same thing rather than one of them meaning nothing.
 */
export function radiusAtOf(
  geometry: ShapeGeometry,
  nodeCount: number,
): (index: number) => number {
  const radii = cornerRadiiOf(geometry);
  if (geometry.kind === "rectangle" && nodeCount === 4) {
    return (index) => radii[index] ?? 0;
  }
  return () => radii[0];
}

// -------------------------------------------------------------- the generators

/** Four corners, clockwise from the top left. */
function rectangleNodes(): PathNode[] {
  return [
    { p: [-0.5, -0.5] },
    { p: [0.5, -0.5] },
    { p: [0.5, 0.5] },
    { p: [-0.5, 0.5] },
  ];
}

/**
 * `m` corners round a ring, first one straight up, **mirrored** across the
 * vertical axis rather than each computed from its own angle.
 *
 * Vertex `i` and vertex `m - i` are reflections of each other, and taking that
 * as the construction rather than as a consequence is what makes the symmetry
 * exact. Computed independently they are not: `Math.sin(30°)` and
 * `Math.sin(150°)` differ in the last place, so a triangle's two base corners
 * came out at different heights and its base sat 4e-14 off the bottom of its
 * box. That is a fraction of a pixel of antialiasing along one edge, which is
 * exactly enough to stop a generated triangle rendering identically to the
 * hand-written point list of the same triangle.
 *
 * The pairing works for the star too: `m` is even there, so `i` and `m - i`
 * always agree about whether they are an outer point or a notch.
 */
function radialRing(m: number, radiusOf: (index: number) => number): PathNode[] {
  const nodes: PathNode[] = new Array(m);
  for (let i = 0; i <= m / 2; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / m;
    const radius = radiusOf(i);
    // The vertices on the axis are written rather than computed. "The first
    // vertex is straight up" is the definition of the ring, but `Math.cos` of
    // `-π/2` is 6.1e-17 and not 0, so computing it puts the apex a hair off the
    // centre line and the whole fitted shape a hair off its box.
    const onAxis = i === 0 || (m % 2 === 0 && i === m / 2);
    const x = onAxis ? 0 : radius * Math.cos(angle);
    const y = onAxis ? (i === 0 ? -radius : radius) : radius * Math.sin(angle);
    nodes[i] = { p: [x, y] };
    const mirror = (m - i) % m;
    if (mirror !== i) {
      nodes[mirror] = { p: [-x, y] };
    }
  }
  return nodes;
}

/**
 * A regular `n`-gon, first vertex straight up, fitted to the unit square.
 *
 * Fitted rather than inscribed in the circle: a pentagon inscribed in a circle
 * leaves a band of nothing along the bottom of its box, and the box is what the
 * user resizes and what the selection outline draws. Figma fits too.
 */
function polygonNodes(count: number): PathNode[] {
  return normalized(radialRing(count, () => 0.5));
}

/** `2n` alternating corners, first point straight up, fitted to the unit square. */
function starNodes(count: number, innerRatio: number): PathNode[] {
  return normalized(
    radialRing(count * 2, (i) => (i % 2 === 0 ? 0.5 : 0.5 * innerRatio)),
  );
}

/**
 * A run of nodes along an elliptical arc of `radius`, centred on the origin.
 *
 * The ends are left as **corners** when the arc is open, because an open arc is
 * joined to something straight at both ends and a handle there would round a
 * junction the geometry says is sharp. A closed ring gets handles all the way
 * round and therefore rounds nowhere, which is why `radius` on a full ellipse
 * correctly does nothing.
 *
 * `4/3 * tan(Δ/4)` is the cubic approximation to an arc of sweep `Δ`, applied to
 * the tangent `(-rx sin θ, ry cos θ)` rather than to a circle's, so a stretched
 * ellipse is exact in the same way a stretched rounded corner is.
 */
function arcNodes(
  radius: number,
  start: number,
  sweep: number,
  closed: boolean,
): PathNode[] {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ARC_SEGMENT));
  const delta = sweep / steps;
  const k = (4 / 3) * Math.tan(delta / 4);

  const nodes: PathNode[] = [];
  // A closed ring must not repeat its first anchor as its last: `segmentsOf`
  // wraps, so the repeat would add a zero-length segment and, once rounded,
  // a visible nick.
  const last = closed ? steps - 1 : steps;

  for (let i = 0; i <= last; i++) {
    const angle = start + delta * i;
    const p: [number, number] = [
      radius * Math.cos(angle),
      radius * Math.sin(angle),
    ];
    const tangent: [number, number] = [
      -radius * Math.sin(angle) * k,
      radius * Math.cos(angle) * k,
    ];
    const node: PathNode = { p };
    if (closed || i > 0) {
      node.cs = [-tangent[0], -tangent[1]];
    }
    if (closed || i < steps) {
      node.ce = [tangent[0], tangent[1]];
    }
    nodes.push(node);
  }
  return nodes;
}

/** Reverse a subpath's direction, swapping each node's two handles with it. */
function reversed(nodes: readonly PathNode[]): PathNode[] {
  return nodes
    .slice()
    .reverse()
    .map((node) => {
      const out: PathNode = { p: [node.p[0], node.p[1]] };
      if (node.ce !== undefined) {
        out.cs = [node.ce[0], node.ce[1]];
      }
      if (node.cs !== undefined) {
        out.ce = [node.cs[0], node.cs[1]];
      }
      return out;
    });
}

/**
 * The ellipse, its wedge and its hole, as one or two subpaths.
 *
 * The **frame never moves**: a full ellipse fills the unit square by
 * construction and an arc is carved inside that same frame rather than being
 * refitted to its own extent. Refitting would resize the shape every time the
 * sweep slider moved, which is not what a sweep slider is for, and it is not
 * what Figma does either.
 */
function ellipseSubpaths(geometry: ShapeGeometry): PathNode[][] {
  const { start, sweep } = arcOf(geometry);
  const hole = holeOf(geometry);
  const full = sweep >= 2 * Math.PI - 1e-9;

  if (sweep < (MIN_ARC_SWEEP * Math.PI) / 180) {
    return [];
  }

  if (full) {
    const outer = arcNodes(0.5, start, 2 * Math.PI, true);
    if (hole <= 0) {
      return [outer];
    }
    return [outer, reversed(arcNodes(0.5 * hole, start, 2 * Math.PI, true))];
  }

  const outer = arcNodes(0.5, start, sweep, false);
  if (hole <= 0) {
    // A pie: the arc, then back to the centre.
    //
    // The centre is the only corner, and the only node `radius` can soften. The
    // two ends of the arc carry one handle each, so they are cusps rather than
    // corners, and rounding needs a straight edge on **both** sides anyway: the
    // junction between a line and a curve has no wedge to cut off.
    return [[...outer, { p: [0, 0] } as PathNode]];
  }
  // A ring segment: out along the outer arc, in along the inner one backwards.
  return [[...outer, ...reversed(arcNodes(0.5 * hole, start, sweep, false))]];
}

/**
 * The recipe's outline, in the unit square, as a list of closed subpaths.
 *
 * More than one subpath means a hole. Everything else answers with exactly one,
 * and an unusable recipe answers with none, which `renderShape` draws as
 * nothing at all rather than as a substituted rectangle: the contract a `pen`
 * mask with too few nodes already has.
 */
export function shapeOutlineNodes(geometry: ShapeGeometry): PathNode[][] {
  switch (geometry.kind) {
    case "rectangle":
      return [rectangleNodes()];
    case "polygon":
      return [polygonNodes(countOf(geometry))];
    case "star":
      return [starNodes(countOf(geometry), innerRatioOf(geometry))];
    case "ellipse":
      return ellipseSubpaths(geometry);
    default:
      return [];
  }
}

/** Unit square to a box whose top left is the origin. */
export function boxMatrix(box: OutlineBox) {
  return multiply(
    translateMat(box.width / 2, box.height / 2),
    scaleMat(box.width, box.height),
  );
}

/**
 * The recipe's outline, mapped into `box`.
 *
 * The renderer passes the **drawn** size and the mirror passes the authoring
 * one. Both are right because the mapping is linear in the box: a mirror built
 * against `oWidth`/`oHeight` and then multiplied by `shapeDrawScale` lands
 * exactly where an outline built against `width`/`height` does.
 */
export function outlineInBox(
  geometry: ShapeGeometry,
  box: OutlineBox,
): PathNode[][] {
  const m = boxMatrix(box);
  return shapeOutlineNodes(geometry).map((nodes) => transformNodes(nodes, m));
}

// ----------------------------------------------------------------- flattening

/**
 * The recipe's **outer boundary**, flattened to straight segments, in `box`.
 *
 * This is what `ShapeElementType.shape` holds beside a recipe, and the three
 * things it leaves out are the point of it:
 *
 *  - **the rounding**, so dragging the radius slider does not rewrite the point
 *    list once a frame, and so the vertex overlay keeps marking the corners the
 *    shape actually turns at;
 *  - **the hole**, because this is the outer boundary;
 *  - **nothing else**, so the three legacy kinds come out as the very point
 *    lists `shapePoints` has always produced, give or take the winding.
 *
 * A curve is flattened at `ELLIPSE_FLATTEN_SEGMENTS` to the turn, which is the
 * resolution `shapePoints("ellipse")` already used.
 */
export function flattenOutline(
  geometry: ShapeGeometry,
  box: OutlineBox,
): number[][] {
  const toBox = (x: number, y: number): number[] => [
    (x + 0.5) * box.width,
    (y + 0.5) * box.height,
  ];

  if (geometry.kind === "ellipse") {
    const { start, sweep } = arcOf(geometry);
    if (sweep < (MIN_ARC_SWEEP * Math.PI) / 180) {
      return [];
    }
    const full = sweep >= 2 * Math.PI - 1e-9;
    const step = (2 * Math.PI) / ELLIPSE_FLATTEN_SEGMENTS;
    const steps = full
      ? ELLIPSE_FLATTEN_SEGMENTS
      : Math.max(1, Math.ceil(sweep / step));

    // `rx + rx * cos(angle)`, and the angle as one division of `2πi`, because
    // that is `shapePoints("ellipse")`'s arithmetic to the association. Written
    // any other way the two agree to about 1e-13 and no further, and then a
    // circle that gains a recipe stops being byte-identical to the one every
    // existing project holds.
    const rx = box.width / 2;
    const ry = box.height / 2;
    const at = (angle: number): number[] => [
      rx + rx * Math.cos(angle),
      ry + ry * Math.sin(angle),
    ];

    const points: number[][] = [];
    // A full turn stops one short, or the last point repeats the first; an open
    // arc runs to its end and then adds the centre, closing the wedge.
    const last = full ? steps - 1 : steps;
    for (let i = 0; i <= last; i++) {
      // A closed ring has no start, so a full turn is flattened from 3 o'clock
      // whatever `arc.start` says, which is the phase the legacy list used.
      const angle = full
        ? (2 * Math.PI * i) / ELLIPSE_FLATTEN_SEGMENTS
        : start + (sweep / steps) * i;
      points.push(at(angle));
    }
    if (!full) {
      points.push([rx, ry]);
    }
    return points;
  }

  return shapeOutlineNodes(geometry).slice(0, 1).flatMap((nodes) =>
    nodes.map((node) => toBox(node.p[0], node.p[1])),
  );
}

/** Whether a kind reads `count`. The panel and `normalize` both ask. */
export function usesCount(kind: ShapeGeometryKind): boolean {
  return kind === "polygon" || kind === "star";
}

/** The true bounds of a recipe's outline in the unit square. Tests use it. */
export function outlineBounds(geometry: ShapeGeometry) {
  const all = shapeOutlineNodes(geometry).flat();
  return boundsOf(all);
}
