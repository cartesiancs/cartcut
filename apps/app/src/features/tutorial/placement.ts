/**
 * Where the tutorial's card and ring go, beside whatever a step points at.
 *
 * The same shape of rule `menu/menuPlacement.ts` follows for menus, on four
 * sides instead of two: try the step's preferred side, then its opposite, then
 * the other two, and only when none of them can hold the card let it sit over
 * the target. `html, body { overflow: hidden }` means there is no scrolling to
 * a card pushed off the window, so every result is clamped inside it.
 *
 * DOM-free, like the menu version, and every field of every result is finite
 * for any input: a card placed at `NaN` is not in the wrong place, it is
 * nowhere.
 */

import { MENU_MARGIN_PX, type Size } from "../menu/menuPlacement";
import { msToPxSigned } from "../timeline/geometry";
import type { Side } from "./steps";

export type Rect = { left: number; top: number; width: number; height: number };

/** How far the ring stands off the target, in px, so it outlines rather than covers. */
export const RING_PAD_PX = 4;

/** How far the arrow's tip stands off the card's edge: a 10px square turned 45deg, half out. */
export const ARROW_PX = 7;

/**
 * The gap between the target and the card's edge. Wider than the ring's pad
 * and the arrow together, so the arrow's tip stops short of the ring.
 */
export const COACHMARK_GAP_PX = 14;

/** The card's corner radius. The arrow is kept off the rounded part. */
export const CARD_RADIUS_PX = 12;

/** Where a card with nothing to point at floats, above the window's bottom edge. */
export const FLOATING_BOTTOM_PX = 24;

export type CoachmarkPlacement = {
  left: number;
  top: number;
  /** The card's side of the target, or `none` when it points at nothing. */
  side: Side | "none";
  /**
   * The arrow's position along the edge that faces the target, from the
   * card's top (left and right sides) or its left (top and bottom).
   */
  arrow: number;
  /** No side could hold the card, so it was clamped over the target. */
  overlaps: boolean;
};

export type PlaceCoachmarkOptions = {
  side: Side;
  /** A point to aim at inside the target; its centre by default. */
  anchor?: { x?: number; y?: number };
  margin?: number;
  gap?: number;
  /**
   * The height of the title bar. It is a window drag region, so a card over
   * it would take no clicks.
   */
  insetTop?: number;
};

const ORDER: Record<Side, Side[]> = {
  right: ["right", "left", "bottom", "top"],
  left: ["left", "right", "bottom", "top"],
  top: ["top", "bottom", "right", "left"],
  bottom: ["bottom", "top", "right", "left"],
};

/** The sides to try, best first. */
export const sideOrder = (preferred: Side): Side[] =>
  ORDER[preferred] ?? ORDER.right;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  // `max < min` when the thing is larger than the room it has; pin the start,
  // as `menuPlacement` does.
  return max < min ? min : Math.min(Math.max(value, min), max);
}

const isHorizontal = (side: Side) => side === "left" || side === "right";

export function placeCoachmark(
  target: Rect,
  card: Size,
  viewport: Size,
  opts: PlaceCoachmarkOptions,
): CoachmarkPlacement {
  const margin = Math.max(0, finite(opts.margin, MENU_MARGIN_PX));
  const gap = Math.max(0, finite(opts.gap, COACHMARK_GAP_PX));

  const vw = Math.max(0, finite(viewport.w, 0));
  const vh = Math.max(0, finite(viewport.h, 0));
  const insetTop = clamp(finite(opts.insetTop, 0), 0, vh);

  const cw = Math.max(0, finite(card.w, 0));
  const ch = Math.max(0, finite(card.h, 0));

  const minX = margin;
  const maxX = vw - margin;
  const minY = insetTop + margin;
  const maxY = vh - margin;

  const tl = finite(target.left, 0);
  const tt = finite(target.top, 0);
  const tr = tl + Math.max(0, finite(target.width, 0));
  const tb = tt + Math.max(0, finite(target.height, 0));

  // Inside the target and inside the room the card has, so the arrow always
  // lands on a part of the target the user can see.
  const ax = clamp(
    finite(opts.anchor?.x, (tl + tr) / 2),
    Math.max(tl, minX),
    Math.min(tr, maxX),
  );
  const ay = clamp(
    finite(opts.anchor?.y, (tt + tb) / 2),
    Math.max(tt, minY),
    Math.min(tb, maxY),
  );

  const room: Record<Side, number> = {
    right: maxX - (tr + gap),
    left: tl - gap - minX,
    top: tt - gap - minY,
    bottom: maxY - (tb + gap),
  };

  const need = (side: Side) => (isHorizontal(side) ? cw : ch);
  const fits = (side: Side) =>
    room[side] >= need(side) &&
    (isHorizontal(side) ? ch <= maxY - minY : cw <= maxX - minX);

  const at = (side: Side) => {
    switch (side) {
      case "right":
        return { left: tr + gap, top: clamp(ay - ch / 2, minY, maxY - ch) };
      case "left":
        return { left: tl - gap - cw, top: clamp(ay - ch / 2, minY, maxY - ch) };
      case "top":
        return { left: clamp(ax - cw / 2, minX, maxX - cw), top: tt - gap - ch };
      case "bottom":
        return { left: clamp(ax - cw / 2, minX, maxX - cw), top: tb + gap };
    }
  };

  const arrowFor = (side: Side, left: number, top: number) => {
    const length = isHorizontal(side) ? ch : cw;
    const along = isHorizontal(side) ? ay - top : ax - left;
    const keep = CARD_RADIUS_PX + ARROW_PX;
    return length < keep * 2 ? length / 2 : clamp(along, keep, length - keep);
  };

  const order = sideOrder(opts.side);
  const side = order.find(fits);

  if (side) {
    const { left, top } = at(side);
    return { left, top, side, arrow: arrowFor(side, left, top), overlaps: false };
  }

  // Nowhere fits: take the roomiest side and keep the card on screen, even
  // though that puts it over the target. The ring still shows through around
  // it, and the user can still reach Next.
  const roomiest = order.reduce((best, s) =>
    room[s] - need(s) > room[best] - need(best) ? s : best,
  );
  const raw = at(roomiest);
  const left = clamp(raw.left, minX, maxX - cw);
  const top = clamp(raw.top, minY, maxY - ch);

  return {
    left,
    top,
    side: roomiest,
    arrow: arrowFor(roomiest, left, top),
    overlaps:
      intersectRects(
        { left, top, width: cw, height: ch },
        { left: tl, top: tt, width: tr - tl, height: tb - tt },
      ) !== null,
  };
}

/** A card that points at nothing: centred above the window's bottom edge. */
export function floatingPlacement(
  card: Size,
  viewport: Size,
  insetTop = 0,
  margin = MENU_MARGIN_PX,
): CoachmarkPlacement {
  const vw = Math.max(0, finite(viewport.w, 0));
  const vh = Math.max(0, finite(viewport.h, 0));
  const cw = Math.max(0, finite(card.w, 0));
  const ch = Math.max(0, finite(card.h, 0));
  const m = Math.max(0, finite(margin, MENU_MARGIN_PX));
  const inset = clamp(finite(insetTop, 0), 0, vh);

  return {
    left: clamp((vw - cw) / 2, m, vw - m - cw),
    top: clamp(vh - FLOATING_BOTTOM_PX - ch, inset + m, vh - m - ch),
    side: "none",
    arrow: 0,
    overlaps: false,
  };
}

/**
 * The ring around a target: the target grown by `pad`, then cut to the
 * window, so a control flush with the window's edge (the sidebar's buttons)
 * still shows all four sides of it.
 */
export function ringRect(
  target: Rect,
  viewport: Size,
  pad: number = RING_PAD_PX,
): Rect {
  const vw = Math.max(0, finite(viewport.w, 0));
  const vh = Math.max(0, finite(viewport.h, 0));
  const p = Math.max(0, finite(pad, RING_PAD_PX));

  const tl = finite(target.left, 0);
  const tt = finite(target.top, 0);
  const tr = tl + Math.max(0, finite(target.width, 0));
  const tb = tt + Math.max(0, finite(target.height, 0));

  const left = clamp(tl - p, 0, vw);
  const top = clamp(tt - p, 0, vh);
  const right = clamp(tr + p, 0, vw);
  const bottom = clamp(tb + p, 0, vh);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** The overlap of two rects, or null when they do not overlap. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);

  if (!(right > left && bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * How far a scroll container has to scroll for `element` to be inside it,
 * with `margin` to spare. Negative scrolls up. An element taller than the
 * container is aligned by its top, the part with its label.
 *
 * Only ever applied to one container's `scrollTop`, and never through
 * `scrollIntoView`: that also scrolls `overflow: hidden` ancestors, and in
 * this layout those are the split panes, so it can shift the whole editor.
 */
export function revealDelta(
  element: Rect,
  scroller: Rect,
  margin = MENU_MARGIN_PX,
): number {
  const above = element.top - (scroller.top + margin);
  const below =
    element.top + element.height - (scroller.top + scroller.height - margin);

  if (!Number.isFinite(above) || !Number.isFinite(below)) return 0;
  if (above < 0) return above;
  if (below > 0) return Math.min(below, above);
  return 0;
}

/**
 * The playhead's x in the window, from the ruler's left edge.
 *
 * The same sum `elementTimelineRuler#paintRuler` draws it at, `+ 1` being the
 * middle of the 2px line, so the arrow lands on the line and not beside it.
 */
export function playheadClientX(
  rulerLeft: number,
  cursorMs: number,
  range: number,
  scroll: number,
): number | null {
  const x = rulerLeft + msToPxSigned(cursorMs, range) - scroll + 1;
  return Number.isFinite(x) ? x : null;
}
