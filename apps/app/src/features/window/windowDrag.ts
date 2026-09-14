/**
 * Where a window lands when it is dragged.
 *
 * The split `dragResolve.ts` makes for the timeline, applied to window chrome:
 * the component decides *that* a gesture is happening, and this decides *where
 * it ends up*. Without the split the arithmetic would live in a `mousemove`
 * handler on a Lit element, which is where the four existing splitters keep
 * theirs and is why none of them has a test.
 *
 * There is no DOM here. A gesture arrives as two points in host-relative
 * pixels and leaves as a `WindowPlacement`, so every case below is reachable
 * under `environment: "node"`.
 *
 * ## Declining
 *
 * A resolver returns `{ kind: "none" }` when the gesture would change nothing,
 * the arm `MovePlan` and `TrimPlan` already use. The comparison is made against
 * the **clamped** result rather than against the raw pointer delta, and that is
 * the whole reason this imports `fitSpan` and `clampRect` from `windowLayout`
 * instead of clamping for itself: a splitter held hard against its limit is the
 * normal end state of a drag, and a resolver that answered "changed" for every
 * mouse move there would write to the store sixty times a second while nothing
 * on screen moved at all.
 */

import {
  CONTENT_MIN,
  axisOf,
  clampRect,
  fitSpan,
  pctForSize,
  type Rect,
  type Size,
  type WindowPlacement,
} from "./windowLayout";

export type Point = { x: number; y: number };

/**
 * What is being dragged.
 *
 * `move` is the title bar. The eight compass points are the resize handles, and
 * for a docked window exactly one of them is the splitter: the handle on the
 * edge that faces the content. A docked window's other seven edges are the
 * host's own edges and cannot move, so a gesture naming one of them declines
 * rather than being silently reinterpreted as the splitter.
 */
export type DragHandle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

export type WindowDragInput = {
  /** The placement as it stood when the pointer went down. */
  origin: WindowPlacement;
  /**
   * The window's rect as laid out at that moment, host-relative px.
   *
   * Passed in rather than recomputed from `origin`, because `layoutHost` may
   * have carved space for other windows first: re-deriving the size from the
   * percentage alone would be right only for the one-window case and would
   * silently jump the splitter on the day a second window was docked.
   */
  originRect: Rect;
  host: Size;
  minSize: Size;
  /** Pointer at press, host-relative px. */
  from: Point;
  /** Pointer now, host-relative px. */
  to: Point;
  handle: DragHandle;
};

export type WindowDragPlan =
  | { kind: "none" }
  | { kind: "place"; placement: WindowPlacement };

const DECLINED: WindowDragPlan = { kind: "none" };

/**
 * The handle that is the splitter, for each dock side.
 *
 * Exported so `windowHost.ts` draws the strip on the same edge this module
 * accepts a drag from. Two copies of this table is a splitter you can see and
 * cannot move.
 */
export const SPLITTER_HANDLE = {
  left: "e",
  right: "w",
  top: "s",
  bottom: "n",
} as const;

export function resolveWindowDrag(input: WindowDragInput): WindowDragPlan {
  return input.origin.mode === "docked"
    ? resolveDockedDrag(input, input.origin)
    : resolveFloatingDrag(input, input.origin);
}

function resolveDockedDrag(
  input: WindowDragInput,
  origin: Extract<WindowPlacement, { mode: "docked" }>,
): WindowDragPlan {
  if (input.handle !== SPLITTER_HANDLE[origin.side]) {
    return DECLINED;
  }

  const axis = axisOf(origin.side);
  const delta =
    axis === "width" ? input.to.x - input.from.x : input.to.y - input.from.y;

  // A window docked right or bottom grows when the pointer moves *towards* the
  // origin, because its far edge is pinned to the host and the splitter is its
  // near one. Getting this sign wrong makes the splitter run away from the
  // cursor, which reads as the drag having been dropped.
  const towardsContent = origin.side === "right" || origin.side === "bottom";
  const wanted = input.originRect[axis] + (towardsContent ? -delta : delta);

  const available = Math.max(0, input.host[axis]);
  const sized = fitSpan(
    Math.round(wanted),
    input.minSize[axis],
    available,
    CONTENT_MIN[axis],
  );

  if (sized === input.originRect[axis]) {
    return DECLINED;
  }

  const sizePct = pctForSize(input.host, origin.side, sized);
  if (sizePct === origin.sizePct) {
    return DECLINED;
  }

  return { kind: "place", placement: { mode: "docked", side: origin.side, sizePct } };
}

function resolveFloatingDrag(
  input: WindowDragInput,
  origin: Extract<WindowPlacement, { mode: "floating" }>,
): WindowDragPlan {
  const dx = input.to.x - input.from.x;
  const dy = input.to.y - input.from.y;
  const start = origin.rect;

  const moved =
    input.handle === "move"
      ? { ...start, x: start.x + dx, y: start.y + dy }
      : resizeRect(start, input.handle, dx, dy, input.minSize);

  const rect = clampRect(moved, input.host, input.minSize);

  if (
    rect.x === start.x &&
    rect.y === start.y &&
    rect.width === start.width &&
    rect.height === start.height
  ) {
    return DECLINED;
  }

  return { kind: "place", placement: { mode: "floating", rect } };
}

/**
 * Resize from one of the eight handles.
 *
 * The rule that matters is what happens at the minimum when a *near* edge is
 * the one being dragged. Pulling the west handle right past the minimum width
 * must pin the west edge and leave the east one where it is; the naive
 * `x += dx; width -= dx` instead keeps moving `x` while `width` clamps, so the
 * window walks across the host while appearing to stay the same size.
 */
function resizeRect(
  start: Rect,
  handle: DragHandle,
  dx: number,
  dy: number,
  min: Size,
): Rect {
  let { x, y, width, height } = start;

  if (handle.includes("e")) {
    width = Math.max(min.width, start.width + dx);
  }
  if (handle.includes("w")) {
    const right = start.x + start.width;
    width = Math.max(min.width, start.width - dx);
    x = right - width;
  }
  if (handle.includes("s")) {
    height = Math.max(min.height, start.height + dy);
  }
  if (handle.includes("n")) {
    const bottom = start.y + start.height;
    height = Math.max(min.height, start.height - dy);
    y = bottom - height;
  }

  return { x, y, width, height };
}
