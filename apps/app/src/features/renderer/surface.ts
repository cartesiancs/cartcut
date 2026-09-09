/**
 * Scratch canvases for isolated compositing.
 *
 * A blended clip cannot be drawn straight onto the frame. Every renderer but
 * `image` issues more than one drawing call — `renderText` alone paints a
 * background box, a glow, a drop shadow, an outline stroke and a fill for each
 * line — and with a blend mode set on the shared context those pieces blend
 * against *each other* as well as against the scene. The outline goes black
 * under `multiply`, the shadow doubles under `screen`. So the clip is drawn
 * whole onto a layer of its own and composited once. That is what "isolation"
 * means in Photoshop and After Effects, and it is what users expect a blend
 * mode to do.
 *
 * ## Why the canvas comes from a factory
 *
 * The renderer suites run under `environment: "node"`, where neither `document`
 * nor `OffscreenCanvas` exists — they get a real Skia context from
 * `@napi-rs/canvas` instead. Sniffing for a global and quietly taking a
 * different path in tests would mean the isolation code was never the code that
 * ships. So the surface is a parameter, the same rule `assetPaths.ts` states
 * for path flavour: `renderer/testing.ts` installs the Skia factory and the
 * suites exercise the real path.
 *
 * The default factory answers `null` where there is no `document`, and
 * `renderElement` degrades to setting `globalCompositeOperation` directly —
 * still exactly right for the single-`drawImage` element types, and never a
 * blank frame.
 *
 * ## Why one layer per destination, not one per frame
 *
 * Keyed by the destination canvas in a `WeakMap`. The preview's offscreen, the
 * export's frame canvas, the FX scratch canvas and a transition's two clip
 * buffers are all different destinations that can be live at the same time, and
 * a single shared layer would let one overwrite another mid-frame. Keyed this
 * way each gets its own, sized to it, and the entry dies with the canvas it
 * belongs to rather than pinning a full-resolution allocation for the session.
 */

/** A canvas and its context, in whichever implementation the host supplies. */
export type Surface = {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: CanvasRenderingContext2D;
};

export type SurfaceFactory = (width: number, height: number) => Surface | null;

const domFactory: SurfaceFactory = (width, height) => {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  return ctx == null ? null : { canvas, ctx };
};

let factory: SurfaceFactory = domFactory;

/**
 * Install the factory blend layers are allocated from.
 *
 * Called by `renderer/testing.ts` for the node suites. Returns the previous
 * factory so a test that installs a spy can put the real one back.
 */
export function setSurfaceFactory(next: SurfaceFactory): SurfaceFactory {
  const previous = factory;
  factory = next;
  return previous;
}

let layers = new WeakMap<object, Surface>();

/**
 * A cleared layer the size of `ctx`'s canvas, or `null` if none can be made.
 *
 * The returned surface is left with an identity transform, full alpha and
 * `source-over`, so the caller only has to apply the transform it wants. It is
 * reused across frames and across elements — the clear below is what makes that
 * safe, and it is why a caller must finish with the layer before asking for
 * another one on the same destination.
 *
 * Resizing a canvas reallocates and clears its drawing buffer even when the
 * value is unchanged, which is why the dimensions are compared first. The FX
 * compositor guards the same way for the same reason.
 */
export function layerFor(ctx: CanvasRenderingContext2D): Surface | null {
  const destination = ctx.canvas as unknown as object & {
    width: number;
    height: number;
  };
  if (destination == null) {
    return null;
  }

  const width = destination.width;
  const height = destination.height;
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  let layer = layers.get(destination);
  if (layer == null) {
    layer = factory(width, height) ?? undefined;
    if (layer == null) {
      return null;
    }
    layers.set(destination, layer);
  } else if (layer.canvas.width !== width || layer.canvas.height !== height) {
    layer.canvas.width = width;
    layer.canvas.height = height;
  }

  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.globalAlpha = 1;
  layer.ctx.globalCompositeOperation = "source-over";
  layer.ctx.clearRect(0, 0, width, height);
  return layer;
}

let named = new Map<string, Surface>();

/**
 * A cleared layer of a caller-chosen size, keyed by a name rather than by a
 * destination canvas.
 *
 * `layerFor` cannot serve this. It keys on `ctx.canvas` and sizes to it, and a
 * template needs both of those to be different: it composites its own document
 * at the template's **native** resolution and then blits that through its
 * transform, and it is asked for while `renderElement` may already be holding
 * that destination's blend layer for the very same draw. Two callers, one key,
 * one buffer — the second would clear the first mid-element.
 *
 * The key is the placed element's id, so two instances of one template get two
 * buffers and neither can overwrite the other within a frame. A `Map` rather
 * than a `WeakMap` because a string is not a weak key; `releaseNamedLayers` is
 * what keeps that from growing without bound, and the renderer calls it with
 * the ids still on the timeline.
 */
export function namedLayer(
  key: string,
  width: number,
  height: number,
): Surface | null {
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  let layer = named.get(key);
  if (layer == null) {
    layer = factory(width, height) ?? undefined;
    if (layer == null) {
      return null;
    }
    named.set(key, layer);
  } else if (layer.canvas.width !== width || layer.canvas.height !== height) {
    // Assigning either dimension reallocates and clears, even to the same
    // value — which is why they are compared first, as `layerFor` does.
    layer.canvas.width = width;
    layer.canvas.height = height;
  }

  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.globalAlpha = 1;
  layer.ctx.globalCompositeOperation = "source-over";
  layer.ctx.clearRect(0, 0, width, height);
  return layer;
}

/**
 * Drop every named layer whose key is no longer in use.
 *
 * A deleted template would otherwise pin a full-resolution canvas for the rest
 * of the session. Called from the paint loop with the ids it just drew, which
 * is the only place that knows.
 */
export function releaseNamedLayers(keep: ReadonlySet<string>): void {
  for (const key of [...named.keys()]) {
    if (!keep.has(key)) {
      named.delete(key);
    }
  }
}

/** Test-only: forget every cached layer, so a suite starts from a clean slate. */
export function resetLayers(): void {
  // A `WeakMap` cannot be cleared, and replacing it is the whole reset.
  layers = new WeakMap();
  named = new Map();
}
