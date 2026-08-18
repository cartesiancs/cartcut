/**
 * Preview viewport geometry.
 *
 * Three coordinate spaces are in play:
 *
 *   world   project px. Where timeline elements live. (0,0)-(frameW,frameH) is
 *           the rendered frame; coordinates outside that range are legal and are
 *           what makes the preview an infinite canvas.
 *   view    CSS px, origin at the canvas' top-left corner.
 *   device  view * devicePixelRatio, i.e. the canvas backing store.
 *
 * The forward map is `view = world * scale + offset`. The viewport is stored as
 * `{ zoom, center }` rather than as a raw offset: `center` is the world point
 * pinned to the middle of the viewport, so a column resize or a resolution
 * change keeps the same content centred and only re-derives `scale`.
 *
 * `zoom` is a percentage *of the fit scale*, so `zoom === 100` always means "the
 * whole frame is visible, uncropped", whatever the resolution or panel size.
 */

export type Viewport = {
  /** Percent of the fit scale. 100 = whole frame visible. */
  zoom: number;
  /** World point pinned to the centre of the viewport. */
  center: { x: number; y: number };
};

export type ViewportGeometry = {
  /** view px per world px. */
  scale: number;
  /** view px. */
  offsetX: number;
  offsetY: number;
};

/** Breathing room left around the frame at zoom 100, in CSS px. */
export const FIT_PADDING_PX = 24;

export const ZOOM_MIN = 5;
export const ZOOM_MAX = 1600;

/** Multiplier for one zoom-in step (buttons, keyboard). */
export const ZOOM_STEP = 1.2;

export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * The scale at which the frame exactly fits the viewport, padding included.
 *
 * Guards every degenerate input the callers can actually produce: a zero-sized
 * canvas before first layout, and a resolution field the user has emptied.
 */
export function fitScale(
  viewW: number,
  viewH: number,
  frameW: number,
  frameH: number,
): number {
  const w = Number(frameW);
  const h = Number(frameH);
  if (!(w > 0) || !(h > 0)) return 1;

  const availableW = viewW - FIT_PADDING_PX * 2;
  const availableH = viewH - FIT_PADDING_PX * 2;
  if (!(availableW > 0) || !(availableH > 0)) return 1;

  return Math.min(availableW / w, availableH / h);
}

export function computeGeometry(
  viewport: Viewport,
  viewW: number,
  viewH: number,
  frameW: number,
  frameH: number,
): ViewportGeometry {
  const scale = fitScale(viewW, viewH, frameW, frameH) * (viewport.zoom / 100);

  return {
    scale,
    offsetX: viewW / 2 - viewport.center.x * scale,
    offsetY: viewH / 2 - viewport.center.y * scale,
  };
}

export function screenToWorld(
  geometry: ViewportGeometry,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: (sx - geometry.offsetX) / geometry.scale,
    y: (sy - geometry.offsetY) / geometry.scale,
  };
}

export function worldToScreen(
  geometry: ViewportGeometry,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: wx * geometry.scale + geometry.offsetX,
    y: wy * geometry.scale + geometry.offsetY,
  };
}

/**
 * Re-zoom while keeping the world point currently under `(sx, sy)` parked at
 * that same view position — the "zoom toward the cursor" that pinch and
 * ctrl+wheel need.
 */
export function zoomAround(
  viewport: Viewport,
  nextZoom: number,
  sx: number,
  sy: number,
  viewW: number,
  viewH: number,
  frameW: number,
  frameH: number,
): Viewport {
  const zoom = clampZoom(nextZoom);

  const before = computeGeometry(viewport, viewW, viewH, frameW, frameH);
  const anchor = screenToWorld(before, sx, sy);

  const zoomed: Viewport = { zoom, center: viewport.center };
  const after = computeGeometry(zoomed, viewW, viewH, frameW, frameH);
  const drifted = screenToWorld(after, sx, sy);

  return {
    zoom,
    center: {
      x: viewport.center.x + (anchor.x - drifted.x),
      y: viewport.center.y + (anchor.y - drifted.y),
    },
  };
}

/** The frame, centred and fully visible. */
export function fitViewport(frameW: number, frameH: number): Viewport {
  const w = Number(frameW);
  const h = Number(frameH);

  return {
    zoom: 100,
    center: {
      x: (w > 0 ? w : 0) / 2,
      y: (h > 0 ? h : 0) / 2,
    },
  };
}
