/**
 * Sizing a canvas for a HiDPI display.
 *
 * Four numbers have to agree, not three. The backing store is device pixels
 * (the `width`/`height` *attributes*), the layout box is CSS pixels (the
 * `style.width`/`style.height` *properties*), and the context transform bridges
 * them.
 *
 * `elementTimelineCanvas` set three of the four: both attributes, `style.width`,
 * and the transform — but never `style.height`, and no stylesheet gives the
 * timeline canvas a height either (`_timeline.scss` only styles
 * `element-timeline-ruler > canvas`). So the used CSS height fell back to the
 * attribute, `height * dpr`. Horizontal mapping was correct because
 * `style.width` pinned it; vertical was off by exactly `devicePixelRatio`. On a
 * Retina display every row painted at double pitch, and `e.offsetY` — which
 * `hitTest` compares against `rowTop` — was twice the coordinate it was being
 * compared to.
 *
 * A 40px row absorbs some of that. An 8px keyframe lane does not, which is why
 * this is the first thing to land.
 */

export type SurfaceSpec = {
  /** `canvas.width` — the backing store, in device pixels. */
  attrWidth: number;
  /** `canvas.height` — the backing store, in device pixels. */
  attrHeight: number;
  /** `canvas.style.width` — the layout box, in CSS pixels. */
  styleWidth: string;
  /** `canvas.style.height` — the layout box, in CSS pixels. */
  styleHeight: string;
  /** Arguments for `ctx.setTransform`, so drawing code works in CSS pixels. */
  transform: [number, number, number, number, number, number];
};

/**
 * The four numbers for a canvas of `cssWidth` x `cssHeight` at `dpr`.
 *
 * A nonsense `dpr` — zero, negative, `NaN`, the `undefined` that
 * `window.devicePixelRatio` is in a headless context — falls back to 1 rather
 * than producing a zero-sized or `NaN`-sized backing store, which throws in
 * some engines and silently blanks the canvas in others.
 */
export function surfaceSpec(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): SurfaceSpec {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const w = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 0;
  const h = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 0;

  return {
    // A canvas may not be 0 wide or high; one pixel is the smallest legal
    // surface and costs nothing to allocate.
    attrWidth: Math.max(1, Math.round(w * scale)),
    attrHeight: Math.max(1, Math.round(h * scale)),
    styleWidth: `${w}px`,
    styleHeight: `${h}px`,
    transform: [scale, 0, 0, scale, 0, 0],
  };
}

/** The parts of a canvas this module writes to. */
export type SizableCanvas = {
  width: number;
  height: number;
  style: { width: string; height: string };
};

/** The part of a 2D context this module writes to. */
export type TransformableContext = {
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
};

/**
 * Apply a spec to a real canvas.
 *
 * Duck-typed rather than taking `HTMLCanvasElement`, so the suite can pass a
 * plain object under vitest's `node` environment and assert on all four
 * numbers at once.
 *
 * Attributes are assigned before the transform: writing `width` or `height`
 * resets the context, transform included, so setting the transform first would
 * silently lose it.
 */
export function applySurface(
  canvas: SizableCanvas,
  ctx: TransformableContext,
  spec: SurfaceSpec,
): void {
  canvas.width = spec.attrWidth;
  canvas.height = spec.attrHeight;
  canvas.style.width = spec.styleWidth;
  canvas.style.height = spec.styleHeight;
  ctx.setTransform(...spec.transform);
}
