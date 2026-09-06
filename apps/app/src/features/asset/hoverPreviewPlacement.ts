/**
 * How big the hover preview is, and where it sits relative to the cursor.
 *
 * Same arrangement as `menu/menuPlacement.ts`, for the same reason: the
 * arithmetic is DOM-free so it runs in the `node` suite, and the one function
 * that touches an element is at the bottom, under the banner, reading `window`
 * only when it is called. Importing this module from a test is safe.
 *
 * It is **not** `placeMenu`, though it is close enough to be worth saying why.
 * A menu hangs its top-left corner *on* the anchor and scrolls when it does not
 * fit, which is what `maxHeight` is for. A preview must do neither: it has to
 * stand off the cursor by a gap — a picture under the pointer is a picture the
 * pointer is hiding — it flips on *both* axes rather than just the vertical,
 * and it never scrolls, because a clipped preview is worse than a smaller one.
 * Teaching `placeMenu` all three would change the context menu, which is well
 * pinned and has no reason to move.
 *
 * The guards are borrowed wholesale, and deliberately: a preview placed at
 * `NaN` does not appear at all, which is a worse failure than one merely in the
 * wrong place.
 */

/** How close the preview may come to the window edge, in px. */
export const PREVIEW_MARGIN_PX = 8;

/**
 * Clear space between the cursor and the preview, in px.
 *
 * The one number that separates this from a tooltip: it is what keeps the
 * pointer off the picture it just asked to see.
 */
export const PREVIEW_GAP_PX = 16;

/** The largest the preview may grow, as a fraction of the window. */
export const PREVIEW_MAX_W_FRACTION = 0.42;
export const PREVIEW_MAX_H_FRACTION = 0.55;

/** What a box with no known size is assumed to be, until it reports one. */
export const PREVIEW_FALLBACK_ASPECT = 16 / 9;

export type Size = { w: number; h: number };
export type Anchor = { x: number; y: number };

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  // `max < min` means the preview is larger than the space it has to live in.
  // Pinning to `min` keeps the top-left corner on screen, which is the half
  // there is any chance of reading.
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/**
 * Fit a source's natural size into the window, keeping its aspect ratio.
 *
 * **Never upscales.** A 64px icon blown up to 600px is a blurry 64px icon, and
 * the point of the preview is to show what the file actually looks like. Large
 * media — which is what the asset panel is mostly full of — is unaffected,
 * since it only ever shrinks.
 *
 * Not `mediaElement.ts#fitToPreview`: that one fits into the *project frame*
 * and reads `renderOptionStore` for it. What is being fitted into here is the
 * window, which has nothing to do with the project's resolution.
 */
export function previewBoxSize(natural: Size, viewport: Size): Size {
  const viewportW = Math.max(0, finite(viewport.w, 0));
  const viewportH = Math.max(0, finite(viewport.h, 0));

  const maxW = Math.max(0, viewportW * PREVIEW_MAX_W_FRACTION);
  const maxH = Math.max(0, viewportH * PREVIEW_MAX_H_FRACTION);

  let w = Math.max(0, finite(natural.w, 0));
  let h = Math.max(0, finite(natural.h, 0));

  if (w <= 0 || h <= 0) {
    // Nothing has reported a size yet — `loadedmetadata` has not fired, or the
    // file is unreadable. A box of the usual shape is better than a collapsed
    // one, which reads as a broken feature rather than a loading one.
    w = PREVIEW_FALLBACK_ASPECT;
    h = 1;
  }

  const scale = Math.min(maxW / w, maxH / h, 1);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { w: 0, h: 0 };
  }

  return { w: w * scale, h: h * scale };
}

export type PreviewSide = {
  /** The preview hangs to the left of the cursor rather than the right. */
  flippedX: boolean;
  /** The preview hangs above the cursor rather than below. */
  flippedY: boolean;
};

export type PreviewPlacement = PreviewSide & {
  left: number;
  top: number;
};

export type PlacePreviewOptions = {
  gap?: number;
  margin?: number;
  /**
   * The side the preview is already on.
   *
   * Kept unless it genuinely stops fitting, which is what stops the preview
   * strobing. Without it, resting the cursor exactly where the box stops
   * fitting below turns a 1px tremor into an above/below flip at pointer rate —
   * and a tile is only ~70px tall, so a cursor sitting on that boundary stays
   * on it. The caller feeds back what the previous call returned.
   */
  prefer?: PreviewSide;
};

/** Where the box lands on one axis if placed on `flipped`'s side, after clamping. */
function positionOn(
  flipped: boolean,
  cursor: number,
  size: number,
  extent: number,
  gap: number,
  margin: number,
): number {
  const preferred = flipped ? cursor - gap - size : cursor + gap;
  return clamp(preferred, margin, extent - margin - size);
}

/**
 * Would that position still leave the cursor outside the box on this axis?
 *
 * Asked of the **clamped** position, not the ideal one, and that is the whole
 * of the hysteresis. The ideal position stops fitting some tens of pixels
 * before the clamped one starts covering the cursor, and between those two
 * points the box can stay where it is and merely close the gap. Comparing
 * against the ideal instead makes the preference worthless: it gives way at
 * exactly the boundary it was meant to smooth over.
 */
function keepsCursorClear(
  flipped: boolean,
  cursor: number,
  size: number,
  extent: number,
  gap: number,
  margin: number,
): boolean {
  const pos = positionOn(flipped, cursor, size, extent, gap, margin);
  return flipped ? pos + size <= cursor : pos >= cursor;
}

/**
 * Which side to use: the one already in use while it still works, else the one
 * that does.
 *
 * With no preference the default is the un-flipped side, so a preview opens
 * below and to the right — the direction a cursor's own hotspot points, so the
 * box grows away from what is being looked at.
 */
function sideFor(
  preferred: boolean | undefined,
  cursor: number,
  size: number,
  extent: number,
  gap: number,
  margin: number,
): boolean {
  const clear = (flipped: boolean) =>
    keepsCursorClear(flipped, cursor, size, extent, gap, margin);

  if (preferred !== undefined && clear(preferred)) {
    return preferred;
  }
  if (clear(false)) {
    return false;
  }
  // Neither side can keep clear only when the box is too big for the window;
  // the flipped side is the better half to show in that case, since it hangs
  // off the cursor rather than starting under it.
  return clear(true) ? true : false;
}

/**
 * Place a preview of size `preview` near `cursor` inside `viewport`.
 *
 * Below and to the right by default — the direction a cursor's own hotspot
 * points, so the preview grows away from what the user is looking at. Each axis
 * flips independently when that side has no room, and only then is the result
 * clamped, so the clamp catches the case where neither side fits rather than
 * being the first thing to act.
 *
 * Every field is finite for any input, including a zero-sized viewport and a
 * cursor outside it.
 */
export function placePreview(
  cursor: Anchor,
  preview: Size,
  viewport: Size,
  opts: PlacePreviewOptions = {},
): PreviewPlacement {
  const gap = Math.max(0, finite(opts.gap, PREVIEW_GAP_PX));
  const margin = Math.max(0, finite(opts.margin, PREVIEW_MARGIN_PX));

  const viewportW = Math.max(0, finite(viewport.w, 0));
  const viewportH = Math.max(0, finite(viewport.h, 0));
  const previewW = Math.max(0, finite(preview.w, 0));
  const previewH = Math.max(0, finite(preview.h, 0));

  // A cursor off the edge of the window — a stale coordinate, a pointer that
  // left during a drag — would otherwise put every calculation below into the
  // negative.
  const cursorX = clamp(finite(cursor.x, 0), 0, viewportW);
  const cursorY = clamp(finite(cursor.y, 0), 0, viewportH);

  const flippedX = sideFor(
    opts.prefer?.flippedX,
    cursorX,
    previewW,
    viewportW,
    gap,
    margin,
  );
  const flippedY = sideFor(
    opts.prefer?.flippedY,
    cursorY,
    previewH,
    viewportH,
    gap,
    margin,
  );

  const preferredLeft = flippedX ? cursorX - gap - previewW : cursorX + gap;
  const preferredTop = flippedY ? cursorY - gap - previewH : cursorY + gap;

  return {
    left: clamp(preferredLeft, margin, viewportW - margin - previewW),
    top: clamp(preferredTop, margin, viewportH - margin - previewH),
    flippedX,
    flippedY,
  };
}

// ------------------------------------------------------------------- the DOM

/**
 * Place `el` at `cursor` and write the result onto its style.
 *
 * `transform` rather than the `left`/`top` `applyMenuPlacement` writes, and the
 * difference is the point: a menu is placed once, on open, where this runs on
 * every `pointermove` for as long as the preview is up — with a `<video>`
 * decoding inside it. `left`/`top` dirty layout each time; a transform stays on
 * the compositor. `.asset-hover-preview` pins the element at the origin so the
 * translation is the whole position.
 *
 * The size is written here too, because `placePreview` decides which side of
 * the cursor to use by asking whether the box fits — so the box being measured
 * has to be the one about to be painted.
 */
export function applyPreviewPlacement(
  el: HTMLElement,
  cursor: Anchor,
  preview: Size,
  opts: PlacePreviewOptions = {},
): PreviewPlacement {
  const placement = placePreview(
    cursor,
    preview,
    { w: window.innerWidth, h: window.innerHeight },
    opts,
  );

  el.style.width = `${preview.w}px`;
  el.style.height = `${preview.h}px`;
  el.style.transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;

  return placement;
}
