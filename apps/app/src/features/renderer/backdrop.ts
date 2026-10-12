/**
 * The picture a clip is drawn *over*, for the one property that has to read it.
 *
 * Everything else in `renderer/` is a function of the element: a blend mode
 * says how the clip's pixels combine with what is beneath, but the combining is
 * the canvas's job and the renderer never looks. A frosted band is the
 * exception — CSS's `backdrop-filter`, and the same thing every design tool
 * calls background blur. It has to sample what is already on the frame.
 *
 * ## Why it is a parameter rather than `ctx.canvas`
 *
 * On the fast path a clip is drawn straight onto the frame, so the backdrop
 * *is* `ctx.canvas` and reading it there would work. On the isolated path —
 * which any clip with a blend mode, a mask, a LUT or a colour adjustment takes
 * — `renderElement` draws onto a transparent layer instead, and reading that
 * would sample nothing at all. A band that frosted in the preview and went
 * flat the moment someone masked the clip is precisely the kind of defect that
 * hides from a suite: every renderer test draws the element on its own.
 *
 * So the destination is captured in `renderElement`, before the layer exists,
 * and handed down as the fifth argument of `ElementRenderFunction`. Every other
 * renderer ignores it.
 *
 * ## The device-space invariant
 *
 * > **The layer and the frame share one pixel grid.**
 *
 * `renderElement` allocates the layer with `layerFor`, which sizes it to the
 * destination, copies the destination's transform onto it, and blits it back at
 * identity 1:1. So a device pixel on the layer is the same device pixel on the
 * frame, and the backdrop can be drawn at identity with no mapping. The sizes
 * are compared anyway, and a mismatch declines rather than drawing the backdrop
 * out of register — the one failure that would look like a rendering bug in
 * some unrelated element.
 *
 * ## Why the blur is applied at identity
 *
 * `ctx.filter = "blur(Npx)"` is scaled by the current transform in Skia and not
 * in Chromium, and the preview is Chromium while every renderer suite is Skia.
 * `renderer/mask.ts` states the trap at length and pays for it the same way
 * this does: reset to identity, convert the radius to device pixels explicitly,
 * and neither engine is asked to scale anything. The clip path is set *before*
 * the reset, so it is still built under the element's own transform — a clip
 * region is device-space once installed, and rounded corners map exactly,
 * elliptical under a non-uniform scale, which is what the band drawn over it
 * does too.
 *
 * ## Any preset, through a port
 *
 * A shape's backdrop runs an Fx preset rather than a blur: a mosaic over a
 * face, a smear across one band, a LUT inside a window. That needs WebGL, and
 * nothing in `renderer/` may hold a GL context or read the preset registry,
 * so the work arrives as a `BackdropFxPort`, built by the paint loop over the
 * compositor and carried on the backdrop next to the canvas it reads. A host
 * with no compositor passes none, and the shape then fills solid.
 *
 * The landing is the frost's exactly: trace the region under the element's
 * transform, clip, reset to identity and draw the finished picture 1:1. The
 * port's picture is the whole frame run through the preset, so a blur pulls
 * colour in from outside the region here too.
 */

import { matrixScale } from "./shadow";
import type { Surface } from "./surface";

/**
 * Run a shape's backdrop preset over `source` and hand the result to `land`.
 *
 * Synchronous, and `land` is called at most once with a picture the size of
 * `source` that exists only for the length of the call. Answers whether `land`
 * ran. `elementId` is how the port finds what `planFrame` sampled for this
 * shape at this frame; an id it has nothing for answers `false`.
 */
export type BackdropFxPort = (
  elementId: string,
  source: Surface["canvas"],
  land: (image: CanvasImageSource) => void,
) => boolean;

/** The frame beneath the clip being drawn, in the destination's pixel grid. */
export type Backdrop = {
  /**
   * What a frost reads. `null` inside a transition, where the clip is drawn
   * alone into a cleared buffer; the frost then declines, as it always has.
   */
  canvas: Surface["canvas"] | null;
  /**
   * What a backdrop preset reads, and the port that runs it. Present only
   * where a compositor is, and inside a transition too: the frame the
   * transition is about to be drawn over is still beneath the clip, and a
   * mosaic that switched off for the length of a dissolve would show the face
   * it exists to hide.
   */
  fx?: { port: BackdropFxPort; source: Surface["canvas"] } | null;
};

/**
 * The backdrop for a clip about to be drawn onto `ctx`.
 *
 * Read in `renderElement` before any layer is allocated, because after that
 * `ctx` may be the layer and the frame is no longer reachable.
 */
export function backdropOf(
  ctx: CanvasRenderingContext2D,
  port?: BackdropFxPort | null,
): Backdrop {
  const canvas = ctx.canvas as unknown as Surface["canvas"];
  return port == null
    ? { canvas }
    : { canvas, fx: { port, source: canvas } };
}

/**
 * The backdrop inside a transition: no frost, and the outer frame for a preset.
 *
 * `null` when there is no port or no outer frame, which is every caller but
 * the paint loop.
 */
export function isolatedBackdropOf(
  port: BackdropFxPort | null | undefined,
  outer: Surface["canvas"] | null | undefined,
): Backdrop | null {
  if (port == null || outer == null) {
    return null;
  }
  return { canvas: null, fx: { port, source: outer } };
}

/**
 * Blur the backdrop inside a region, leaving everything outside it untouched.
 *
 * `tracePath` appends the region to the current path, under the transform in
 * effect — element-local space, for every caller so far — and answers whether
 * it traced anything. The whole backdrop is then blitted through the blur,
 * clipped to that region: the blur therefore pulls colour in from *outside* the
 * region, which is what makes the edge of a frosted panel look like glass
 * rather than like a cropped thumbnail. Nothing is cropped, so nothing has a
 * seam.
 *
 * `globalAlpha` is deliberately left alone. It carries the clip's own opacity
 * and its group's, so a caption at 50% frosts its backdrop halfway — the
 * blurred copy lands over the sharp original at half strength — which is what
 * fading the clip ought to mean.
 *
 * Answers whether anything was drawn: `false` for no backdrop (a transition's
 * isolated buffer, a rasterisation, a host that passed none), for a blur of
 * zero, for a degenerate transform, and for a region that traced empty. A
 * backdrop blur with no backdrop draws no blur and reports nothing — the
 * contract a LUT that is not installed already has.
 */
export function frostBackdrop(
  ctx: CanvasRenderingContext2D,
  backdrop: Backdrop | null | undefined,
  blurElementPx: number,
  tracePath: (ctx: CanvasRenderingContext2D) => boolean,
): boolean {
  if (backdrop == null || backdrop.canvas == null || !(blurElementPx > 0)) {
    return false;
  }

  const source = backdrop.canvas;
  if (!sharesGrid(source, ctx)) {
    return false;
  }

  // The blur is a length in the element's own pixels, like the padding beside
  // it, so it goes through the matrix exactly as `renderer/shadow.ts` sends the
  // glow and the drop shadow: the softness then scales with zoom, with DPR and
  // with the clip's own scale, and 40 means the same thing in the preview and
  // in the delivered file.
  const scale = matrixScale(ctx.getTransform());
  if (!Number.isFinite(scale) || scale <= 0) {
    return false;
  }
  const deviceBlur = blurElementPx * scale;
  if (!(deviceBlur > 0)) {
    return false;
  }

  return throughRegion(ctx, tracePath, () => {
    ctx.filter = `blur(${deviceBlur}px)`;
    ctx.drawImage(source, 0, 0);
    return true;
  });
}

/**
 * Run a shape's backdrop preset and draw the result inside a region.
 *
 * `tracePath` is `frostBackdrop`'s, and so is everything after it. Answers
 * whether anything was drawn: `false` for no port (a host with no compositor,
 * a template's inner timeline), for a frame the port had nothing planned for
 * (a preset that is not installed, or not one a backdrop can carry), for a
 * source out of register with the destination, and for a region that traced
 * empty. The caller decides what a `false` means; for a shape it means "fill
 * solid", so a mosaic that cannot run hides the face rather than showing it.
 */
export function landBackdropFx(
  ctx: CanvasRenderingContext2D,
  backdrop: Backdrop | null | undefined,
  elementId: string,
  tracePath: (ctx: CanvasRenderingContext2D) => boolean,
): boolean {
  const fx = backdrop?.fx;
  if (fx == null || !sharesGrid(fx.source, ctx)) {
    return false;
  }
  return throughRegion(ctx, tracePath, () =>
    fx.port(elementId, fx.source, (image) => ctx.drawImage(image, 0, 0)),
  );
}

/**
 * Whether a backdrop can be drawn onto `ctx` at identity with no mapping.
 *
 * The invariant this module's header states. A mismatch declines rather than
 * drawing out of register: on the preview's device canvas, for one, the port
 * would be handed a frame that is not the project's.
 */
function sharesGrid(
  source: Surface["canvas"],
  ctx: CanvasRenderingContext2D,
): boolean {
  const destination = ctx.canvas;
  return (
    source.width === destination.width && source.height === destination.height
  );
}

/**
 * Clip to a traced region, reset to identity and draw.
 *
 * The region is traced under the transform in effect, which is element-local
 * space for every caller, and becomes device-space the moment it is installed.
 */
function throughRegion(
  ctx: CanvasRenderingContext2D,
  tracePath: (ctx: CanvasRenderingContext2D) => boolean,
  draw: () => boolean,
): boolean {
  ctx.save();
  try {
    ctx.beginPath();
    if (!tracePath(ctx)) {
      return false;
    }
    ctx.clip();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // `source-over` explicitly: on the isolated path the caller's context may
    // carry a mode, and the backdrop is the bottom of the clip's own stack.
    ctx.globalCompositeOperation = "source-over";
    return draw();
  } finally {
    // `filter` is context state like any other, and a leaked `blur()` would
    // apply to every later draw on this surface. `mask.ts` clears it the same
    // way and for the same reason.
    ctx.filter = "none";
    ctx.restore();
  }
}
