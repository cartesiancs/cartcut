/**
 * I/O boundary types for the draw layer.
 *
 * The engine never touches `document`, stores, or `electronAPI`. It receives a
 * canvas 2D context, a timeline snapshot, a time in ms, and an `AssetResolver`
 * that supplies the actual pixel sources (images / video frames / gif frames).
 * Preview wraps its live-DOM element map; export wraps its own loaders. Same
 * engine, different injected resolver.
 */

import type { RenderElement } from "../model/timeline.types";

/** Works for both on-screen `<canvas>` and `OffscreenCanvas`. In Node tests a
 * headless canvas 2D context is passed in. Typed loosely to avoid coupling the
 * engine to one canvas implementation. */
export type CanvasCtx = CanvasRenderingContext2D;

/** Anything `ctx.drawImage` accepts. */
export type ImageSource = CanvasImageSource;

/** A per-video mutable cache bag (WebGL canvas/program handles) that the glFilter
 * code hangs onto between frames. Opaque to the engine core. */
export type VideoHandle = {
  object: ImageSource;
  [key: string]: unknown;
};

/**
 * Supplies pixel sources for elements. Async video seeking lives entirely here:
 * export awaits its own seek before calling `renderFrame`, preview is
 * best-effort. `renderFrame` itself stays synchronous.
 */
export interface AssetResolver {
  getImage(id: string, el: RenderElement): ImageSource | null;
  getGifFrame(id: string, el: RenderElement, timeMs: number): ImageSource | null;
  /** Returns the video wrapper whose `.object` is presenting the frame for the
   * current time (the caller is responsible for having seeked it). */
  getVideo(id: string, el: RenderElement): VideoHandle | null;
}

export interface RenderDeps {
  assets: AssetResolver;
  /** True on the frame after a filter changed, forcing shader re-init. Preview
   * sets this; export leaves it false. */
  isChangeFilter?: boolean;
  /**
   * Ids whose `position` keyframe track must not be applied this frame. The
   * preview sets this for the element being dragged so it follows the cursor
   * instead of snapping back to its keyframed position. Export never sets it.
   */
  ignorePositionIds?: ReadonlySet<string>;
}

export interface RenderFrameOptions {
  /**
   * Ids to leave out of the frame entirely. The preview uses this for the text
   * element under inline editing, which is drawn by a DOM overlay instead.
   */
  skipIds?: ReadonlySet<string>;
}

export type RenderFrameResult = {
  /** ids composited this frame, in z-order. */
  drawn: string[];
};
