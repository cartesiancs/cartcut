/**
 * Casting a shadow that survives the transform, and that paints *only* a
 * shadow.
 *
 * Two facts about the canvas shadow API drive everything here.
 *
 * **1. Shadows are measured in device space.** `shadowOffsetX/Y` and
 * `shadowBlur` are not multiplied by the current transform — that is what the
 * spec says, and it is what the Skia build under the tests does. Measured: with
 * `scale(2)`, a rect at user x 5..15 lands at device 10..30, and a
 * `shadowOffsetX` of 10 puts its shadow at device x 30 — displaced by 10 device
 * pixels, not 20.
 *
 * This is not academic. The preview draws through
 * `previewCanvas.ts`'s `octx.setTransform(g.scale * dpr, …)` — zoom times
 * device pixel ratio — while the export draws at the project's resolution 1:1.
 * A raw `shadowBlur = 10` would therefore be twice as large relative to the
 * glyphs at 50% zoom as it is in the file the user ships. So the offsets and
 * the blur are pushed through the matrix here, which also makes a shadow rotate
 * and scale along with its clip.
 *
 * **2. Setting a shadow paints the source too.** `renderText` needs several
 * passes over the same glyphs — a glow, then a drop shadow, then the outline
 * and the fill — and if each pass also painted the glyph body, a semi-opaque
 * `textOpacity` would accumulate to something darker than asked for, and two
 * enabled effects would print the body three times.
 *
 * `paintShadowOnly` solves that with the standard trick: translate the draw far
 * enough that the source leaves the canvas entirely, and add the same distance
 * back into the shadow offset so the shadow lands where it belongs. The body is
 * clipped away; only its shadow survives. The final glyph is then drawn exactly
 * once, by the caller.
 */

/** Element-space shadow parameters, as `features/text/style.ts` resolves them. */
export type ShadowSpec = {
  offsetX: number;
  offsetY: number;
  blur: number;
  /** Canvas-ready colour — run it through `withAlpha` before calling. */
  color: string;
};

/**
 * The uniform scale factor of a matrix, from the area it multiplies by.
 *
 * `sqrt(|det|)` rather than `hypot(a, b)` so that a non-uniform scale gives one
 * sensible number instead of favouring the x axis. Zero for a degenerate matrix
 * (a clip scaled to nothing), which callers treat as "draw nothing".
 */
export function matrixScale(m: DOMMatrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/**
 * Paint the shadow of `draw`, and nothing else.
 *
 * The caller is expected to have already set up `ctx.font`, `letterSpacing` and
 * any stroke width, and to draw the same shape it will later draw for real.
 */
export function paintShadowOnly(
  ctx: CanvasRenderingContext2D,
  draw: () => void,
  spec: ShadowSpec,
): void {
  const m = ctx.getTransform();
  const scale = matrixScale(m);

  // A clip scaled to nothing has no shadow, and the `push` below would divide
  // by zero working out how far to move a glyph that occupies no area.
  if (!Number.isFinite(scale) || scale <= 0) {
    return;
  }

  const blurDevice = Math.max(0, spec.blur) * scale;
  // Only the linear part of the matrix: the offset is a direction and a
  // distance, not a point, so the translation must not apply to it.
  const dx = m.a * spec.offsetX + m.c * spec.offsetY;
  const dy = m.b * spec.offsetX + m.d * spec.offsetY;

  // Far enough that the source cannot overlap the canvas from any angle, in
  // user units so it can be handed to `translate`. Width plus height covers the
  // diagonal; the blur is added because a blurred edge reaches further than the
  // shape does.
  const push =
    (ctx.canvas.width + ctx.canvas.height + blurDevice + 100) / scale;

  ctx.save();
  ctx.shadowColor = spec.color;
  ctx.shadowBlur = blurDevice;
  // Translating by `-push` in user x displaces the source by `(a, b) * -push`
  // in device space, so adding that back lands the shadow on target. No matrix
  // inversion needed, and it stays correct under rotation.
  ctx.shadowOffsetX = dx + m.a * push;
  ctx.shadowOffsetY = dy + m.b * push;
  ctx.translate(-push, 0);
  draw();
  ctx.restore();
}
