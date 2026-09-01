/**
 * Reading and validating a clip's mask.
 *
 * The same two-tempered split `renderer/blend.ts` and `renderer/lut.ts` use,
 * for the same reasons:
 *
 *  - **`maskOf` guards reads.** It runs inside the paint loop, once per element
 *    per frame, and must never throw. A hand-edited `timeline.json`, a field a
 *    newer build wrote, a `path` someone set to a string — all of them answer
 *    something drawable, or `null`, and the frame draws.
 *  - **`coerceMask` validates writes.** It runs once, where a value arrives
 *    from the panel or from an agent, and returns `null` for anything it does
 *    not recognise so the caller can report it. Past this point an unusable
 *    mask is unrepresentable.
 *
 * The one deliberate asymmetry between them: **`maskOf` defaults a missing or
 * unreadable number, `coerceMask` refuses it.** Both are right for where they
 * sit. A frame has to draw something, and a mask whose `feather` is `NaN` is
 * far better drawn hard-edged than not drawn; a write is the only place a
 * caller can be told it got something wrong, and silently substituting a number
 * there hides the mistake until someone notices the picture.
 *
 * DOM-free and store-free, so it runs under `environment: "node"` alongside the
 * pure ops that import it.
 */

import {
  MASK_SHAPES,
  type MaskNode,
  type MaskShape,
  type MaskType,
  type TimelineElement,
} from "../../@types/timeline";

/** `O(1)` membership, built once. `MASK_SHAPES.includes` is a scan per frame. */
const KNOWN_SHAPES = new Set<string>(MASK_SHAPES);

/** Centred on the element. */
export const DEFAULT_MASK_LOCATION = { x: 50, y: 50 } as const;

/**
 * How big a freshly applied mask is, as a percentage of the element box.
 *
 * Not 100. A mask that exactly fills the clip changes nothing visible, so
 * applying one would look like a no-op and the first thing anyone would do is
 * drag it smaller. Sixty leaves the shape unmistakably *on* the picture while
 * still showing most of it.
 */
export const DEFAULT_MASK_SIZE = { width: 60, height: 60 } as const;

export const DEFAULT_MASK_ROTATION = 0;

/** Hard-edged. A feather is something the user asks for. */
export const DEFAULT_MASK_FEATHER = 0;

/** Square-cornered. */
export const DEFAULT_MASK_ROUNDNESS = 0;

/**
 * How many nodes a drawn path needs before it encloses anything.
 *
 * Two points are a line segment with no interior, so a mask built from one
 * would cut the entire clip away. See `isMaskActive`.
 */
export const MIN_PEN_NODES = 3;

/** A new mask of this shape, at the defaults. Freshly allocated every call. */
export function defaultMask(shape: MaskShape): MaskType {
  return {
    shape,
    location: { ...DEFAULT_MASK_LOCATION },
    size: { ...DEFAULT_MASK_SIZE },
    rotation: DEFAULT_MASK_ROTATION,
    feather: DEFAULT_MASK_FEATHER,
    roundness: DEFAULT_MASK_ROUNDNESS,
  };
}

// ------------------------------------------------------------------ reading

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function atLeastZero(value: unknown, fallback: number): number {
  const resolved = finiteOr(value, fallback);
  return resolved < 0 ? 0 : resolved;
}

function clamped(value: unknown, fallback: number, lo: number, hi: number): number {
  const resolved = finiteOr(value, fallback);
  return resolved < lo ? lo : resolved > hi ? hi : resolved;
}

/**
 * A pair of finite numbers, or `null`.
 *
 * Half a handle is worse than no handle — it would bend the curve somewhere
 * nobody asked for — so a pair with one unreadable component is refused whole
 * and the node falls back to being a corner.
 */
function pairOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const [x, y] = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  return [x, y];
}

function nodeOf(value: unknown): MaskNode | null {
  if (value == null || typeof value !== "object") {
    return null;
  }
  const raw = value as { p?: unknown; cs?: unknown; ce?: unknown };
  const p = pairOf(raw.p);
  if (p == null) {
    return null;
  }
  const node: MaskNode = { p };
  const cs = pairOf(raw.cs);
  const ce = pairOf(raw.ce);
  if (cs != null) {
    node.cs = cs;
  }
  if (ce != null) {
    node.ce = ce;
  }
  return node;
}

/**
 * A drawn path, or `null` if any part of it is unreadable.
 *
 * All-or-nothing rather than node-by-node filtering: dropping one bad node from
 * the middle of a closed path silently changes its shape, and a shape that is
 * *plausibly* wrong is the failure this module exists to avoid. A path that
 * cannot be read falls back to no path at all, which `isMaskActive` renders as
 * a pass-through.
 */
function pathOf(value: unknown): MaskNode[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const out: MaskNode[] = [];
  for (const entry of value) {
    const node = nodeOf(entry);
    if (node == null) {
      return null;
    }
    out.push(node);
  }
  return out;
}

/**
 * The mask on this element, or `null`.
 *
 * Never throws, and never returns anything the path builder cannot draw. Every
 * number comes back finite, `size` and `feather` come back non-negative and
 * `roundness` comes back inside 0-100 — because these are multiplied into
 * coordinates, and a `NaN` there puts the whole path off-canvas and takes the
 * clip with it.
 *
 * `location` is deliberately **not** clamped to the element box. A mask slid
 * past the edge is a wipe, and animating one off-screen is how a reveal is
 * built.
 */
export function maskOf(
  element: TimelineElement | undefined | null,
): MaskType | null {
  const raw = (element as { mask?: unknown } | undefined | null)?.mask;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const { shape, location, size, rotation, feather, roundness, invert, path } =
    raw as Record<string, any>;

  if (typeof shape !== "string" || !KNOWN_SHAPES.has(shape)) {
    return null;
  }

  const mask: MaskType = {
    shape: shape as MaskShape,
    location: {
      x: finiteOr(location?.x, DEFAULT_MASK_LOCATION.x),
      y: finiteOr(location?.y, DEFAULT_MASK_LOCATION.y),
    },
    size: {
      width: atLeastZero(size?.width, DEFAULT_MASK_SIZE.width),
      height: atLeastZero(size?.height, DEFAULT_MASK_SIZE.height),
    },
    rotation: finiteOr(rotation, DEFAULT_MASK_ROTATION),
    feather: atLeastZero(feather, DEFAULT_MASK_FEATHER),
    roundness: clamped(roundness, DEFAULT_MASK_ROUNDNESS, 0, 100),
  };

  // Only `true`. A truthy `1` from a hand-edited file would round-trip back out
  // as a `1`, so the saved project would carry a field of a type the type says
  // it cannot have.
  if (invert === true) {
    mask.invert = true;
  }

  // A path on a built-in shape is dropped rather than kept: nothing reads it,
  // and keeping it would let a stale path reappear when the shape was switched
  // back to `pen` long after the user had forgotten drawing it.
  if (mask.shape === "pen") {
    const nodes = pathOf(path);
    if (nodes != null) {
      mask.path = nodes;
    }
  }

  return mask;
}

/**
 * Whether this mask cuts anything, and so whether the clip needs a layer.
 *
 * A separate question from "is there a mask", the same way `isLutActive` is
 * separate from `lutOf`: a `pen` mask with fewer than three nodes encloses no
 * area, and the contract for one is a **pass-through**, not a hole. That is the
 * same answer a LUT that is not installed gives, and here it has a second job —
 * it is what stops the clip vanishing between the first click of a pen stroke
 * and the third.
 *
 * A mask of zero *size* is active, and the distinction matters: that is a real
 * frame of an animation which hides the clip, and drawing it down the fast path
 * would show a clip the user had scaled away.
 */
export function isMaskActive(mask: MaskType | null | undefined): boolean {
  if (mask == null) {
    return false;
  }
  if (mask.shape === "pen") {
    return (mask.path?.length ?? 0) >= MIN_PEN_NODES;
  }
  return true;
}

// ------------------------------------------------------------------ writing

/**
 * A caller-supplied value as a `MaskShape`, or `null`.
 *
 * Exact match only — no trimming, no case folding — for the reason
 * `coerceBlend` gives: a shape arrives either from a button built out of
 * `MASK_SHAPES` or from a tool whose schema enumerates them, so a near miss is
 * a bug upstream and should be reported rather than guessed at.
 */
export function coerceMaskShape(value: unknown): MaskShape | null {
  return typeof value === "string" && KNOWN_SHAPES.has(value)
    ? (value as MaskShape)
    : null;
}

/** `undefined` passes (the field is optional); anything unreadable fails. */
function writtenNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function writtenPoint(value: unknown, ...keys: string[]): boolean {
  if (value === undefined) {
    return true;
  }
  if (value == null || typeof value !== "object") {
    return false;
  }
  return keys.every((key) => writtenNumber((value as any)[key]));
}

/**
 * A caller-supplied value as a `MaskType`, or `null` if it is not one.
 *
 * Refuses an unreadable number rather than defaulting it, which is the whole
 * difference from `maskOf` — see this module's header. What it *does* default
 * is a field the caller simply left out, and what it clamps is a range that is
 * a preference rather than a mistake: a `roundness` of 140 means "as round as
 * it goes", and refusing the write would be pedantry about a slider's ceiling.
 */
export function coerceMask(value: unknown): MaskType | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, any>;

  const shape = coerceMaskShape(raw.shape);
  if (shape == null) {
    return null;
  }

  if (
    !writtenPoint(raw.location, "x", "y") ||
    !writtenPoint(raw.size, "width", "height") ||
    !writtenNumber(raw.rotation) ||
    !writtenNumber(raw.feather) ||
    !writtenNumber(raw.roundness)
  ) {
    return null;
  }

  if (raw.invert !== undefined && typeof raw.invert !== "boolean") {
    return null;
  }

  let path: MaskNode[] | undefined;
  if (shape === "pen" && raw.path !== undefined) {
    const nodes = pathOf(raw.path);
    if (nodes == null) {
      return null;
    }
    path = nodes;
  }

  const mask: MaskType = {
    shape,
    location: {
      x: finiteOr(raw.location?.x, DEFAULT_MASK_LOCATION.x),
      y: finiteOr(raw.location?.y, DEFAULT_MASK_LOCATION.y),
    },
    size: {
      width: atLeastZero(raw.size?.width, DEFAULT_MASK_SIZE.width),
      height: atLeastZero(raw.size?.height, DEFAULT_MASK_SIZE.height),
    },
    rotation: finiteOr(raw.rotation, DEFAULT_MASK_ROTATION),
    feather: atLeastZero(raw.feather, DEFAULT_MASK_FEATHER),
    roundness: clamped(raw.roundness, DEFAULT_MASK_ROUNDNESS, 0, 100),
  };
  if (raw.invert === true) {
    mask.invert = true;
  }
  if (path != null) {
    mask.path = path;
  }
  return mask;
}

// ---------------------------------------------------------------- comparing

function samePair(
  a: [number, number] | undefined,
  b: [number, number] | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a[0] === b[0] && a[1] === b[1];
}

function samePath(a: MaskNode[] | undefined, b: MaskNode[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (
      !samePair(a[i].p, b[i].p) ||
      !samePair(a[i].cs, b[i].cs) ||
      !samePair(a[i].ce, b[i].ce)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two masks describe the same cut.
 *
 * The ops layer needs this to hold its decline-by-identity contract: every
 * panel control rebuilds the whole mask object on every change, so `!==` would
 * report a change on a click that set the shape a clip already had, and
 * `withCheckpoint` would spend an undo step on nothing.
 */
export function sameMask(
  a: MaskType | null | undefined,
  b: MaskType | null | undefined,
): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  return (
    a.shape === b.shape &&
    a.location.x === b.location.x &&
    a.location.y === b.location.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    a.rotation === b.rotation &&
    a.feather === b.feather &&
    a.roundness === b.roundness &&
    (a.invert === true) === (b.invert === true) &&
    samePath(a.path, b.path)
  );
}
