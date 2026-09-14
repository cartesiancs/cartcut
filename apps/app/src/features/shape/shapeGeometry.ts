/**
 * Reading and validating a shape's recipe.
 *
 * The same two-tempered split `mask/maskShape.ts`, `renderer/blend.ts` and
 * `renderer/adjust.ts` use, for the same reasons:
 *
 *  - **`shapeGeometryOf` guards reads.** It runs inside the paint loop, once
 *    per shape per frame, and must never throw. A hand-edited `timeline.json`,
 *    a field a newer build wrote, a `count` someone set to a string: all of them
 *    answer something drawable, or `null`, and the frame draws.
 *  - **`coerceShapeGeometry` validates writes.** It runs once, where a value
 *    arrives from the panel or from an agent, and reports what it will not take
 *    so the caller can say so. Past this point an unusable recipe is
 *    unrepresentable.
 *
 * The asymmetry between them is the one `maskShape.ts` states: a read defaults
 * an unreadable number, a write refuses it. A frame has to draw something, and
 * a star whose `count` is `NaN` is far better drawn with five points than not
 * drawn; a write is the only place a caller can be told it got something wrong.
 *
 * What a write **clamps** rather than refuses is a range that is a preference:
 * a `count` of 500 means "as many as it goes" and refusing it would be pedantry
 * about a slider's ceiling. What it refuses is a value that is not a number and
 * a key that names nothing, because both are mistakes.
 *
 * DOM-free and store-free, so it runs under `environment: "node"` beside the
 * pure ops that import it.
 */

import {
  SHAPE_GEOMETRY_KINDS,
  type CornerRadii,
  type ShapeGeometry,
  type ShapeGeometryKind,
  type TimelineElement,
} from "../../@types/timeline";
import {
  DEFAULT_POLYGON_COUNT,
  DEFAULT_STAR_COUNT,
  MAX_SHAPE_COUNT,
  MIN_SHAPE_COUNT,
  starInnerRatioFor,
  usesCount,
} from "./shapeOutline";

/** A set, not `includes`: this is asked once per shape per frame. */
const KNOWN_KINDS = new Set<string>(SHAPE_GEOMETRY_KINDS);

export type ShapeGeometryPatch = {
  kind?: ShapeGeometryKind;
  radius?: number | CornerRadii;
  count?: number;
  innerRatio?: number;
  arc?: { start: number; sweep: number };
  hole?: number;
};

export type ShapeGeometryResult =
  | { ok: true; geometry: ShapeGeometry }
  | { ok: false; error: string };

// ------------------------------------------------------------------- reading

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamped(value: unknown, fallback: number, lo: number, hi: number): number {
  const resolved = finiteOr(value, fallback);
  return resolved < lo ? lo : resolved > hi ? hi : resolved;
}

/** A radius entry: a non-negative finite number, or 0. */
function radiusValue(value: unknown): number {
  const n = finiteOr(value, 0);
  return n > 0 ? n : 0;
}

function readRadius(raw: unknown): number | CornerRadii | undefined {
  if (Array.isArray(raw)) {
    const four: CornerRadii = [
      radiusValue(raw[0]),
      radiusValue(raw[1]),
      radiusValue(raw[2]),
      radiusValue(raw[3]),
    ];
    if (four.every((n) => n === four[0])) {
      // Four equal corners are one radius. Canonicalising here rather than at
      // the panel is what keeps "set every corner to 8" and "set the radius to
      // 8" the same bytes, which the byte-identity claim needs.
      return four[0] === 0 ? undefined : four[0];
    }
    return four;
  }
  const one = radiusValue(raw);
  return one === 0 ? undefined : one;
}

/**
 * Drop every key the kind does not read, and every key already at its default.
 *
 * The canonical form, in the sense `normalizeAdjustments` means it: two equal
 * settings must stringify identically, or `sameShapeGeometry` has to know about
 * every way of spelling the same shape and a saved project carries inert
 * fields. Remembering a star's point count across a switch to rectangle is the
 * panel's job, not the document's.
 */
export function normalizeShapeGeometry(
  kind: ShapeGeometryKind,
  raw: Record<string, unknown> | null | undefined,
): ShapeGeometry {
  const source = raw ?? {};
  const out: ShapeGeometry = { kind };

  const radius = readRadius(source.radius);
  if (radius !== undefined) {
    out.radius = radius;
  }

  if (usesCount(kind)) {
    const fallback = kind === "star" ? DEFAULT_STAR_COUNT : DEFAULT_POLYGON_COUNT;
    const count = Math.round(
      clamped(source.count, fallback, MIN_SHAPE_COUNT, MAX_SHAPE_COUNT),
    );
    if (count !== fallback) {
      out.count = count;
    }
  }

  if (kind === "star") {
    const count = out.count ?? DEFAULT_STAR_COUNT;
    const fallback = starInnerRatioFor(count);
    const ratio = clamped(source.innerRatio, fallback, 0, 1);
    // Compared against the ratio this very count would default to, so a star
    // left alone carries no key however many points it has.
    if (Math.abs(ratio - fallback) > 1e-12) {
      out.innerRatio = ratio;
    }
  }

  if (kind === "ellipse") {
    const arc = source.arc as { start?: unknown; sweep?: unknown } | undefined;
    const start = ((finiteOr(arc?.start, 0) % 360) + 360) % 360;
    const sweep = clamped(arc?.sweep, 360, 0, 360);
    if (start !== 0 || sweep !== 360) {
      out.arc = { start, sweep };
    }
    const hole = clamped(source.hole, 0, 0, 1);
    if (hole !== 0) {
      out.hole = hole;
    }
  }

  return out;
}

/**
 * The recipe a shape element carries, or `null` for one that has none.
 *
 * `null` covers "no field", "not an object" and "a kind nobody knows" alike,
 * because all three render the same way: through `renderShape`'s own no-recipe
 * branch, off `element.shape`. That is the contract a LUT that is not installed
 * already has, and it is what keeps a project written by a newer build drawing
 * rather than throwing.
 */
export function shapeGeometryOf(
  element: TimelineElement | undefined | null,
): ShapeGeometry | null {
  const raw = (element as { geometry?: unknown } | undefined | null)?.geometry;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { kind } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) {
    return null;
  }
  return normalizeShapeGeometry(
    kind as ShapeGeometryKind,
    raw as Record<string, unknown>,
  );
}

// ------------------------------------------------------------------- writing

/** `undefined` passes (the field is optional); anything unreadable fails. */
function writtenNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function coerceShapeGeometryKind(value: unknown): ShapeGeometryKind | null {
  return typeof value === "string" && KNOWN_KINDS.has(value)
    ? (value as ShapeGeometryKind)
    : null;
}

/**
 * Validate a whole recipe, refusing what it cannot read.
 *
 * The radius array is the one shape-specific gate worth naming: it must be
 * **exactly four** numbers. Three is not a rectangle missing a corner, it is a
 * caller who thinks the order is something else, and quietly padding it would
 * put a radius on a corner nobody asked about.
 */
export function coerceShapeGeometry(value: unknown): ShapeGeometryResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A shape recipe must be an object." };
  }
  const raw = value as Record<string, unknown>;

  const kind = coerceShapeGeometryKind(raw.kind);
  if (kind == null) {
    return {
      ok: false,
      error: `Unknown shape kind. Known: ${SHAPE_GEOMETRY_KINDS.join(", ")}.`,
    };
  }

  if (raw.radius !== undefined) {
    if (Array.isArray(raw.radius)) {
      if (raw.radius.length !== 4 || !raw.radius.every(writtenNumber)) {
        return {
          ok: false,
          error: "A corner radius array must be four finite numbers, clockwise from the top left.",
        };
      }
    } else if (typeof raw.radius !== "number" || !Number.isFinite(raw.radius)) {
      return { ok: false, error: "The corner radius must be a finite number or four of them." };
    }
  }

  for (const key of ["count", "innerRatio", "hole"] as const) {
    if (!writtenNumber(raw[key])) {
      return { ok: false, error: `"${key}" must be a finite number.` };
    }
  }

  if (raw.arc !== undefined) {
    const arc = raw.arc as Record<string, unknown> | null;
    if (arc == null || typeof arc !== "object" || Array.isArray(arc)) {
      return { ok: false, error: '"arc" must be an object with `start` and `sweep`.' };
    }
    if (!writtenNumber(arc.start) || !writtenNumber(arc.sweep)) {
      return { ok: false, error: '"arc.start" and "arc.sweep" must be finite numbers.' };
    }
  }

  return { ok: true, geometry: normalizeShapeGeometry(kind, raw) };
}

/**
 * Merge a patch onto a recipe, then canonicalise.
 *
 * A patch keeps its zeros, the way `coerceAdjustPatch` does: "set the radius to
 * 0" is how a rounded corner is squared off, and it has to survive to the op.
 * What it drops is an unreadable number, and the op then declines if that left
 * nothing to do. The panel's spinners emit `NaN` mid-edit, and clamping one
 * into something plausible would commit a value the user never typed.
 */
export function mergeShapeGeometry(
  base: ShapeGeometry | null,
  patch: ShapeGeometryPatch,
): ShapeGeometry | null {
  const kind = patch.kind ?? base?.kind;
  if (kind == null) {
    return null;
  }

  const merged: Record<string, unknown> = { ...(base ?? {}), kind };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === "kind") {
      continue;
    }
    if (key === "arc") {
      const arc = value as { start?: unknown; sweep?: unknown };
      if (!writtenNumber(arc?.start) || !writtenNumber(arc?.sweep)) {
        continue;
      }
      const previous = (merged.arc ?? {}) as { start?: number; sweep?: number };
      merged.arc = {
        start: finiteOr(arc?.start, previous.start ?? 0),
        sweep: finiteOr(arc?.sweep, previous.sweep ?? 360),
      };
      continue;
    }
    if (key === "radius") {
      if (Array.isArray(value)) {
        if (value.length !== 4 || !value.every(writtenNumber)) {
          continue;
        }
      } else if (!writtenNumber(value) || value === undefined) {
        continue;
      }
      merged.radius = value;
      continue;
    }
    if (!writtenNumber(value)) {
      continue;
    }
    merged[key] = value;
  }

  return normalizeShapeGeometry(kind, merged);
}

/**
 * Whether two recipes describe the same outline.
 *
 * The ops layer needs this to hold its decline-by-identity contract: the panel
 * rebuilds the whole recipe on every change, so `!==` would report a change on
 * a click that set the kind a shape already had, and `withCheckpoint` would
 * spend an undo step on nothing. Both sides are canonical by the time they get
 * here, so an absent field and its default compare equal by construction.
 */
export function sameShapeGeometry(
  a: ShapeGeometry | null | undefined,
  b: ShapeGeometry | null | undefined,
): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  return JSON.stringify(canonicalOrder(a)) === JSON.stringify(canonicalOrder(b));
}

/**
 * The recipe with its keys in a fixed order.
 *
 * `JSON.stringify` preserves insertion order, and a recipe that reached
 * `normalizeShapeGeometry` through a different route can carry the same fields
 * in a different one. Comparing the strings without this would report a change
 * that is not there, which is exactly what the identity contract forbids.
 */
function canonicalOrder(geometry: ShapeGeometry): unknown[] {
  return [
    geometry.kind,
    geometry.radius ?? null,
    geometry.count ?? null,
    geometry.innerRatio ?? null,
    geometry.arc == null ? null : [geometry.arc.start, geometry.arc.sweep],
    geometry.hole ?? null,
  ];
}
