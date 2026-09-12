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
 */

import { matrixScale } from "./shadow";
import type { Surface } from "./surface";

/** The frame beneath the clip being drawn, in the destination's pixel grid. */
export type Backdrop = {
  canvas: Surface["canvas"];
};

/**
 * The backdrop for a clip about to be drawn onto `ctx`.
 *
 * Read in `renderElement` before any layer is allocated, because after that
 * `ctx` may be the layer and the frame is no longer reachable.
 */
export function backdropOf(ctx: CanvasRenderingContext2D): Backdrop {
  return { canvas: ctx.canvas as unknown as Surface["canvas"] };
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
  if (backdrop == null || !(blurElementPx > 0)) {
    return false;
  }

  const source = backdrop.canvas;
  const destination = ctx.canvas;
  if (
    source.width !== destination.width ||
    source.height !== destination.height
  ) {
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

  ctx.save();
  try {
    ctx.beginPath();
    if (!tracePath(ctx)) {
      return false;
    }
    ctx.clip();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // `source-over` explicitly: on the isolated path the caller's context may
    // carry a mode, and the frost is the bottom of the clip's own stack.
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = `blur(${deviceBlur}px)`;
    ctx.drawImage(source, 0, 0);
    return true;
  } finally {
    // `filter` is context state like any other, and a leaked `blur()` would
    // apply to every later draw on this surface. `mask.ts` clears it the same
    // way and for the same reason.
    ctx.filter = "none";
    ctx.restore();
  }
}
