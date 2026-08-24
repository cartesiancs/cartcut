import type { ShapeElementType } from "../../@types/timeline";
import type { ElementRenderFunction } from "./type";

export const renderShape: ElementRenderFunction<ShapeElementType> = (
  ctx,
  elementId,
  shapeElement,
  timelineCursor,
) => {
  const { width, height, oWidth, oHeight, shape, option } = shapeElement;

  // Authoring space to draw space, one factor per axis. Non-uniform is the
  // point: a stretched shape is stretched. The single `oWidth / width` this
  // replaces divided *both* coordinates, so `height` was never read at all —
  // dragging a shape taller grew its selection box, its hit area and its
  // rotation pivot while the painted polygon stayed exactly where it was.
  const sx = scaleOf(width, oWidth, oHeight);
  const sy = scaleOf(height, oHeight, oWidth);

  ctx.beginPath();
  // Once, not once per point. Inside the loop it was never set at all for a
  // shape with no points, leaving the fill to whatever the last element used.
  ctx.fillStyle = option.fillColor;

  for (let index = 0; index < shape.length; index++) {
    const point = shape[index];
    ctx.lineTo(point[0] * sx, point[1] * sy);
  }

  ctx.closePath();
  ctx.fill();
};

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
