/**
 * The Auto Track stage's view: where the frame sits, and what a pointer means.
 *
 * World space here is the frame source's *working* pixels, the picture the
 * tracker answers in, so a point read off the stage goes to `startTracker`
 * without another conversion. The arithmetic is the preview's own
 * (`preview/viewport.ts`), with two rules on top that the preview does not want.
 *
 * **Fit is the floor.** The preview is an infinite canvas and may zoom out past
 * its frame; this stage has nothing outside the frame to show, and there is no
 * Fit button here, so zooming out has to arrive back at the whole picture on its
 * own.
 *
 * **The frame cannot be panned away.** Each axis either centres the frame, when
 * it fits, or keeps the frame's edge at least `FIT_PADDING_PX` inside the view.
 * Without it one long swipe leaves an empty stage and no control to come back.
 */

import {
  FIT_PADDING_PX,
  ZOOM_MAX,
  computeGeometry,
  fitViewport,
  screenToWorld,
  zoomAround,
  type Viewport,
  type ViewportGeometry,
} from "../preview/viewport";

export type StageSize = {
  /** CSS px. */
  viewW: number;
  viewH: number;
  /** Working-frame px. */
  frameW: number;
  frameH: number;
};

export const STAGE_ZOOM_MIN = 100;

export type StageIntent = "place" | "pan" | "none";

export function stageFit(size: StageSize): Viewport {
  return fitViewport(size.frameW, size.frameH);
}

export function stageGeometry(
  viewport: Viewport,
  size: StageSize,
): ViewportGeometry {
  return computeGeometry(
    viewport,
    size.viewW,
    size.viewH,
    size.frameW,
    size.frameH,
  );
}

/** The view point `(sx, sy)` as a working-frame pixel. */
export function stagePoint(
  viewport: Viewport,
  size: StageSize,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return screenToWorld(stageGeometry(viewport, size), sx, sy);
}

/** Clamp zoom to `[fit, ZOOM_MAX]` and keep the frame on the stage. */
export function containViewport(viewport: Viewport, size: StageSize): Viewport {
  const zoom = Number.isFinite(viewport.zoom)
    ? Math.min(ZOOM_MAX, Math.max(STAGE_ZOOM_MIN, viewport.zoom))
    : STAGE_ZOOM_MIN;
  const { scale } = stageGeometry({ zoom, center: viewport.center }, size);

  const axis = (center: number, frame: number, view: number): number => {
    const half = (view / 2 - FIT_PADDING_PX) / scale;
    // With a tolerance: at fit the tight axis is equal by construction, and
    // floating point lands it a hair either side, which is a centre off by
    // 1e-13 on one stage and exact on the next.
    if (!(half > 0) || !Number.isFinite(center) || frame - half * 2 <= 1e-6) {
      return frame / 2;
    }
    return Math.min(frame - half, Math.max(half, center));
  };

  return {
    zoom,
    center: {
      x: axis(viewport.center.x, size.frameW, size.viewW),
      y: axis(viewport.center.y, size.frameH, size.viewH),
    },
  };
}

/** Move the picture by `(dx, dy)` view px, the way a drag moves it. */
export function panViewport(
  viewport: Viewport,
  dx: number,
  dy: number,
  size: StageSize,
): Viewport {
  const { scale } = stageGeometry(viewport, size);
  return containViewport(
    {
      zoom: viewport.zoom,
      center: {
        x: viewport.center.x - dx / scale,
        y: viewport.center.y - dy / scale,
      },
    },
    size,
  );
}

/**
 * One wheel event.
 *
 * The preview's mapping (`previewCanvas.ts#_handleWheel`): a macOS pinch
 * arrives as a wheel with `ctrlKey` and zooms toward the pointer, a two-finger
 * swipe arrives as a plain wheel and pans. `ctrlKey` and not the editor
 * modifier, which is Cmd on macOS and would break pinch.
 */
export function wheelViewport(
  viewport: Viewport,
  wheel: { deltaX: number; deltaY: number; ctrlKey: boolean },
  at: { x: number; y: number },
  size: StageSize,
): Viewport {
  if (!wheel.ctrlKey) {
    return panViewport(viewport, -wheel.deltaX, -wheel.deltaY, size);
  }
  // Floored before `zoomAround`, not after it: its anchor maths would park the
  // pointer's point for a zoom the clamp then refuses, and the picture would
  // slide on every notch of a zoom-out that is already at fit.
  const next = Math.max(
    STAGE_ZOOM_MIN,
    viewport.zoom * Math.exp(-wheel.deltaY * 0.01),
  );
  return containViewport(
    zoomAround(
      viewport,
      next,
      at.x,
      at.y,
      size.viewW,
      size.viewH,
      size.frameW,
      size.frameH,
    ),
    size,
  );
}

/**
 * What a press starts.
 *
 * Middle-drag and alt-drag always pan, as on the preview; Space is not
 * available, it is play/pause everywhere. A plain press places the feature box
 * when it lands on the picture and the panel can take one, and pans otherwise,
 * so a drag from the empty margin, or any drag while tracking, moves the view
 * rather than doing nothing.
 */
export function pointerIntent(
  pointer: { button: number; altKey: boolean },
  world: { x: number; y: number },
  size: StageSize,
  canPlace: boolean,
): StageIntent {
  if (pointer.button === 1 || pointer.altKey) {
    return "pan";
  }
  if (pointer.button !== 0) {
    return "none";
  }
  const inside =
    world.x >= 0 &&
    world.y >= 0 &&
    world.x < size.frameW &&
    world.y < size.frameH;
  return inside && canPlace ? "place" : "pan";
}
