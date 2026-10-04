/**
 * Drawing a graphic: a layer whose picture is a program.
 *
 * By the time this runs `renderElement` has applied everything it applies to an
 * image: the parent chain, the transform, the sampled box, opacity, and around
 * this draw the blend, grade, adjustments and mask. So this only has to put the
 * program's picture into `(0, 0, width, height)`, and a graphic inherits every
 * one of those for free.
 *
 * Two kinds of program, two sources of pixels, one rule: **this function is
 * synchronous and never waits.**
 *
 *  - A GLSL generator is drawn here and now by a `GraphicGl`, the preview's or
 *    the active scope's.
 *  - An HTML program is rasterised ahead of the frame by the prepare step
 *    (`graphic/prepare.ts`), because Chromium only paints a DOM change on its
 *    next `paint` event. This draws whichever raster is ready: the scope's for
 *    this exact frame inside an export, the latest one in the preview. None
 *    ready draws nothing, the contract a video with no decoded frame has.
 *
 * The runtime is injected, as the template resolver is, so this module never
 * reaches the store, the registry or the DOM, and a test can drive it.
 */

import type { GraphicElementType } from "../../@types/timeline";
import type { FxPreset } from "../fx/presetTypes";
import { activeGraphicScope } from "../graphic/graphicScope";
import { graphicTimeOf } from "../graphic/graphicTime";
import { bleedInBox } from "../graphic/htmlContract";
import { frameStartMs } from "../timeline/frames";
import { sampleFxParams } from "./fx/effectSample";
import { rasterSizeFor, type GraphicGl } from "./graphicGl";

export type GraphicRuntime = {
  /** The preset a graphic draws with, inline programs included. */
  presetOf: (element: GraphicElementType) => FxPreset | null;
  /** The preview's generator, or `null` where there is no GL. */
  previewGl: () => GraphicGl | null;
  /** The project frame rate, for the preview. An export's comes from its scope. */
  fps: () => number;
  /** The latest HTML raster for a clip in the preview, or `null`. */
  latestHtmlRaster: (elementId: string) => CanvasImageSource | null;
  /**
   * Told the device scale a clip was last drawn at, so the next preview
   * rasterisation is sharp at the current zoom.
   */
  noteDrawScale: (elementId: string, scale: number) => void;
};

const inert: GraphicRuntime = {
  presetOf: () => null,
  previewGl: () => null,
  fps: () => 30,
  latestHtmlRaster: () => null,
  noteDrawScale: () => {},
};

let runtime: GraphicRuntime = inert;

/** Point the renderer at a registry and a generator. Called once at startup. */
export function installGraphicRuntime(next: GraphicRuntime | null): void {
  runtime = next ?? inert;
}

/** The scale from box pixels to device pixels the context draws at now. */
export function deviceScaleOf(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const scale = Math.max(sx, sy);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function renderGraphic(
  ctx: CanvasRenderingContext2D,
  elementId: string,
  element: GraphicElementType,
  timelineCursor: number,
): void {
  const width = element.width;
  const height = element.height;
  if (!(width > 0) || !(height > 0)) {
    return;
  }
  const preset = runtime.presetOf(element);
  if (preset == null) {
    return;
  }
  const scope = activeGraphicScope();

  if (preset.render.type === "shader") {
    const gl = scope != null ? scope.gl : runtime.previewGl();
    if (gl == null) {
      return;
    }
    const fps = scope != null ? scope.fps : runtime.fps();
    const time = graphicTimeOf(element, timelineCursor, fps);
    const params = sampleFxParams(element, frameStartMs(timelineCursor, fps));
    const size = rasterSizeFor(width, height, deviceScaleOf(ctx));
    const raster = gl.draw(
      preset,
      params,
      {
        seconds: time.tMs / 1000,
        progress: time.progress,
        durationSeconds: time.durMs / 1000,
      },
      size.width,
      size.height,
    );
    if (raster == null) {
      return;
    }
    ctx.drawImage(
      raster.canvas,
      raster.sx,
      raster.sy,
      raster.sw,
      raster.sh,
      0,
      0,
      width,
      height,
    );
    return;
  }

  if ((preset.render as { type: string }).type === "html") {
    if (scope == null) {
      runtime.noteDrawScale(elementId, deviceScaleOf(ctx));
    }
    const raster =
      scope != null ? (scope.rasters.get(elementId) ?? null) : runtime.latestHtmlRaster(elementId);
    if (raster == null) {
      return;
    }
    // The raster covers the box plus the bleed on every side, so it is drawn
    // that much larger and offset by it: the box stays where the selection
    // outline and the hit test say it is, and a glow is not cut off at its edge.
    const bleed = bleedInBox(preset, { width, height });
    ctx.drawImage(raster, -bleed, -bleed, width + 2 * bleed, height + 2 * bleed);
  }
}
