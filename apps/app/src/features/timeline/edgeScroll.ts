/**
 * Scrolling the timeline from under a clip that is being dragged.
 *
 * Two problems, solved in one place. A held clip used to work out its row from
 * screen travel alone (`dyPx` over one row pitch), so scrolling mid-drag moved the
 * rows under a clip that did not follow them, and the next mousemove snapped it
 * to a row counted from where it started. And nothing scrolled on its own, so a
 * track out of view was out of reach: with the destination at the top and the
 * clip far below, the only way across was to make the panel taller.
 *
 * The first is `contentTravel`: travel is measured in content px, screen travel
 * plus whatever scrolled since the press, so any scroll (this loop's, the
 * wheel's, the trackpad's) only has to re-run the resolver for the clip to stay
 * under the pointer. The second is the edge loop below it. Everything here is
 * DOM-free; the canvas supplies the measurements and the frame clock through
 * `EdgeScrollPort`.
 */

import type { FrameScheduler } from "../caption/previewLoop";
import { DRAG, type DragPhase } from "./dragMachine";
import type { RowRange } from "./dragResolve";
import { RULER_OFFSET, type RowStack } from "./layout";

export const EDGE_SCROLL = {
  /**
   * How far inside the visible edge scrolling begins.
   *
   * About half a row. A whole row would make the top visible row impossible to
   * aim at while there are more above it: it would start scrolling away the
   * moment the clip reached it.
   */
  ZONE_PX: 24,
  /**
   * Depth past the zone's inner line at which speed tops out.
   *
   * Deliberately more than the zone, so the ramp carries on past the canvas's
   * own edge, into the ruler, the toolbar and the track headers. The window
   * listener keeps tracking out there, and "further means faster" is what
   * every editor does.
   */
  RAMP_PX: 120,
  /** Speed on entering the zone, about three rows a second. */
  MIN_PX_PER_S: 150,
  /** Speed at full depth, about twenty-seven rows a second. */
  MAX_PX_PER_S: 1200,
  /**
   * The longest step one frame may take.
   *
   * A frame that arrives late (a GC pause, a heavy repaint) would otherwise
   * scroll by its whole gap at once and throw the view several rows past what
   * the user was watching.
   */
  MAX_STEP_MS: 50,
  /**
   * Travel towards an edge that arms it, for a press made inside its zone.
   *
   * The same number that unlocks a row change: "the hand meant to go that
   * way" is the same judgement in both places.
   */
  ARM_PX: DRAG.VERTICAL_ENTER_PX,
} as const;

export type EdgeScrollConfig = typeof EDGE_SCROLL;

/** The visible stretch of one axis, in canvas px: where a zone is measured from. */
export type Band = { lo: number; hi: number };

/** Which of an axis's two zones may scroll. Sticky for the life of a gesture. */
export type EdgeArm = { low: boolean; high: boolean };

export type Point = { x: number; y: number };

export type ScrollPair = { h: number; v: number };

export const UNARMED: EdgeArm = { low: false, high: false };

/**
 * How far the pointer has travelled through the *content*, not the screen.
 *
 * A row's top is `RULER_OFFSET + stack.tops[i] - vScroll` and a time's x
 * is `msToPx(ms) - hScroll`, so the content under a screen point is that point
 * plus the scroll. Travel since the press is therefore screen travel plus the
 * scroll's own change. Kept apart from the canvas because the sign is the one
 * thing here that can be wrong while every row still looks plausible.
 */
export function contentTravel(
  screen: { dx: number; dy: number },
  scrollAtDown: ScrollPair,
  scrollNow: ScrollPair,
): { dx: number; dy: number } {
  return {
    dx: screen.dx + (scrollNow.h - scrollAtDown.h),
    dy: screen.dy + (scrollNow.v - scrollAtDown.v),
  };
}

/**
 * Travel along one axis, held so the pointer it implies stays inside `band`.
 *
 * The time-axis half of keeping a carried clip in sight: past the left or
 * right edge, the grabbed instant waits at the edge while the view scrolls to
 * it, instead of running on under the track headers or off the window.
 */
export function pinToBand(origin: number, travel: number, band: Band): number {
  if (!(band.hi > band.lo)) {
    return travel;
  }
  return Math.min(band.hi, Math.max(band.lo, origin + travel)) - origin;
}

/**
 * The rows wholly inside `band` at this scroll, or null when none fits.
 *
 * The row half of keeping a carried clip in sight, handed to `resolveMove` as
 * its `rows`. Wholly, not partly: a clip parked on a row the ruler half covers
 * is a clip half hidden, and that is the row it would be dropped on.
 */
export function wholeRowsInView(
  vScroll: number,
  band: Band,
  stack: RowStack,
  topOffset: number = RULER_OFFSET,
): RowRange | null {
  // Row `i`'s top on screen is `topOffset + stack.tops[i] - vScroll`. Tops and
  // bottoms both rise with `i`, so "top below the band's top" holds from some
  // row onwards and "bottom above the band's bottom" up to some row, and the
  // rows wholly in view are the run between the two.
  const n = stack.ids.length;
  let first = n;
  for (let i = 0; i < n; i++) {
    if (topOffset + stack.tops[i] - vScroll >= band.lo) {
      first = i;
      break;
    }
  }
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (topOffset + stack.tops[i] + stack.heights[i] - vScroll <= band.hi) {
      last = i;
      break;
    }
  }
  return first <= last ? { first, last } : null;
}

/**
 * Which axes a gesture may scroll.
 *
 * A slide (`moveH`) has its vertical locked, so scrolling rows past it would
 * only carry the clip's own row out of view. Only a freed clip can change
 * row, and only a clip move uses either: a trim, a level drag and a band are
 * left alone.
 */
export function scrollAxesOf(phase: DragPhase): { x: boolean; y: boolean } {
  if (phase === "moveFree") {
    return { x: true, y: true };
  }
  if (phase === "moveH") {
    return { x: true, y: false };
  }
  return { x: false, y: false };
}

/**
 * The zone's depth for a band, shrunk on a band too short to hold two.
 *
 * A third of the band at most, so the two zones can never overlap and a
 * pointer is never inside both.
 */
function zoneOf(band: Band, cfg: EdgeScrollConfig): number {
  return Math.min(cfg.ZONE_PX, Math.max(0, band.hi - band.lo) / 3);
}

function speedAt(depth: number, cfg: EdgeScrollConfig): number {
  const t = Math.min(1, depth / cfg.RAMP_PX);
  return cfg.MIN_PX_PER_S + (cfg.MAX_PX_PER_S - cfg.MIN_PX_PER_S) * t * t;
}

/**
 * Signed scroll speed along one axis, in px per second.
 *
 * Negative towards `lo` (up, or left). Zero outside both zones, inside a zone
 * that is not armed, and for a band with no extent, which is a panel collapsed
 * to nothing.
 */
export function axisVelocity(
  pos: number,
  band: Band,
  armed: EdgeArm,
  cfg: EdgeScrollConfig = EDGE_SCROLL,
): number {
  if (!(band.hi > band.lo) || !Number.isFinite(pos)) {
    return 0;
  }
  const zone = zoneOf(band, cfg);

  const lowDepth = band.lo + zone - pos;
  if (armed.low && lowDepth > 0) {
    return -speedAt(lowDepth, cfg);
  }
  const highDepth = pos - (band.hi - zone);
  if (armed.high && highDepth > 0) {
    return speedAt(highDepth, cfg);
  }
  return 0;
}

/**
 * Arm whichever zones the pointer has earned the right to use.
 *
 * Without this, pressing a clip on the last visible row presses inside the
 * bottom zone, and lifting it towards a row *above* would first scroll the view
 * down, away from where the hand is going. A zone arms when either
 *
 * - the pointer has travelled `ARM_PX` towards it from the press, which is the
 *   same clip being pulled down to a hidden row below, or
 * - the pointer has been outside it at any moment of the gesture, which is
 *   every zone the press did not start in.
 *
 * Once armed, a zone stays armed until the gesture ends.
 */
export function updateArm(
  prev: EdgeArm,
  pos: number,
  origin: number,
  band: Band,
  cfg: EdgeScrollConfig = EDGE_SCROLL,
): EdgeArm {
  const zone = zoneOf(band, cfg);
  const low =
    prev.low || pos >= band.lo + zone || origin - pos >= cfg.ARM_PX;
  const high =
    prev.high || pos <= band.hi - zone || pos - origin >= cfg.ARM_PX;
  return low === prev.low && high === prev.high ? prev : { low, high };
}

/**
 * Move `current` by `delta`, without crossing `[min, max]`.
 *
 * Returns `current` itself when the step would not move it, which is how the
 * loop learns it has reached an end. A scroll already past `max` (the wheel
 * scrolls the rows without a lower limit) is not pulled back: a step further
 * down declines, a step up proceeds from where it is.
 */
export function scrollStep(
  current: number,
  delta: number,
  min: number,
  max: number,
): number {
  if (delta > 0) {
    return current >= max ? current : Math.min(max, current + delta);
  }
  if (delta < 0) {
    return current <= min ? current : Math.max(min, current + delta);
  }
  return current;
}

/**
 * The furthest the rows may be scrolled by a drag.
 *
 * `totalHeight` is `layout.ts`'s: the ruler's strip plus each row and the gap
 * after it, so the last row's bottom sits one `TRACK_GAP` short of it. At this
 * scroll that bottom lands one gap above `visibleBottom`, the last pixel not
 * covered by the chrome beneath the canvas.
 */
export function maxVerticalScroll(
  totalHeight: number,
  visibleBottom: number,
): number {
  return Math.max(0, totalHeight - visibleBottom);
}

export type EdgeScrollPort = {
  scheduler: FrameScheduler;
  now(): number;
  /** Speed on each axis for the pointer as it stands, in px per second. */
  velocity(): { x: number; y: number };
  /** Scroll by this much on each axis. Whether anything actually moved. */
  scrollBy(dx: number, dy: number): boolean;
};

export type EdgeScroller = {
  /** Start the loop if the pointer now calls for it. Cheap; call on every move. */
  update(): void;
  stop(): void;
  readonly running: boolean;
};

/**
 * The loop that keeps scrolling while the pointer is still.
 *
 * Pointer events alone cannot do it: a hand parked at the edge sends no
 * mousemove, and the view has to keep going. So once started, each frame reads
 * the speed again and steps by it, scaled by the frame's real duration so a
 * 120Hz panel scrolls no faster than a 60Hz one. It stops itself when the
 * pointer leaves the zones or the scroll meets an end; the next move restarts
 * it if there is somewhere to go again.
 */
export function createEdgeScroller(
  port: EdgeScrollPort,
  cfg: EdgeScrollConfig = EDGE_SCROLL,
): EdgeScroller {
  let pending: number | null = null;
  let last = 0;

  const still = (v: { x: number; y: number }) => v.x === 0 && v.y === 0;

  const frame = () => {
    pending = null;
    const now = port.now();
    const dt = Math.min(Math.max(0, now - last), cfg.MAX_STEP_MS);
    last = now;

    const v = port.velocity();
    if (still(v)) {
      return;
    }
    // A frame with no elapsed time has nothing to step, and is not the end of
    // the road: reading it as "nothing moved" would stop a loop that has
    // somewhere to go.
    if (dt > 0 && !port.scrollBy((v.x * dt) / 1000, (v.y * dt) / 1000)) {
      return;
    }
    pending = port.scheduler.request(frame);
  };

  return {
    update() {
      if (pending != null || still(port.velocity())) {
        return;
      }
      last = port.now();
      pending = port.scheduler.request(frame);
    },
    stop() {
      if (pending != null) {
        port.scheduler.cancel(pending);
        pending = null;
      }
    },
    get running() {
      return pending != null;
    },
  };
}
