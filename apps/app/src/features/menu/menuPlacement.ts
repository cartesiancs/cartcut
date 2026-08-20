/**
 * Where a popup menu goes so that it stays on screen.
 *
 * `html, body { overflow: hidden }` — see `sass/style.scss` — means anything a
 * menu pushes past the bottom of the window is not merely off-screen, it is
 * unreachable: there is no scrollbar to recover it, and in Electron there is no
 * browser chrome either. The timeline sits in the *lower* pane of a 97vh split,
 * so a right-click there almost always lands near the bottom edge. A menu that
 * simply opens downward from `clientY` is therefore cut off most of the time it
 * is used.
 *
 * The rule here is the one every OS context menu follows: open downward when
 * there is room, flip up and hang the menu's bottom edge off the cursor when
 * there is not, and only fall back to scrolling when neither side can hold it.
 *
 * Kept DOM-free so it runs in the `node` suite. `applyMenuPlacement` at the
 * bottom is the one function that touches an element, and it reads `window`
 * only when called — importing this module from a test is safe.
 */

/** How close a menu may come to the window edge, in px. */
export const MENU_MARGIN_PX = 8;

export type Anchor = { x: number; y: number };
export type Size = { w: number; h: number };

export type MenuPlacement = {
  left: number;
  top: number;
  /**
   * Room available on the side the menu opened to.
   *
   * The caller writes this straight into `max-height`. It is deliberately the
   * available space rather than the menu's own height: handing back an exact
   * fit invites a scrollbar to appear from nothing but sub-pixel rounding.
   */
  maxHeight: number;
  /** Whether the menu opened upward, with its bottom edge on the anchor. */
  flipped: boolean;
};

export type PlaceMenuOptions = {
  margin?: number;
  /**
   * Hang the menu's *right* edge on the anchor instead of its left.
   *
   * For a menu opened from a button at the right of its column — the track
   * header's `⋯`, which does this today with `transform: translateX(-100%)`.
   * Expressing it here instead means the horizontal clamp can see the real
   * left edge and keep it on screen.
   */
  alignRight?: boolean;
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  // `max < min` happens when the menu is wider or taller than the space it has
  // to live in. Pinning to `min` keeps the top-left corner on screen, which is
  // the half of the menu the user can still act on.
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/**
 * Place a menu of size `menu` at `anchor` inside `viewport`.
 *
 * Every field of the result is finite for any input, including a zero-sized
 * viewport and an anchor outside it — a menu that lands at `NaN` disappears
 * entirely, which is a worse failure than one that is merely in the wrong place.
 */
export function placeMenu(
  anchor: Anchor,
  menu: Size,
  viewport: Size,
  opts: PlaceMenuOptions = {},
): MenuPlacement {
  const margin = Math.max(0, finite(opts.margin, MENU_MARGIN_PX));

  const viewportW = Math.max(0, finite(viewport.w, 0));
  const viewportH = Math.max(0, finite(viewport.h, 0));
  const menuW = Math.max(0, finite(menu.w, 0));
  const menuH = Math.max(0, finite(menu.h, 0));

  // An anchor off the edge of the window — a drag that ended outside, a stale
  // coordinate — would otherwise put every space calculation into the negative.
  const anchorX = clamp(finite(anchor.x, 0), 0, viewportW);
  const anchorY = clamp(finite(anchor.y, 0), 0, viewportH);

  const spaceBelow = Math.max(0, viewportH - anchorY - margin);
  const spaceAbove = Math.max(0, anchorY - margin);

  let top: number;
  let maxHeight: number;
  let flipped: boolean;

  if (menuH <= spaceBelow) {
    // The common case, and the one that must not change: room below, open down.
    top = anchorY;
    maxHeight = spaceBelow;
    flipped = false;
  } else if (menuH <= spaceAbove) {
    // Not enough below but enough above: hang the bottom edge off the cursor.
    top = anchorY - menuH;
    maxHeight = spaceAbove;
    flipped = true;
  } else if (spaceBelow >= spaceAbove) {
    // Neither side fits. Take the roomier one and let `maxHeight` scroll it.
    top = anchorY;
    maxHeight = spaceBelow;
    flipped = false;
  } else {
    // Flipped and still too tall: start at the top margin so the whole of the
    // available strip is used, rather than `anchorY - menuH` which is negative.
    top = margin;
    maxHeight = spaceAbove;
    flipped = true;
  }

  const preferredLeft = opts.alignRight ? anchorX - menuW : anchorX;
  const left = clamp(preferredLeft, margin, viewportW - margin - menuW);

  return { left, top, maxHeight, flipped };
}

// ------------------------------------------------------------------- the DOM

/**
 * Measure `el`, place it, and write the result onto its style.
 *
 * `el` must already be in the document and un-clamped when this runs —
 * `offsetHeight` is what decides whether the menu flips, so a `max-height` left
 * over from a previous open would make a tall menu look short enough to fit.
 * It is cleared before measuring for exactly that reason.
 */
export function applyMenuPlacement(
  el: HTMLElement,
  anchor: Anchor,
  opts: PlaceMenuOptions = {},
): MenuPlacement {
  el.style.maxHeight = "";

  const placement = placeMenu(
    anchor,
    { w: el.offsetWidth, h: el.offsetHeight },
    { w: window.innerWidth, h: window.innerHeight },
    opts,
  );

  el.style.position = "fixed";
  el.style.top = `${placement.top}px`;
  el.style.left = `${placement.left}px`;
  el.style.maxHeight = `${placement.maxHeight}px`;
  el.style.overflowY = "auto";
  // Without this, scrolling past the end of a scrollable menu chains to
  // whatever is behind it — the timeline pane scrolls under the open menu.
  el.style.overscrollBehavior = "contain";

  return placement;
}
