/**
 * Keyframes, as pure data.
 *
 * Everything about a keyframe track that does not need a store or a DOM lives
 * here: what a well-formed track looks like, how one is edited, how authored
 * keyframes become the baked sample array the renderer reads, and how that
 * array is sampled.
 *
 * It replaces `controllers/keyframe.ts`, which did the same work by mutating
 * the zustand snapshot in place. Because `tracks.ts#derivePriorities` spreads
 * elements shallowly, every `HistoryEntry` shared its `animation` objects with
 * the live document — so an in-place keyframe edit did not merely skip the undo
 * stack, it reached backwards and rewrote every step already on it. Pure
 * functions that return new objects are the fix, and `utils/immutable.ts` had
 * already documented this exact hazard for `trim` and `location`.
 *
 * The sampling semantics are deliberately unchanged: `sampleBaked` snaps to the
 * nearest baked point rather than blending neighbours, exactly as the old
 * `findNearestAnimationPointValue` did, ties going to the earlier point. What
 * changed is that it is O(log n) instead of a linear scan run per property, per
 * element, per frame — and that the array it searches is now guaranteed sorted.
 */

import type { CubicKeyframeType, TimelineElement } from "../../@types/timeline";
import { clampHandles } from "./handleBounds";

export type Lane = "x" | "y";

/** An authored keyframe after normalisation: every slot a finite `[t, value]`. */
export type Keyframe = CubicKeyframeType & {
  p: [number, number];
  cs: [number, number];
  ce: [number, number];
};

/**
 * A baked sample list.
 *
 * Invariant, and the precondition `sampleBaked` relies on: strictly increasing
 * in time, every entry a finite `[timeMs, value]` pair. `bakeTrack` and
 * `normalizeBaked` are the only two ways to obtain one.
 */
export type Baked = number[][];

export type ScalarTrack = { isActivate: boolean; x: Keyframe[]; ax: Baked };
export type VectorTrack = ScalarTrack & { y: Keyframe[]; ay: Baked };

/** Samples per second the baker lays down between keyframes. */
export const BAKE_HZ = 60;

/**
 * Ceiling on a single baked lane.
 *
 * 36,000 samples is ten minutes at 60Hz. The cap exists because the baked
 * arrays are serialised verbatim into the `.ngt` project file, and because a
 * keyframe pair an hour apart would otherwise allocate a quarter of a million
 * entries for a curve nobody can see that finely.
 */
export const MAX_BAKED_SAMPLES = 36_000;

/** Default distance, in ms, of an auto-generated bezier handle from its anchor. */
export const DEFAULT_HANDLE_MS = 100;

// --------------------------------------------------------------- normalising

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coerce one slot to a finite `[t, value]`.
 *
 * Numeric strings are accepted because the option panels feed values straight
 * from `<input>` elements, and `parseFloat` at each of those call sites is one
 * more place to forget.
 */
function toPair(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) {
    return null;
  }
  const t = typeof raw[0] === "string" ? parseFloat(raw[0]) : raw[0];
  const v = typeof raw[1] === "string" ? parseFloat(raw[1]) : raw[1];
  return isFiniteNumber(t) && isFiniteNumber(v) ? [t, v] : null;
}

/**
 * One raw keyframe as a `Keyframe`, or `null` if `p` cannot be recovered.
 *
 * A missing or broken handle is not fatal — it collapses onto the anchor, which
 * is what a keyframe with no easing means anyway.
 */
export function normalizeKeyframe(raw: unknown): Keyframe | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<CubicKeyframeType>;
  const p = toPair(candidate.p);
  if (p == null) {
    return null;
  }
  return {
    type: candidate.type === "linear" ? "linear" : "cubic",
    p,
    cs: toPair(candidate.cs) ?? [p[0], p[1]],
    ce: toPair(candidate.ce) ?? [p[0], p[1]],
  };
}

/**
 * A raw authored list as a sorted, deduplicated `Keyframe[]`.
 *
 * Two keyframes at the same instant have no meaning — one of them is
 * unreachable — so the later one in the input wins, matching what
 * `addKeyframe` does when it lands on an occupied time.
 */
export function normalizeKeyframes(raw: unknown): Keyframe[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const kept: Keyframe[] = [];
  for (const entry of raw) {
    const keyframe = normalizeKeyframe(entry);
    if (keyframe != null) {
      kept.push(keyframe);
    }
  }

  kept.sort((a, b) => a.p[0] - b.p[0]);

  const out: Keyframe[] = [];
  for (const keyframe of kept) {
    if (out.length > 0 && out[out.length - 1].p[0] === keyframe.p[0]) {
      out[out.length - 1] = keyframe;
      continue;
    }
    out.push(keyframe);
  }
  // Ingress is where project files authored before handles were constrained get
  // repaired. Without this, a legacy `.ngt` would draw handles the baker
  // silently ignores — the exact divergence `handleBounds` exists to end.
  return clampHandles(out);
}

/**
 * A raw baked array as a `Baked`.
 *
 * The shape this mostly exists to survive is `ax: [[], []]` — a two-element
 * array of *empty* arrays, which is what every runtime element factory wrote
 * where a list of `[t, value]` pairs was meant. It reached the old sampler as
 * `[undefined, undefined]`, made every comparison `NaN`, and was harmless only
 * by accident. Here it normalises to `[]`.
 */
export function normalizeBaked(raw: unknown): Baked {
  if (!Array.isArray(raw)) {
    return [];
  }

  const pairs: Array<[number, number]> = [];
  for (const entry of raw) {
    const pair = toPair(entry);
    if (pair != null) {
      pairs.push(pair);
    }
  }

  pairs.sort((a, b) => a[0] - b[0]);

  const out: Baked = [];
  for (const pair of pairs) {
    if (out.length > 0 && out[out.length - 1][0] === pair[0]) {
      out[out.length - 1] = pair;
      continue;
    }
    out.push(pair);
  }
  return out;
}

// ------------------------------------------------------------------ baking

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

function bezier(a: number, b: number, c: number, d: number, u: number): number {
  const m = 1 - u;
  return (
    m * m * m * a + 3 * m * m * u * b + 3 * m * u * u * c + u * u * u * d
  );
}

function bezierSlope(
  a: number,
  b: number,
  c: number,
  d: number,
  u: number,
): number {
  const m = 1 - u;
  return 3 * m * m * (b - a) + 6 * m * u * (c - b) + 3 * u * u * (d - c);
}

/**
 * Solve `bezierX(u) = t` for `u`.
 *
 * The old baker evaluated the bezier on *both* axes and pushed `[x(u), y(u)]`,
 * so the baked time axis was itself a curve — it bunched where x was flat and,
 * when handles crossed, ran backwards. A non-monotonic time axis makes binary
 * search impossible and makes "the keyframe at 400ms" meaningless.
 *
 * Inverting instead gives a time axis chosen by us and a value axis that still
 * follows the authored easing exactly. Callers clamp the control abscissae into
 * the segment first, which makes x weakly monotonic — the same normalisation
 * CSS `cubic-bezier()` applies — so a solution always exists.
 *
 * Newton first, since the curve is smooth and the initial guess is close;
 * bisection whenever Newton would leave the bracket, which is what keeps a
 * zero-derivative plateau from throwing the iteration out of `[0, 1]`.
 */
function solveBezierU(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  t: number,
): number {
  const span = x3 - x0;
  if (span <= 0) {
    return 0;
  }

  let lo = 0;
  let hi = 1;
  let u = clamp((t - x0) / span, 0, 1);

  for (let i = 0; i < 24; i++) {
    const x = bezier(x0, x1, x2, x3, u);
    const err = x - t;
    if (Math.abs(err) < 1e-7) {
      return u;
    }
    if (err > 0) {
      hi = u;
    } else {
      lo = u;
    }

    const slope = bezierSlope(x0, x1, x2, x3, u);
    const next = slope > 1e-12 ? u - err / slope : Number.NaN;
    u = Number.isFinite(next) && next > lo && next < hi ? next : (lo + hi) / 2;
  }

  return u;
}

/**
 * Turn authored keyframes into the dense sample array the renderer reads.
 *
 * One grid is laid over the whole track and then unioned with every anchor
 * time, rather than each segment being sampled independently. That single
 * change fixes four separate defects in the baker it replaces:
 *
 *   - segments shorter than 5ms were skipped outright, leaving a hole;
 *   - `Math.round(interval / (1000/60))` reached 0 on a sub-8ms segment, and
 *     the `t += 1 / 0` that followed emitted one sample and stopped;
 *   - `for (t = 0; t <= 1; t += 1/n)` accumulated float error, so the final
 *     `t = 1` sample — the keyframe's own value — was usually skipped;
 *   - adjoining segments each emitted the shared join, duplicating it.
 *
 * The step is a multiplication off the index, never an accumulation, and the
 * sample count is computed before the loop, so neither drift nor an unbounded
 * loop is representable.
 */
export function bakeTrack(list: Keyframe[], hz: number = BAKE_HZ): Baked {
  if (list.length === 0) {
    // An emptied track must empty its bake too, or the renderer keeps applying
    // the animation the user just deleted.
    return [];
  }
  if (list.length === 1) {
    return [[list[0].p[0], list[0].p[1]]];
  }

  const first = list[0];
  const last = list[list.length - 1];
  const t0 = first.p[0];
  const tn = last.p[0];
  if (tn <= t0) {
    // Every keyframe at one instant: only the last is reachable.
    return [[t0, last.p[1]]];
  }

  const rate = Number.isFinite(hz) ? clamp(hz, 1, 1000) : BAKE_HZ;
  const budget = Math.max(2, MAX_BAKED_SAMPLES - list.length);
  let step = 1000 / rate;
  let count = Math.ceil((tn - t0) / step) + 1;

  if (count > budget) {
    // Spread the budget across the whole track rather than stopping partway.
    // Clamping the *count* while holding the step meant a track longer than
    // the budget allows was baked only up to `t0 + budget * step` — a
    // twenty-minute fade froze ten minutes in and then jumped to its end value.
    // Coarsening the step keeps every instant covered; the samples are further
    // apart, which is the honest trade at that length.
    count = budget;
    step = (tn - t0) / (count - 1);
  }

  // Grid times and anchor times, merged into one strictly increasing list.
  const times: number[] = [];
  let gridIndex = 0;
  let anchorIndex = 0;
  const push = (t: number) => {
    if (times.length === 0 || t > times[times.length - 1]) {
      times.push(t);
    }
  };
  while (gridIndex < count || anchorIndex < list.length) {
    const grid = gridIndex < count ? t0 + gridIndex * step : Infinity;
    const anchor = anchorIndex < list.length ? list[anchorIndex].p[0] : Infinity;
    if (grid <= anchor) {
      push(Math.min(grid, tn));
      gridIndex++;
    } else {
      push(anchor);
      anchorIndex++;
    }
  }
  push(tn);

  const out: Baked = [];
  let segment = 0;
  for (const t of times) {
    // Anchor times are ascending, so the segment cursor only ever moves
    // forward — no search per sample.
    while (segment < list.length - 2 && t > list[segment + 1].p[0]) {
      segment++;
    }

    const a = list[segment];
    const b = list[segment + 1];
    const x0 = a.p[0];
    const x3 = b.p[0];

    if (t <= x0) {
      out.push([t, a.p[1]]);
      continue;
    }
    if (t >= x3) {
      out.push([t, b.p[1]]);
      continue;
    }

    if (a.type === "linear") {
      const k = (t - x0) / (x3 - x0);
      out.push([t, a.p[1] + (b.p[1] - a.p[1]) * k]);
      continue;
    }

    // Control abscissae clamped into the segment: outside it the curve doubles
    // back in time, which has no meaning for a value-over-time track.
    const x1 = clamp(a.ce[0], x0, x3);
    const x2 = clamp(b.cs[0], x0, x3);
    const u = solveBezierU(x0, x1, x2, x3, t);
    const value = bezier(a.p[1], a.ce[1], b.cs[1], b.p[1], u);
    out.push([t, Number.isFinite(value) ? value : a.p[1]]);
  }

  // The endpoints are the two samples most likely to be looked up exactly, so
  // they carry the authored value rather than a solved approximation of it.
  out[0] = [t0, first.p[1]];
  out[out.length - 1] = [tn, last.p[1]];
  return out;
}

// ---------------------------------------------------------------- sampling

/**
 * The value at `tRelativeMs`, snapped to the nearest baked sample.
 *
 * Deliberately not an interpolation, despite what the old function it replaces
 * was called: the baked array is already dense, and blending neighbours would
 * move every rendered frame and every golden snapshot. Ties go to the earlier
 * sample, which is what the linear scan did by comparing with a strict `<`.
 *
 * Requires `baked` sorted ascending — guaranteed by `bakeTrack` and
 * `normalizeBaked`, which between them are the only writers. Unsorted input
 * still returns some value from the array rather than throwing; it is simply
 * not guaranteed to be the nearest one.
 */
export function sampleBaked(
  baked: Baked,
  tRelativeMs: number,
  fallback: number,
): number {
  const n = baked.length;
  if (n === 0 || !Number.isFinite(tRelativeMs)) {
    return fallback;
  }

  // First index whose time is >= t.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (baked[mid][0] < tRelativeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  let index: number;
  if (lo === 0) {
    index = 0;
  } else if (lo === n) {
    index = n - 1;
  } else {
    const before = tRelativeMs - baked[lo - 1][0];
    const after = baked[lo][0] - tRelativeMs;
    index = before <= after ? lo - 1 : lo;
  }

  // Equal times can survive in legacy data that never went through
  // `normalizeBaked`. The linear scan kept the first of a run, so rewind to it.
  while (index > 0 && baked[index - 1][0] === baked[index][0]) {
    index--;
  }

  const value = baked[index]?.[1];
  return isFiniteNumber(value) ? value : fallback;
}

/** Whether `cursor` is at or after the element's start. */
function startedYet(elementStartTime: number, cursor: number): boolean {
  if (!Number.isFinite(elementStartTime) || !Number.isFinite(cursor)) {
    return false;
  }
  return cursor >= elementStartTime;
}

/**
 * Sample one scalar track at a timeline cursor.
 *
 * Before the element begins there is nothing to animate, so the static value
 * stands. The guard this replaces rounded the cursor onto a 16ms frame and then
 * remapped it onto a 20ms grid — a 25% unit error that let a cursor a full
 * second before the element still snap to the element's first keyframe.
 */
export function sampleTrack(
  track: { ax?: unknown } | null | undefined,
  elementStartTime: number,
  cursor: number,
  fallback: number,
): number {
  if (track == null || !startedYet(elementStartTime, cursor)) {
    return fallback;
  }
  const baked = track.ax as Baked;
  if (!Array.isArray(baked)) {
    return fallback;
  }
  return sampleBaked(baked, cursor - elementStartTime, fallback);
}

/**
 * Sample a two-lane track.
 *
 * The `??` matters: the panel copies of this used `ax || location.x`, so an
 * animated value of exactly `0` — the left edge, fully transparent, no rotation
 * — was falsy and silently fell back to the static value.
 */
export function sampleTrackXY(
  track: { ax?: unknown; ay?: unknown } | null | undefined,
  elementStartTime: number,
  cursor: number,
  fallbackX: number,
  fallbackY: number,
): { x: number; y: number } {
  if (track == null || !startedYet(elementStartTime, cursor)) {
    return { x: fallbackX, y: fallbackY };
  }
  const t = cursor - elementStartTime;
  const ax = Array.isArray(track.ax) ? (track.ax as Baked) : [];
  const ay = Array.isArray(track.ay) ? (track.ay as Baked) : [];
  return {
    x: sampleBaked(ax, t, fallbackX),
    y: sampleBaked(ay, t, fallbackY),
  };
}

// ----------------------------------------------------------------- editing

function makeKeyframe(
  tMs: number,
  value: number,
  handleMs: number,
): Keyframe {
  return {
    type: "cubic",
    p: [tMs, value],
    cs: [tMs - handleMs, value],
    ce: [tMs + handleMs, value],
  };
}

function indexOfTime(list: Keyframe[], tMs: number): number {
  for (let i = 0; i < list.length; i++) {
    if (list[i].p[0] === tMs) {
      return i;
    }
  }
  return -1;
}

/**
 * Insert a keyframe, or replace the one already at that instant.
 *
 * Returns the input by identity when nothing would change, matching the
 * decline-by-identity contract the timeline's own ops use.
 */
export function addKeyframe(
  list: Keyframe[],
  tMs: number,
  value: number,
  handleMs: number = DEFAULT_HANDLE_MS,
): Keyframe[] {
  if (!Number.isFinite(tMs) || !Number.isFinite(value)) {
    return list;
  }

  // The first keyframe on an empty track gets collapsed handles: there is no
  // neighbour to ease towards, and a ±100ms handle would be a curve the user
  // never drew.
  const handle = list.length === 0 ? 0 : handleMs;
  const fresh = makeKeyframe(tMs, value, handle);

  const existing = indexOfTime(list, tMs);
  if (existing >= 0) {
    const current = list[existing];
    if (current.p[1] === value) {
      return list;
    }
    const next = [...list];
    // Replacing in place keeps the handles the user drew; only the value moves.
    next[existing] = {
      ...current,
      p: [tMs, value],
      cs: [current.cs[0], current.cs[1] + (value - current.p[1])],
      ce: [current.ce[0], current.ce[1] + (value - current.p[1])],
    };
    return clampHandles(next);
  }

  let at = list.length;
  for (let i = 0; i < list.length; i++) {
    if (list[i].p[0] > tMs) {
      at = i;
      break;
    }
  }
  // Inserting changes the bounds of both neighbours as well as seating the new
  // keyframe's own `±handleMs`, which lands outside the segment whenever the
  // gap is under 100ms. Clamping the whole list is the only way to catch both.
  return clampHandles([...list.slice(0, at), fresh, ...list.slice(at)]);
}

/**
 * Move a keyframe in time and value.
 *
 * Handles translate with the anchor instead of being flattened to `±100ms` —
 * the editor's drag reset them on every mousemove, so any easing the user drew
 * was destroyed the moment they nudged the point.
 *
 * Dragging past a neighbour re-sorts the list, which is why the new index comes
 * back with it: the caller is holding an index into the old order, and keeping
 * it would move a different keyframe on the next mousemove.
 */
export function moveKeyframe(
  list: Keyframe[],
  index: number,
  tMs: number,
  value: number,
): { list: Keyframe[]; index: number } {
  if (
    index < 0 ||
    index >= list.length ||
    !Number.isFinite(tMs) ||
    !Number.isFinite(value)
  ) {
    return { list, index };
  }

  const current = list[index];
  const dt = tMs - current.p[0];
  const dv = value - current.p[1];
  if (dt === 0 && dv === 0) {
    return { list, index };
  }

  // Landing exactly on another keyframe would make one of them unreachable.
  // Refusing is what the editor already tried to do, and it means a drag comes
  // to rest against its neighbour rather than eating it.
  for (let i = 0; i < list.length; i++) {
    if (i !== index && list[i].p[0] === tMs) {
      return { list, index };
    }
  }

  const moved: Keyframe = {
    type: current.type,
    p: [tMs, value],
    cs: [current.cs[0] + dt, current.cs[1] + dv],
    ce: [current.ce[0] + dt, current.ce[1] + dv],
  };

  const next = [...list.slice(0, index), ...list.slice(index + 1)];
  let at = next.length;
  for (let i = 0; i < next.length; i++) {
    if (next[i].p[0] > tMs) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, moved);
  // The anchor carried its handles with it, and moving it also redefined what
  // its neighbours' handles are allowed to span. Constraining only the dragged
  // keyframe would leave the two beside it pointing past it.
  return { list: clampHandles(next), index: at };
}

/**
 * Replace one keyframe's bezier handles, constrained to their segment.
 *
 * The clamp is here rather than in the editor's drag because this is the choke
 * point every handle edit passes through — the curve editor, the option panels,
 * and any easing preset added later. Putting it in the drag handler would mean
 * the next caller reintroduces the divergence between the drawn handle and the
 * baked curve. See `handleBounds` for the rule and why the value axis is free.
 */
export function setHandles(
  list: Keyframe[],
  index: number,
  patch: { cs?: [number, number]; ce?: [number, number] },
): Keyframe[] {
  if (index < 0 || index >= list.length) {
    return list;
  }
  const current = list[index];
  const cs = patch.cs != null ? toPair(patch.cs) : null;
  const ce = patch.ce != null ? toPair(patch.ce) : null;
  if (cs == null && ce == null) {
    return list;
  }

  const next = [...list];
  next[index] = { ...current, cs: cs ?? current.cs, ce: ce ?? current.ce };
  const clamped = clampHandles(next);
  // `clampHandles` cannot see that `next` is a copy, so it hands back the same
  // array when the patch was already in bounds. Compare against the original to
  // keep the decline-by-identity contract when the patch was a no-op.
  return sameKeyframes(list, clamped) ? list : clamped;
}

export function removeKeyframe(list: Keyframe[], index: number): Keyframe[] {
  if (index < 0 || index >= list.length) {
    return list;
  }
  // Removing widens the gap its neighbours span, and turns whichever keyframe
  // was next-to-last into the last — whose `ce` is now inert and must collapse.
  return clampHandles([...list.slice(0, index), ...list.slice(index + 1)]);
}

/** Slide every keyframe by `deltaMs`, handles included. */
export function shiftKeyframes(list: Keyframe[], deltaMs: number): Keyframe[] {
  if (deltaMs === 0 || !Number.isFinite(deltaMs) || list.length === 0) {
    return list;
  }
  return list.map((keyframe) => ({
    type: keyframe.type,
    p: [keyframe.p[0] + deltaMs, keyframe.p[1]] as [number, number],
    cs: [keyframe.cs[0] + deltaMs, keyframe.cs[1]] as [number, number],
    ce: [keyframe.ce[0] + deltaMs, keyframe.ce[1]] as [number, number],
  }));
}

/**
 * Slide every keyframe's **value** by `delta`, handles included.
 *
 * The value-axis twin of `shiftKeyframes`, and what makes grouping exact.
 * Re-expressing a clip's position in a group's coordinate space is a pure
 * translation of its position curve, and a translation acts on the control
 * points of a bezier exactly as it acts on the points of the curve — so
 * offsetting anchors and handles alike reproduces the original path with no
 * error at all, and the timing is untouched because the time axis is not.
 *
 * This is why `createGroup` seats the group at the selection's bounding box
 * rather than at the origin: the compensation it owes each child is then a
 * translation, which is representable, instead of a general affine, which is
 * not — the two position lanes carry independent handle abscissae, so a
 * transform that mixes x into y has no exact form here.
 */
export function offsetKeyframeValues(
  list: Keyframe[],
  delta: number,
): Keyframe[] {
  if (delta === 0 || !Number.isFinite(delta) || list.length === 0) {
    return list;
  }
  return list.map((keyframe) => ({
    type: keyframe.type,
    p: [keyframe.p[0], keyframe.p[1] + delta] as [number, number],
    cs: [keyframe.cs[0], keyframe.cs[1] + delta] as [number, number],
    ce: [keyframe.ce[0], keyframe.ce[1] + delta] as [number, number],
  }));
}

/**
 * Map every keyframe's value through `fn`, handles included.
 *
 * For the compensations a plain offset cannot express — a group carrying
 * rotation or scale, which `ungroup` and `setParent` have to bake into their
 * children. Anchors come out exact; the handles are carried through the same
 * map, which is exact for the linear part and an approximation of the easing
 * only where the two lanes' handle abscissae disagree. `groupOps.test.ts` pins
 * the anchor exactness rather than leaving the distinction to this comment.
 */
export function mapKeyframeValues(
  list: Keyframe[],
  fn: (value: number, timeMs: number) => number,
): Keyframe[] {
  if (list.length === 0) {
    return list;
  }
  return list.map((keyframe) => ({
    type: keyframe.type,
    p: [keyframe.p[0], fn(keyframe.p[1], keyframe.p[0])] as [number, number],
    cs: [keyframe.cs[0], fn(keyframe.cs[1], keyframe.cs[0])] as [number, number],
    ce: [keyframe.ce[0], fn(keyframe.ce[1], keyframe.ce[0])] as [number, number],
  }));
}

/** Slide a baked lane by `deltaMs`. */
export function shiftBaked(baked: Baked, deltaMs: number): Baked {
  if (deltaMs === 0 || !Number.isFinite(deltaMs) || baked.length === 0) {
    return baked;
  }
  return baked.map(([t, v]) => [t + deltaMs, v]);
}

type Point = [number, number];

function lerpPoint(a: Point, b: Point, u: number): Point {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/**
 * Cut one cubic segment in two at parameter `u`, exactly.
 *
 * De Casteljau: the same construction that evaluates a bezier also hands back
 * the control points of both halves, so the two pieces trace the original curve
 * with no error at all. Splitting a clip must not change what plays, and simply
 * planting a keyframe at the cut with the right *value* is not enough — its
 * easing would be whatever the default handles say, so the segment either side
 * of a cut would bow differently from the uncut clip.
 */
function subdivideSegment(
  a: Keyframe,
  b: Keyframe,
  u: number,
): { aCe: Point; midCs: Point; mid: Point; midCe: Point; bCs: Point } {
  const p0: Point = [a.p[0], a.p[1]];
  const p1: Point = [clamp(a.ce[0], a.p[0], b.p[0]), a.ce[1]];
  const p2: Point = [clamp(b.cs[0], a.p[0], b.p[0]), b.cs[1]];
  const p3: Point = [b.p[0], b.p[1]];

  const q0 = lerpPoint(p0, p1, u);
  const q1 = lerpPoint(p1, p2, u);
  const q2 = lerpPoint(p2, p3, u);
  const r0 = lerpPoint(q0, q1, u);
  const r1 = lerpPoint(q1, q2, u);
  const mid = lerpPoint(r0, r1, u);

  // Left half is (p0, q0, r0, mid); right half is (mid, r1, q2, p3).
  return { aCe: q0, midCs: r0, mid, midCe: r1, bCs: q2 };
}

/** The segment containing `tMs`, or `null` if `tMs` is outside the track. */
function segmentAt(list: Keyframe[], tMs: number): number | null {
  for (let i = 0; i < list.length - 1; i++) {
    if (tMs > list[i].p[0] && tMs < list[i + 1].p[0]) {
      return i;
    }
  }
  return null;
}

/**
 * Split the track at `tMs`, returning the list with a keyframe planted there.
 *
 * The new keyframe and its two neighbours carry the control points de Casteljau
 * produced, so the curve is bit-for-bit the one that was there before.
 */
function planted(list: Keyframe[], tMs: number): Keyframe[] {
  if (list.length === 0 || indexOfTime(list, tMs) >= 0) {
    return list;
  }

  // Outside the authored range the track holds its nearest end value, so the
  // boundary keyframe is that value with flat handles. Without this a window
  // that starts after the last keyframe — the tail piece of a clip split three
  // times — would slice down to an empty track and stop animating entirely.
  if (tMs < list[0].p[0]) {
    const held = list[0].p[1];
    return [
      { type: "cubic", p: [tMs, held], cs: [tMs, held], ce: [tMs, held] },
      ...list,
    ];
  }
  const last = list[list.length - 1];
  if (tMs > last.p[0]) {
    const held = last.p[1];
    return [
      ...list,
      { type: "cubic", p: [tMs, held], cs: [tMs, held], ce: [tMs, held] },
    ];
  }

  const index = segmentAt(list, tMs);
  if (index == null) {
    return list;
  }

  const a = list[index];
  const b = list[index + 1];
  const x0 = a.p[0];
  const x3 = b.p[0];

  if (a.type === "linear") {
    const k = (tMs - x0) / (x3 - x0);
    const value = a.p[1] + (b.p[1] - a.p[1]) * k;
    const mid: Keyframe = {
      type: "linear",
      p: [tMs, value],
      cs: [tMs, value],
      ce: [tMs, value],
    };
    return [...list.slice(0, index + 1), mid, ...list.slice(index + 1)];
  }

  const u = solveBezierU(
    x0,
    clamp(a.ce[0], x0, x3),
    clamp(b.cs[0], x0, x3),
    x3,
    tMs,
  );
  const cut = subdivideSegment(a, b, u);

  return [
    ...list.slice(0, index),
    { ...a, ce: cut.aCe },
    { type: "cubic", p: [tMs, cut.mid[1]], cs: cut.midCs, ce: cut.midCe },
    { ...b, cs: cut.bCs },
    ...list.slice(index + 2),
  ];
}

/**
 * Plant a keyframe at `tMs` without changing the curve.
 *
 * The public face of `planted`. Clip splitting needed this so a cut would not
 * change what plays; the paired-lane ops need it for the same reason at the
 * other end of the app — when a keyframe is added to `x`, the matching one on
 * `y` must land *on* the curve `y` already had, not resample it through fresh
 * default handles. Returns the input by identity when there is already a
 * keyframe at that instant, or when the list is empty and there is no curve to
 * preserve.
 */
export function plantKeyframe(list: Keyframe[], tMs: number): Keyframe[] {
  if (!Number.isFinite(tMs)) {
    return list;
  }
  return clampHandles(planted(list, tMs));
}

/**
 * Keep the keyframes inside `[fromMs, toMs]`, with the boundaries pinned.
 *
 * A cut that simply dropped what fell outside would change the picture at the
 * seam: the value at `fromMs` is generally partway along a curve, not the value
 * of the first surviving keyframe. Planting a keyframe at each boundary — with
 * control points from an exact subdivision, not default handles — keeps both
 * halves of a split showing precisely what the uncut clip showed.
 */
export function sliceKeyframes(
  list: Keyframe[],
  fromMs: number,
  toMs: number,
): Keyframe[] {
  if (list.length === 0 || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return list;
  }
  if (toMs <= fromMs) {
    return list;
  }

  const inside = (candidate: Keyframe[]) =>
    candidate.filter((k) => k.p[0] >= fromMs && k.p[0] <= toMs);

  if (inside(list).length === list.length) {
    return list;
  }

  // Plant the far boundary first: planting the near one shifts nothing after
  // it, but doing them in the other order would look up `toMs` in a list whose
  // indices had already moved.
  let out = planted(planted(list, toMs), fromMs);
  return inside(out);
}

// -------------------------------------------------------- element helpers

/** Property names that carry a second lane. */
const VECTOR_PROPERTIES = new Set(["position"]);

export function lanesOf(property: string): Lane[] {
  return VECTOR_PROPERTIES.has(property) ? ["x", "y"] : ["x"];
}

/** The other lane of a two-lane property. */
export function siblingLane(lane: Lane): Lane {
  return lane === "x" ? "y" : "x";
}

/**
 * The empty `animation` block for a filetype — the single definition of it.
 *
 * Every element factory used to write its own, and every one of them wrote
 * `ax: [[], []]` where a list of pairs belonged. The test helper wrote the
 * correct `ax: []`, so no test ever saw the shipped shape. Sharing one
 * definition is what stops that divergence recurring, and it matters more than
 * the malformed value itself.
 */
export function emptyAnimation(filetype: string): any {
  const scalar = () => ({ isActivate: false, x: [], ax: [] });
  if (filetype === "shape") {
    return { opacity: scalar() };
  }
  if (
    filetype === "image" ||
    filetype === "video" ||
    filetype === "text" ||
    filetype === "group"
  ) {
    return {
      position: { isActivate: false, x: [], y: [], ax: [], ay: [] },
      opacity: scalar(),
      scale: scalar(),
      rotation: scalar(),
    };
  }
  // gif and audio carry no animation block at all.
  return undefined;
}

function normalizeTrackValue(raw: any, lanes: Lane[]): any {
  const out: any = { isActivate: raw?.isActivate === true };
  for (const lane of lanes) {
    const authored = normalizeKeyframes(raw?.[lane]);
    out[lane] = authored;
    out[lane === "x" ? "ax" : "ay"] = normalizeBaked(
      raw?.[lane === "x" ? "ax" : "ay"],
    );
  }
  return out;
}

/**
 * Whether two authored lists describe the same curve.
 *
 * Object identity is not enough for callers that need to know whether a gesture
 * changed anything: a drag that ends where it began produced a fresh array on
 * every mousemove, so `!==` says "changed" about a curve nobody moved.
 */
export function sameKeyframes(a: Keyframe[], b: Keyframe[]): boolean {
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.type !== y.type ||
      x.p[0] !== y.p[0] ||
      x.p[1] !== y.p[1] ||
      x.cs[0] !== y.cs[0] ||
      x.cs[1] !== y.cs[1] ||
      x.ce[0] !== y.ce[0] ||
      x.ce[1] !== y.ce[1]
    ) {
      return false;
    }
  }
  return true;
}

function sameTrack(before: any, after: any, lanes: Lane[]): boolean {
  if (before?.isActivate !== after.isActivate) {
    return false;
  }
  for (const lane of lanes) {
    const bakedKey = lane === "x" ? "ax" : "ay";
    if (
      !Array.isArray(before?.[lane]) ||
      before[lane].length !== after[lane].length ||
      !Array.isArray(before?.[bakedKey]) ||
      before[bakedKey].length !== after[bakedKey].length
    ) {
      return false;
    }
    for (let i = 0; i < after[lane].length; i++) {
      const a = before[lane][i];
      const b = after[lane][i];
      // Handles and type as well as the anchor. Comparing only `p` meant an
      // element whose *handles* were the malformed part looked unchanged, so
      // the repaired copy was thrown away and the original — with a `cs` of
      // `undefined` — went back into the store, to throw on the first bake.
      if (
        a?.type !== b.type ||
        a?.p?.[0] !== b.p[0] ||
        a?.p?.[1] !== b.p[1] ||
        a?.cs?.[0] !== b.cs[0] ||
        a?.cs?.[1] !== b.cs[1] ||
        a?.ce?.[0] !== b.ce[0] ||
        a?.ce?.[1] !== b.ce[1]
      ) {
        return false;
      }
    }
    for (let i = 0; i < after[bakedKey].length; i++) {
      const a = before[bakedKey][i];
      const b = after[bakedKey][i];
      if (a?.[0] !== b[0] || a?.[1] !== b[1]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Repair an element's `animation` block, or return it untouched.
 *
 * Called on ingress — project load and element construction — rather than from
 * `normalizeDocument`, which runs on every edit and every checkpoint and has no
 * business walking keyframe arrays at pointer rate.
 */
export function normalizeAnimation<T extends TimelineElement>(element: T): T {
  const animation = (element as any).animation;
  if (animation == null || typeof animation !== "object") {
    return element;
  }

  const next: any = {};
  let changed = false;
  for (const property of Object.keys(animation)) {
    const lanes = lanesOf(property);
    const normalized = normalizeTrackValue(animation[property], lanes);
    next[property] = normalized;
    if (!sameTrack(animation[property], normalized, lanes)) {
      changed = true;
    }
  }

  return changed ? { ...(element as any), animation: next } : element;
}

/**
 * Deep-copy an element's `animation` block, sharing nothing.
 *
 * `splitAt` and `pasteClips` both build their results with `{...element}`, so
 * the pieces they produce shared one `animation` object with each other and
 * with the original — editing a keyframe on one half of a split silently
 * changed the other, and pasting twice gave two clips one animation.
 */
export function cloneAnimation<T extends TimelineElement>(element: T): T {
  const animation = (element as any).animation;
  if (animation == null || typeof animation !== "object") {
    return element;
  }

  const next: any = {};
  for (const property of Object.keys(animation)) {
    const track = animation[property];
    const copy: any = { isActivate: track?.isActivate === true };
    for (const lane of lanesOf(property)) {
      const bakedKey = lane === "x" ? "ax" : "ay";
      copy[lane] = (Array.isArray(track?.[lane]) ? track[lane] : []).map(
        (k: Keyframe) => ({
          type: k.type,
          p: [k.p[0], k.p[1]],
          cs: [k.cs[0], k.cs[1]],
          ce: [k.ce[0], k.ce[1]],
        }),
      );
      copy[bakedKey] = (
        Array.isArray(track?.[bakedKey]) ? track[bakedKey] : []
      ).map((pair: number[]) => [pair[0], pair[1]]);
    }
    next[property] = copy;
  }

  return { ...(element as any), animation: next };
}

/**
 * Slide every keyframe on an element by `deltaMs`.
 *
 * Keyframe times are relative to `element.startTime`, so any op that moves
 * `startTime` without calling this leaves the animation sliding against the
 * content it was drawn on. `trimStart` and the right half of `splitAt` both do
 * exactly that.
 */
export function rebaseAnimation<T extends TimelineElement>(
  element: T,
  deltaMs: number,
): T {
  const animation = (element as any).animation;
  if (animation == null || typeof animation !== "object" || deltaMs === 0) {
    return element;
  }
  if (!Number.isFinite(deltaMs)) {
    return element;
  }

  const next: any = {};
  let changed = false;
  for (const property of Object.keys(animation)) {
    const track = animation[property];
    const copy: any = { isActivate: track?.isActivate === true };
    for (const lane of lanesOf(property)) {
      const bakedKey = lane === "x" ? "ax" : "ay";
      const authored = Array.isArray(track?.[lane]) ? track[lane] : [];
      const baked = Array.isArray(track?.[bakedKey]) ? track[bakedKey] : [];
      const shifted = shiftKeyframes(authored, -deltaMs);
      copy[lane] = shifted;
      // Re-bake rather than shifting the old samples. The two are the same
      // curve, but the baker's grid is `t0 + i * step`, so shifting `t0` and
      // shifting each sample disagree in the last bits of a float — and that is
      // enough to break the `ax === bakeTrack(x)` invariant the ops rely on.
      //
      // Unless there is nothing to re-bake from: a project written before the
      // authored list was persisted can carry samples with no keyframes behind
      // them, and re-baking would silently delete that animation.
      copy[bakedKey] =
        authored.length > 0 ? bakeTrack(shifted) : shiftBaked(baked, -deltaMs);
      if (authored.length > 0 || baked.length > 0) {
        changed = true;
      }
    }
    next[property] = copy;
  }

  return changed ? { ...(element as any), animation: next } : element;
}

/**
 * Keep only the keyframes inside `[fromMs, toMs]` of the element's own time.
 *
 * Deep-copies on the way, so the result never shares a keyframe object with its
 * input even when nothing falls outside the window.
 */
export function sliceAnimation<T extends TimelineElement>(
  element: T,
  fromMs: number,
  toMs: number,
): T {
  const animation = (element as any).animation;
  if (animation == null || typeof animation !== "object") {
    return element;
  }

  const cloned = cloneAnimation(element);
  const source = (cloned as any).animation;
  for (const property of Object.keys(source)) {
    const track = source[property];
    for (const lane of lanesOf(property)) {
      const bakedKey = lane === "x" ? "ax" : "ay";
      if (track[lane].length === 0) {
        // A project written before the authored list was persisted can carry
        // baked samples with no keyframes behind them. Re-baking from an empty
        // list would erase that animation, so trim the samples directly — the
        // same case `rebaseAnimation` guards.
        track[bakedKey] = track[bakedKey].filter(
          ([t]: number[]) => t >= fromMs && t <= toMs,
        );
        continue;
      }
      const sliced = sliceKeyframes(track[lane], fromMs, toMs);
      track[lane] = sliced;
      track[bakedKey] = bakeTrack(sliced);
    }
  }
  return cloned;
}

/**
 * Throw if a baked array breaks its invariant.
 *
 * For tests and development only — the sampler does not check, because
 * verifying sortedness on every frame is the linear scan this was written to
 * remove.
 */
export function assertBakedInvariants(baked: Baked, context = "baked"): void {
  for (let i = 0; i < baked.length; i++) {
    const entry = baked[i];
    if (
      !Array.isArray(entry) ||
      entry.length < 2 ||
      !isFiniteNumber(entry[0]) ||
      !isFiniteNumber(entry[1])
    ) {
      throw new Error(`${context}: entry ${i} is not a finite [t, value] pair`);
    }
    if (i > 0 && entry[0] <= baked[i - 1][0]) {
      throw new Error(
        `${context}: time is not strictly increasing at ${i} (${baked[i - 1][0]} -> ${entry[0]})`,
      );
    }
  }
}
