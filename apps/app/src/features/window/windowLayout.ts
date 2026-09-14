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
  /** Open order. The highest is focused and, when floating, on top. */
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

export type WindowRects = {
  id: string;
  rect: Rect;
  /** Null for a window that cannot be resized, and for a floating one. */
  splitter: Rect | null;
};

export type HostLayout = {
  /** What is left for the host's own content once every window has its share. */
  content: Rect;
  windows: WindowRects[];
};

/**
 * Lay a host region out.
 *
 * Docked windows are carved off the free rect one at a time in `z` order, so
 * the first one opened sits outermost and a second one docked to the same side
 * stacks inside it. Floating windows take no space and are clamped into the
 * host afterwards.
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

  const ordered = [...windows].sort((a, b) => a.z - b.z);
  const out: WindowRects[] = [];

  for (const win of ordered) {
    if (win.placement.mode === "floating") {
      continue;
    }

    const { side, sizePct } = win.placement;
    const axis = axisOf(side);
    const available = free[axis];

    // A splitter that would be wider than the space it divides is not a
    // splitter, it is the whole region. Dropping it keeps the tiling exact.
    const splitterSpan =
      win.resizable && available > SPLITTER_PX ? SPLITTER_PX : 0;

    const size = fitSpan(
      Math.round((sizePct / 100) * Math.max(0, host[axis])),
      win.minSize[axis],
      available - splitterSpan,
      CONTENT_MIN[axis],
    );

    const carved = carve(free, side, size, splitterSpan);
    out.push({
      id: win.id,
      rect: sane(carved.window),
      splitter: carved.splitter,
    });
    free = carved.rest;
  }

  for (const win of ordered) {
    if (win.placement.mode !== "floating") {
      continue;
    }
    out.push({
      id: win.id,
      rect: clampRect(win.placement.rect, host, win.minSize),
      splitter: null,
    });
  }

  // Back into the order the caller gave, so a caller keying off the array
  // position rather than the id is not quietly reading someone else's rect.
  const byId = new Map(out.map((entry) => [entry.id, entry]));
  return {
    content: sane(free),
    windows: windows.map((win) => byId.get(win.id)!).filter(Boolean),
  };
}

/** Take `size` off one side of `free`, leaving a splitter behind it. */
function carve(
  free: Rect,
  side: DockSide,
  size: number,
  splitterSpan: number,
): { window: Rect; splitter: Rect | null; rest: Rect } {
  const splitterAt = (
    x: number,
    y: number,
    w: number,
    h: number,
  ): Rect | null => (splitterSpan > 0 ? { x, y, width: w, height: h } : null);

  if (side === "left") {
    return {
      window: { x: free.x, y: free.y, width: size, height: free.height },
      splitter: splitterAt(free.x + size, free.y, splitterSpan, free.height),
      rest: {
        x: free.x + size + splitterSpan,
        y: free.y,
        width: free.width - size - splitterSpan,
        height: free.height,
      },
    };
  }

  if (side === "right") {
    const x = free.x + free.width - size;
    return {
      window: { x, y: free.y, width: size, height: free.height },
      splitter: splitterAt(x - splitterSpan, free.y, splitterSpan, free.height),
      rest: {
        x: free.x,
        y: free.y,
        width: free.width - size - splitterSpan,
        height: free.height,
      },
    };
  }

  if (side === "top") {
    return {
      window: { x: free.x, y: free.y, width: free.width, height: size },
      splitter: splitterAt(free.x, free.y + size, free.width, splitterSpan),
      rest: {
        x: free.x,
        y: free.y + size + splitterSpan,
        width: free.width,
        height: free.height - size - splitterSpan,
      },
    };
  }

  const y = free.y + free.height - size;
  return {
    window: { x: free.x, y, width: free.width, height: size },
    splitter: splitterAt(free.x, y - splitterSpan, free.width, splitterSpan),
    rest: {
      x: free.x,
      y: free.y,
      width: free.width,
      height: free.height - size - splitterSpan,
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
