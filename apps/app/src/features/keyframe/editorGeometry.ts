/**
 * The curve editor's coordinate system, as pure arithmetic.
 *
 * All of this used to live as private methods on the Lit component, which
 * vitest cannot instantiate — the config runs `environment: "node"`, so there
 * is no `HTMLElement` to extend. `features/timeline/layout.ts` and
 * `features/timeline/dragMachine.ts` had already established the shape of the
 * fix: the geometry and the state machine are modules, and the component is a
 * shell that forwards events into them.
 *
 * Two bugs are fixed by the extraction itself, because both were invisible
 * while the forward and inverse maps sat two hundred lines apart:
 *
 * 1. They were not inverses. Drawing went through `millisecondsToPx`, which
 *    clamps a negative result to `0` — one-way, so a keyframe scrolled off the
 *    left edge drew at `x = 0` while its stored time kept running. Dragging
 *    went through `pxToMilliseconds` twice, once for the pointer and once for
 *    the scroll, and that function rounds to whole ms — so the two roundings
 *    compounded and grabbing a keyframe without moving it shifted it.
 *
 * 2. Nothing bounded a drag to the clip. `p[0]` went negative freely while the
 *    drawn dot sat pinned at the left edge by the clamp above, so the point
 *    stopped moving and the data did not.
 */

import { pxToMilliseconds } from "../../utils/time";
import { isCollapsedHandle } from "../animation/handleBounds";
import type { Keyframe } from "../animation/keyframes";

/** Everything the mapping needs from the editor's current view. */
export type Viewport = {
  /** Timeline zoom, as `timelineStore.range`. */
  timelineRange: number;
  /** Horizontal scroll of the timeline, in px. */
  timelineScroll: number;
  /** Vertical pan of the value axis, in track units. */
  verticalScroll: number;
  /** Vertical zoom: track units per screen px. */
  verticalRange: number;
  /** The element's start on the timeline, in ms. */
  startTime: number;
  /** The element's length, in ms. */
  duration: number;
};

/**
 * `millisecondsToPx` without its clamp, and without its rounding.
 *
 * The clamp is what made the forward map lossy, and the rounding is what made
 * it disagree with its inverse. Canvas takes fractional coordinates perfectly
 * well, so neither bought anything here.
 */
function msToPxExact(ms: number, timelineRange: number): number {
  return (ms / 5) * (timelineRange / 4);
}

/** How many ms one screen pixel spans at this zoom. */
export function msPerPx(timelineRange: number): number {
  return 5 / (timelineRange / 4);
}

/** A track-space point in canvas px. */
export function toScreen(
  v: Viewport,
  tMs: number,
  value: number,
): { x: number; y: number } {
  return {
    x: msToPxExact(tMs + v.startTime, v.timelineRange) - v.timelineScroll,
    y: (value + v.verticalScroll) / v.verticalRange,
  };
}

/**
 * A canvas-px point in track space — the exact inverse of `toScreen`.
 *
 * The scroll is folded in *before* the conversion, so the whole horizontal
 * mapping rounds once instead of twice.
 */
export function toTrack(
  v: Viewport,
  px: number,
  py: number,
): { tMs: number; value: number } {
  return {
    tMs:
      pxToMilliseconds(px + v.timelineScroll, v.timelineRange) - v.startTime,
    value: py * v.verticalRange - v.verticalScroll,
  };
}

/** The least gap between two value-ruler ticks, in px. */
export const RULER_MIN_SPACING = 32;

export type RulerTick = { value: number; y: number; label: string };

/**
 * The smallest 1, 2 or 5 × 10ⁿ that is at least `min`.
 *
 * What keeps the ruler's labels round at every zoom. A fixed step was dense
 * enough to blur into a solid bar at the far end of the Range slider — 50
 * units at 10 units per px is a tick every 5px.
 */
function niceStep(min: number): number {
  if (!Number.isFinite(min) || min <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(min));
  for (const m of [1, 2, 5]) {
    // A relative epsilon, so a `min` that is exactly a nice number — which
    // `log10` can land a hair past — is answered with itself.
    if (m * magnitude >= min * (1 - 1e-9)) {
      return m * magnitude;
    }
  }
  return 10 * magnitude;
}

/**
 * The value ruler's ticks, for the part of the axis that is on screen.
 *
 * The step follows the vertical zoom so ticks stay at least `minSpacing` px
 * apart, and only visible values are produced — the fixed loop this replaces
 * ran out of ticks once the curve was panned far enough. Positions go through
 * `toScreen`, so a tick labelled 100 sits exactly where a keyframe at 100 does.
 */
export function rulerTicks(
  v: Viewport,
  heightPx: number,
  minSpacing: number = RULER_MIN_SPACING,
): RulerTick[] {
  const step = niceStep(minSpacing * v.verticalRange);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const top = toTrack(v, 0, 0).value;
  const bottom = toTrack(v, 0, Math.max(0, heightPx)).value;

  const ticks: RulerTick[] = [];
  for (let k = Math.ceil(top / step); k <= Math.floor(bottom / step); k++) {
    // Rounded to the step's own precision, so a step of 0.2 labels 0.6 and
    // not 0.6000000000000001; `+ 0` folds the -0 that rounding can leave.
    const value = Number((k * step).toFixed(decimals)) + 0;
    ticks.push({
      value,
      y: toScreen(v, 0, value).y,
      label: value.toFixed(decimals),
    });
  }
  return ticks;
}

/** A time held inside the clip it belongs to. */
export function clampToClip(v: Viewport, tMs: number): number {
  if (!Number.isFinite(tMs)) {
    return 0;
  }
  if (tMs < 0) {
    return 0;
  }
  return tMs > v.duration ? v.duration : tMs;
}

/**
 * Pull a time onto the nearest interesting one, if it is close enough.
 *
 * What makes keyframe editing feel like CapCut rather than like a drawing
 * program: times that should coincide — with the playhead, with the sibling
 * lane's keyframe, with either end of the clip — actually do, instead of
 * landing 3ms away and staying there. `Alt` suppresses it at the call site by
 * passing an empty candidate list.
 */
export function snapTime(
  tMs: number,
  candidates: readonly number[],
  toleranceMs: number,
): number {
  let best = tMs;
  let bestDistance = toleranceMs;

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate)) {
      continue;
    }
    const distance = Math.abs(candidate - tMs);
    // `<` rather than `<=`, so the first of two equidistant candidates wins and
    // the result does not depend on the order they were collected in.
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export type HitPart = "p" | "cs" | "ce";
export type Hit = { index: number; part: HitPart };

/** Half-width of a grab target, in px. */
export const GRAB_RADIUS = 10;

/**
 * What the pointer is over, or `null`.
 *
 * Three rules, each of which was a bug in the method this replaces:
 *
 * - **Only the selected keyframe's handles can be grabbed.** The old hit test
 *   offered every keyframe's handles, which on a busy curve meant a forest of
 *   overlapping targets. The editor now draws handles only for the selection,
 *   so offering the invisible ones would have been worse than useless.
 * - **A collapsed handle is not a target.** The first keyframe's `cs` and the
 *   last one's `ce` sit exactly on their anchors and the baker never reads
 *   them (see `handleBounds`). Left grabbable, they shadow the anchor
 *   completely — the old order tested `cs`, then `ce`, then `p`, so those two
 *   anchors could not be picked up at all.
 * - **Nearest wins, and later-drawn breaks ties.** The old loop ran forwards
 *   without breaking, so the *last* overlapping point won regardless of where
 *   the pointer actually was.
 */
export function hitTest(
  list: Keyframe[],
  v: Viewport,
  px: number,
  py: number,
  opts: { activeIndex?: number; radius?: number } = {},
): Hit | null {
  const radius = opts.radius ?? GRAB_RADIUS;
  const activeIndex = opts.activeIndex ?? -1;

  let best: Hit | null = null;
  let bestRank = Infinity;
  let bestDistance = Infinity;

  const consider = (index: number, part: HitPart, rank: number) => {
    const keyframe = list[index];
    const point = part === "p" ? keyframe.p : keyframe[part];
    const screen = toScreen(v, point[0], point[1]);
    const dx = screen.x - px;
    const dy = screen.y - py;
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) {
      return;
    }
    const distance = dx * dx + dy * dy;
    // `<=` on distance so that among equally close candidates the one
    // considered later — the higher index, drawn on top — wins.
    if (rank < bestRank || (rank === bestRank && distance <= bestDistance)) {
      best = { index, part };
      bestRank = rank;
      bestDistance = distance;
    }
  };

  if (activeIndex >= 0 && activeIndex < list.length) {
    for (const part of ["cs", "ce"] as const) {
      if (!isCollapsedHandle(list[activeIndex], part)) {
        consider(activeIndex, part, 0);
      }
    }
  }

  for (let index = 0; index < list.length; index++) {
    consider(index, "p", 1);
  }

  return best;
}
