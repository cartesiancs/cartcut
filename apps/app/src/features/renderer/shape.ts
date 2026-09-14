import type { ShapeElementType } from "../../@types/timeline";
import { appendSubpath } from "../mask/draw";
import { roundCornersEach } from "../mask/round";
import { shapeGeometryOf } from "../shape/shapeGeometry";
import { outlineInBox, radiusAtOf } from "../shape/shapeOutline";
import type { ElementRenderFunction } from "./type";

/**
 * A shape's fill.
 *
 * Two paths, and which one runs is decided by whether the clip has a recipe.
 *
 *  - **No recipe** is every shape made before recipes existed and every polygon
 *    clicked out by hand: the stored point list, straight segments, exactly as
 *    it has always drawn. Not one line of it changed.
 *  - **A recipe** generates the outline instead, as cubics, so a corner can be
 *    rounded and an ellipse can be a real ellipse rather than a fifty-sided
 *    approximation of one.
 *
 * The recipe path draws in the **drawn box** rather than the authoring one, and
 * that is the whole reason the corner radius is in drawn pixels: the outline is
 * built at the size it will appear, so rounding happens after the stretch and a
 * 400 by 50 rectangle gets circular corners instead of elliptical ones. It is
 * the order `mask/place.ts` states, for the same reason.
 */
export const renderShape: ElementRenderFunction<ShapeElementType> = (
  ctx,
  elementId,
  shapeElement,
  timelineCursor,
) => {
  const { shape, option } = shapeElement;

  // Once, not once per point. Inside the loop it was never set at all for a
  // shape with no points, leaving the fill to whatever the last element used.
  ctx.fillStyle = option.fillColor;

  const geometry = shapeGeometryOf(shapeElement);
  if (geometry != null) {
    const { width, height } = drawnBox(shapeElement);
    ctx.beginPath();
    for (const nodes of outlineInBox(geometry, { width, height })) {
      appendSubpath(ctx, roundCornersEach(nodes, radiusAtOf(geometry, nodes.length)));
    }
    // The default nonzero rule, so a reversed inner ring is a hole. Asking for
    // `"evenodd"` would also change what a self-intersecting outline fills.
    ctx.fill();
    return;
  }

  const { sx, sy } = shapeDrawScale(shapeElement);

  ctx.beginPath();

  for (let index = 0; index < shape.length; index++) {
    const point = shape[index];
    ctx.lineTo(point[0] * sx, point[1] * sy);
  }

  ctx.closePath();
  ctx.fill();
};

/**
 * The box a recipe is generated into: the size the clip is actually drawn at.
 *
 * Not `width`/`height` read raw, because `drawDirect` may have substituted a
 * sampled `size` into them and either may be missing or zero on a hand-edited
 * project. Falling back through the authoring box and then to it reproduces
 * what `shapeDrawScale` would have done with the same numbers, so a recipe and
 * a point list of the same shape land in the same place.
 */
function drawnBox(element: ShapeElementType): { width: number; height: number } {
  const { sx, sy } = shapeDrawScale(element);
  const authoredWidth = usableSize(element.oWidth)
    ? element.oWidth
    : usableSize(element.oHeight)
      ? element.oHeight
      : 100;
  const authoredHeight = usableSize(element.oHeight)
    ? element.oHeight
    : usableSize(element.oWidth)
      ? element.oWidth
      : 100;
  return { width: authoredWidth * sx, height: authoredHeight * sy };
}

/**
 * Authoring space to draw space, one factor per axis. Non-uniform is the
 * point: a stretched shape is stretched. The single `oWidth / width` this
 * replaces divided *both* coordinates, so `height` was never read at all —
 * dragging a shape taller grew its selection box, its hit area and its
 * rotation pivot while the painted polygon stayed exactly where it was.
 *
 * Exported because the polygon tool's on-canvas vertex overlay has to land on
 * the same points the fill has its corners at, and deriving that twice is how
 * the two drift apart.
 */
export function shapeDrawScale(shapeElement: {
  width: number;
  height: number;
  oWidth: number;
  oHeight: number;
}): { sx: number; sy: number } {
  return {
    sx: scaleOf(shapeElement.width, shapeElement.oWidth, shapeElement.oHeight),
    sy: scaleOf(shapeElement.height, shapeElement.oHeight, shapeElement.oWidth),
  };
}

/**
 * Drawn size over authored size, falling back across the axes and then to 1.
 *
 * The other axis first, because that is what a project saved before `oHeight`
 * was written looks like: `oWidth` alone, with both coordinates scaled by it.
 * Reading such a shape with `sy = 1` would hold it at its authored height while
 * its width grew — a shape the user had already resized would change shape on
 * load. Falling through to the other axis reproduces the old uniform behaviour
 * exactly whenever `oHeight` is absent.
 *
 * The last resort is 1, never 0 and never NaN: an authored size of zero would
 * collapse every point onto an axis, and a NaN would put the path off-canvas.
 */
function scaleOf(drawn: number, authored: number, fallback: number): number {
  if (!Number.isFinite(drawn)) {
    return 1;
  }
  const denominator = usableSize(authored) ? authored : fallback;
  if (!usableSize(denominator)) {
    return 1;
  }
  return drawn / denominator;
}

function usableSize(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}
