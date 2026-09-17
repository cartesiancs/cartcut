/**
 * Where a window sits inside its host, as arithmetic.
 *
 * This is the module that defines "not clipped". Everything else in the feature
 * is chrome around it: `windowHost.ts` asks this for rects and writes them to
 * inline styles, `windowDrag.ts` produces the numbers this consumes, and the
 * e2e spec measures in pixels what this claims in numbers.
 *
 * The host region is a box of a known size and nothing else. There is no DOM
 * here and no store, so the whole layout is testable under
 * `environment: "node"` and a failure is a number rather than a screenshot.
 *
 * ## The precedence that decides every clamp
 *
 * Three claims compete for one axis, and they are ranked:
 *
 *   **host > window min > content min**
 *
 * The host always wins, because a rect outside it is not smaller than someone
 * wanted, it is *invisible*: `#split_col_2` carries `overflow: hidden` on both
 * axes, so a window that overruns is silently cut off rather than scrolled to.
 * A window pinned below its own minimum looks cramped; a window past the host's
 * edge looks broken, and looks broken in a way that no `getBoundingClientRect`
 * check can see. `uiStore`'s own `clamp` makes the same choice one level up,
 * where it writes `Math.max(min, max)` so a pane pinned at its minimum stays
 * visible even when the bound it is clamped against is out of range.
 *
 * Below the host, a window's own minimum outranks the content's, because a
 * window shrunk past its minimum has controls stacked on top of each other
 * while the content region is usually a canvas that simply gets smaller.
 *
 * ## Frames
 *
 * Every window docked to one side of a host shares **one frame**, and each is a
 * tab on that frame's title bar, the way `<preview-top-bar>` holds the record
 * and proxy panels. Two windows on one side used to be carved as two columns,
 * which put a second title bar and a second splitter beside the first and left
 * the preview a third of the column.
 *
 * The frame is derived here and never stored. `WindowState` stays one entry per
 * window, so opening, closing and focusing are the same ops they always were:
 * the tab on show is simply the member with the highest `z`.
 */

export type Size = { width: number; height: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type DockSide = "left" | "right" | "top" | "bottom";

/**
 * Docked carries a **percentage**, floating carries **pixels**, and the
 * difference is not a detail.
 *
 * A docked window's share of the host has to survive the host changing size:
 * dragging the main preview splitter must not make the caption window a
 * different fraction of what is left. That is the same reason `uiStore` holds
 * its three columns as percentages.
 *
 * A floating window is the opposite. It was put somewhere, and "somewhere" is
 * an absolute position; re-deriving it from a fraction on every resize would
 * make the window crawl across the region whenever the user dragged a splitter
 * on the other side of the app.
 */
export type WindowPlacement =
  | { mode: "docked"; side: DockSide; sizePct: number }
  | { mode: "floating"; rect: Rect };

/**
 * One window, as state.
 *
 * No `title` and no `icon`. Those are how a window is *presented*, they are
 * localised, and the caller already holds both, so putting them here would make
 * the window system import a locale controller to render a string it was handed
 * anyway. `windowHost.ts` takes them beside the content instead.
 */
export type WindowState = {
  id: string;
  /** Which host region it belongs to. One host may hold several windows. */
  hostId: string;
  placement: WindowPlacement;
  minSize: Size;
  /** A window with no splitter and no resize handles. */
  resizable: boolean;
  /** Whether the title bar offers a close button. */
  closable: boolean;
  /**
   * Focus order. The highest is focused: the tab on show in its frame and, when
   * floating, on top. Open order is the window's position in the array, which
   * focusing never changes.
   */
  z: number;
};

/**
 * The draggable strip between the content region and a docked window, in px.
 *
 * This is the area the pointer has to hit, and nothing else. What is *drawn* is
 * `0.05rem`, the weight every other divider in the app uses, and `_window.scss`
 * puts it in the strip's `::after`. The two are separate numbers because a
 * hairline is the right thing to see and the wrong thing to have to aim at.
 */
export const SPLITTER_PX = 3;

/**
 * What the content region keeps for itself, in px.
 *
 * Small on purpose. This is not "enough to be useful", it is "enough that the
 * region is visibly still there": a user who drags the splitter to the far edge
 * means it, and a floor that fought them would read as a stuck splitter. The
 * window's own `minSize` is the one that carries real layout weight.
 */
export const CONTENT_MIN: Size = { width: 120, height: 96 };

/** The title bar's height, in px. 2rem, matching `<preview-top-bar>`. */
export const TITLE_BAR_PX = 32;

/** Which of a size's two fields a dock side eats into. */
export const axisOf = (side: DockSide): "width" | "height" =>
  side === "left" || side === "right" ? "width" : "height";

/**
 * One span, under the precedence above.
 *
 * The order of the three lines *is* the precedence, and reordering them is how
 * this goes wrong: capping against `available` anywhere but last lets a later
 * `Math.max` push the result back outside the host.
 *
 * Exported because `windowDrag.ts` has to clamp a gesture the same way this
 * module will clamp the result of it. Two copies would disagree at exactly the
 * edges, which is where a splitter spends most of its life: the drag would keep
 * reporting a change while the layout kept answering the same number, so a
 * splitter held against the edge would record a write per mouse move forever.
 */
export function fitSpan(
  requested: number,
  min: number,
  available: number,
  reserve = 0,
): number {
  let size = Math.max(requested, min);
  size = Math.min(size, Math.max(min, available - reserve));
  size = Math.min(size, available);
  return Math.max(0, size);
}

/** A rect with no negative extent, which is the only shape CSS can draw. */
const sane = (rect: Rect): Rect => ({
  x: rect.x,
  y: rect.y,
  width: Math.max(0, rect.width),
  height: Math.max(0, rect.height),
});

export type WindowFrame = {
  /**
   * `dock:<side>` or `float:<id>`.
   *
   * Named after the dock and not after a tab, so it survives the first tab
   * closing. `<window-host>` keys its frames by this, and a key that changed
   * would make Lit build a new frame and a new copy of every panel in it,
   * dropping whatever the remaining tab was in the middle of.
   */
  key: string;
  /** Every window in the frame, in the order they were opened. */
  tabs: string[];
  /** The tab on show: the member with the highest `z`. */
  active: string;
  rect: Rect;
  /**
   * The grab strip, or null for a frame that cannot be resized or is floating.
   *
   * Overlaps the content region rather than sitting between it and the frame.
   * It is **not** part of the tiling: `content` and the frames account for the
   * whole host on their own.
   */
  splitter: Rect | null;
  /**
   * The largest minimum of any tab, per axis.
   *
   * The frame is laid out against this and not against the active tab's own,
   * so switching tabs never changes the frame's size. A splitter drag has to be
   * clamped against the same number, which is why it is returned.
   */
  minSize: Size;
};

export type HostLayout = {
  /** What is left for the host's own content once every frame has its share. */
  content: Rect;
  frames: WindowFrame[];
};

export const frameKey = (win: WindowState): string =>
  win.placement.mode === "docked" ? `dock:${win.placement.side}` : `float:${win.id}`;

/** The member on show. The earliest wins a tie, so equal `z` is still an answer. */
export const activeOf = (members: WindowState[]): WindowState =>
  members.reduce((top, win) => (win.z > top.z ? win : top));

const largestMin = (members: WindowState[]): Size =>
  members.reduce<Size>(
    (min, win) => ({
      width: Math.max(min.width, win.minSize.width),
      height: Math.max(min.height, win.minSize.height),
    }),
    { width: 0, height: 0 },
  );

/**
 * The share of the frame docked to `side` of `hostId`, or undefined when there
 * is no such frame.
 *
 * Read from the tab on show, which is the one `layoutHost` reads. `windowOps`
 * keeps every member at the same share, so in practice any member answers the
 * same; reading the active one means a list that broke that rule still lays out
 * the way the user is looking at it.
 */
export function dockShare(
  windows: WindowState[],
  hostId: string,
  side: DockSide,
  exceptId?: string,
): number | undefined {
  const members = windows.filter(
    (win) =>
      win.id !== exceptId &&
      win.hostId === hostId &&
      win.placement.mode === "docked" &&
      win.placement.side === side,
  );
  if (members.length === 0) {
    return undefined;
  }
  const { placement } = activeOf(members);
  return placement.mode === "docked" ? placement.sizePct : undefined;
}

/**
 * Lay a host region out.
 *
 * Windows docked to the same side become one frame. Frames are carved off the
 * free rect in the order their first tab was opened, so the first dock opened
 * sits outermost and a dock on another side nests inside what it left. That
 * order is array position and not `z`: carving by `z` meant clicking into one
 * dock could swap it with another. Floating windows are frames of one, take no
 * space, and are clamped into the host afterwards.
 *
 * Every rect this returns is inside `{0, 0, host.width, host.height}`. That is
 * the whole contract, and `windowLayout.test.ts` asserts it over a sweep rather
 * than over a handful of chosen cases, because the ways to leave the host are
 * arithmetic accidents rather than scenarios anyone would think to write down.
 */
export function layoutHost(host: Size, windows: WindowState[]): HostLayout {
  let free: Rect = {
    x: 0,
    y: 0,
    width: Math.max(0, host.width),
    height: Math.max(0, host.height),
  };

  // A Map keeps first-insertion order, which is open order.
  const groups = new Map<string, WindowState[]>();
  for (const win of windows) {
    const key = frameKey(win);
    const members = groups.get(key);
    if (members == null) {
      groups.set(key, [win]);
    } else {
      members.push(win);
    }
  }

  const frames = new Map<string, WindowFrame>();

  for (const [key, members] of groups) {
    const active = activeOf(members);
    if (active.placement.mode !== "docked") {
      continue;
    }

    const { side, sizePct } = active.placement;
    const axis = axisOf(side);
    const minSize = largestMin(members);

    const size = fitSpan(
      Math.round((sizePct / 100) * Math.max(0, host[axis])),
      minSize[axis],
      free[axis],
      CONTENT_MIN[axis],
    );

    const carved = carve(free, side, size);
    const rect = sane(carved.window);
    frames.set(key, {
      key,
      tabs: members.map((win) => win.id),
      active: active.id,
      rect,
      // A tab that cannot be resized pins its whole frame: the strip resizes
      // every tab at once, including that one.
      splitter: members.every((win) => win.resizable) ? straddle(rect, side, host) : null,
      minSize,
    });
    free = carved.rest;
  }

  for (const [key, members] of groups) {
    const win = members[0];
    if (win.placement.mode !== "floating") {
      continue;
    }
    frames.set(key, {
      key,
      tabs: [win.id],
      active: win.id,
      rect: clampRect(win.placement.rect, host, win.minSize),
      splitter: null,
      minSize: win.minSize,
    });
  }

  return {
    content: sane(free),
    frames: [...groups.keys()].map((key) => frames.get(key)!),
  };
}

/**
 * The strip the pointer grabs, sitting **outside** the window.
 *
 * It takes no layout space at all. A splitter that carved a gap between the
 * content and the window left `SPLITTER_PX` of whatever is behind the host
 * showing through, which reads as a coloured band down the seam rather than as
 * two panes meeting. `.split-col-bar` makes the same call one level up: it is
 * `position: absolute` at `right: -0.2rem`, overlapping its neighbour rather
 * than pushing it.
 *
 * So the two panes are flush, and this overlays the boundary on the content's
 * side of it, where there is room to spare. The visible hairline is drawn on
 * the strip's window-facing edge, which puts it exactly on the seam.
 */
function straddle(window: Rect, side: DockSide, host: Size): Rect {
  const strip =
    side === "left"
      ? { x: window.x + window.width, y: window.y, width: SPLITTER_PX, height: window.height }
      : side === "right"
        ? { x: window.x - SPLITTER_PX, y: window.y, width: SPLITTER_PX, height: window.height }
        : side === "top"
          ? { x: window.x, y: window.y + window.height, width: window.width, height: SPLITTER_PX }
          : { x: window.x, y: window.y - SPLITTER_PX, width: window.width, height: SPLITTER_PX };

  // Clipped into the host, because a window that has taken the whole region
  // leaves nothing on the content side to overlap and the strip would otherwise
  // start at a negative coordinate. The contract is that every rect this module
  // returns is inside the host, and the strip is no exception.
  const x0 = Math.max(0, strip.x);
  const y0 = Math.max(0, strip.y);
  const x1 = Math.min(Math.max(0, host.width), strip.x + strip.width);
  const y1 = Math.min(Math.max(0, host.height), strip.y + strip.height);

  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Take `size` off one side of `free`. The two panes meet with no gap. */
function carve(
  free: Rect,
  side: DockSide,
  size: number,
): { window: Rect; rest: Rect } {
  if (side === "left") {
    return {
      window: { x: free.x, y: free.y, width: size, height: free.height },
      rest: {
        x: free.x + size,
        y: free.y,
        width: free.width - size,
        height: free.height,
      },
    };
  }

  if (side === "right") {
    const x = free.x + free.width - size;
    return {
      window: { x, y: free.y, width: size, height: free.height },
      rest: {
        x: free.x,
        y: free.y,
        width: free.width - size,
        height: free.height,
      },
    };
  }

  if (side === "top") {
    return {
      window: { x: free.x, y: free.y, width: free.width, height: size },
      rest: {
        x: free.x,
        y: free.y + size,
        width: free.width,
        height: free.height - size,
      },
    };
  }

  const y = free.y + free.height - size;
  return {
    window: { x: free.x, y, width: free.width, height: size },
    rest: {
      x: free.x,
      y: free.y,
      width: free.width,
      height: free.height - size,
    },
  };
}

/**
 * Put a floating rect wholly inside the host.
 *
 * Fully contained rather than "at least the title bar is reachable", which is
 * how a desktop window manager does it. Inside an app region the two rules
 * differ in what they cost when they are wrong: a desktop window dragged half
 * off the screen is still on the screen, and one dragged half out of a region
 * whose ancestor is `overflow: hidden` is simply cut in half with no scrollbar
 * and no edge to grab. Containing it makes "every rect is inside the host" one
 * sentence that covers both modes.
 */
export function clampRect(rect: Rect, host: Size, min: Size): Rect {
  const width = fitSpan(rect.width, min.width, Math.max(0, host.width));
  const height = fitSpan(rect.height, min.height, Math.max(0, host.height));

  return {
    x: Math.min(Math.max(rect.x, 0), Math.max(0, host.width - width)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, host.height - height)),
    width,
    height,
  };
}

/**
 * The percentage a docked window would need to reach `sizePx` on its axis.
 *
 * The inverse of the `sizePct -> px` step in `layoutHost`, and the only way a
 * gesture measured in pixels can be written back into a placement measured in
 * percent. It is here rather than in `windowDrag.ts` so the two directions of
 * the same conversion cannot drift.
 */
export function pctForSize(host: Size, side: DockSide, sizePx: number): number {
  const span = Math.max(1, host[axisOf(side)]);
  return Math.min(100, Math.max(0, (sizePx / span) * 100));
}

/** Whether `inner` lies wholly within `outer`, to a pixel of slack. */
export function contains(outer: Rect, inner: Rect, slack = 1): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/** Whether two rects share any area. Used to assert a window never covers the content. */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
