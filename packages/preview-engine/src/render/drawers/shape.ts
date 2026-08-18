import type { RenderElement } from "../../model/timeline.types";
import type { CanvasCtx } from "../types";
import { sampleOpacityAlpha } from "../../animation/sample";

/**
 * Draw a polygon shape element: opacity, centered rotation, points scaled back
 * from the shape's authoring size (`oWidth`) and offset by the element location,
 * filled with `option.fillColor`.
 *
 * Shapes have no scale/position/rotation keyframe tracks in any renderer — only
 * the opacity track, which the export copies ignored (they applied the static
 * `opacity` alone). Editor affordances (the per-vertex handles the preview drew
 * when the shape was selected) are not drawn here; they belong to the preview's
 * overlay pass.
 */
export function drawShape(
  ctx: CanvasCtx,
  _id: string,
  el: RenderElement,
  timeMs: number,
): boolean {
  const shape = el.shape;
  if (!shape || shape.length === 0) return false;

  const scaleW = Number(el.width) || 0;
  const scaleH = Number(el.height) || 0;
  const scaleX = el.location?.x ?? 0;
  const scaleY = el.location?.y ?? 0;
  const rotation = (Number(el.rotation) || 0) * (Math.PI / 180);

  let alpha = (Number(el.opacity) || 0) / 100;
  const sampled = sampleOpacityAlpha(el, timeMs);
  if (sampled === false) return false;
  if (typeof sampled === "number") alpha = sampled;
  ctx.globalAlpha = alpha;

  const centerX = scaleX + scaleW / 2;
  const centerY = scaleY + scaleH / 2;

  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.beginPath();

  const ratio = (Number(el.oWidth) || scaleW) / (scaleW || 1);

  ctx.fillStyle = el.option?.fillColor ?? "#000000";
  for (let index = 0; index < shape.length; index++) {
    const point = shape[index];
    const px = point[0] / ratio + scaleX;
    const py = point[1] / ratio + scaleY;
    ctx.lineTo(px - centerX, py - centerY);
  }

  ctx.closePath();
  ctx.fill();

  ctx.rotate(-rotation);
  ctx.translate(-centerX, -centerY);
  ctx.globalAlpha = 1;
  return true;
}
