import type { VisualTimelineElement } from "../../@types/timeline";
import { interpolate } from "../animation/interpolation";
import { toRadian } from "../math/geom";
import { renderControlOutline } from "./controlOutline";
import type { ElementRenderFunction } from "./type";

/**
 * Move `ctx` into the element's local space: after this call the element's
 * top-left corner is the origin, and its animated position, rotation and scale
 * are baked into the transform.
 *
 * Split out of `renderElement` so the preview can draw selection chrome in a
 * separate pass — the preview dims out-of-frame pixels, and the control handles
 * must stay at full opacity so they can still be seen and grabbed.
 *
 * Opacity is deliberately not applied here; it is not part of the transform.
 */
export function applyElementTransform(
  ctx: CanvasRenderingContext2D,
  element: VisualTimelineElement,
  timelineCursor: number,
): void {
  let { width, height, rotation: rotationInDegrees, startTime } = element;

  // TODO: 회전, 스케일 중심을 사용자가 지정할 수 있도록 수정
  const rotationCenter = {
    x: width / 2,
    y: height / 2,
  };

  const scaleCenter = {
    x: width / 2,
    y: height / 2,
  };

  const canAnimate = "animation" in element;

  // Position
  let { x, y } = element.location;
  if (canAnimate && "position" in element.animation) {
    x = interpolate(
      x,
      element.animation.position.ax,
      startTime,
      timelineCursor,
    );
    y = interpolate(
      y,
      element.animation.position.ay,
      startTime,
      timelineCursor,
    );
  }
  ctx.translate(x, y);

  // Rotation
  ctx.translate(rotationCenter.x, rotationCenter.y);
  if (
    canAnimate &&
    "rotation" in element.animation &&
    element.animation.rotation.isActivate
  ) {
    rotationInDegrees = interpolate(
      rotationInDegrees,
      element.animation.rotation.ax,
      startTime,
      timelineCursor,
    );
  }
  ctx.rotate(toRadian(rotationInDegrees));
  ctx.translate(-rotationCenter.x, -rotationCenter.y);

  // Scale
  ctx.translate(scaleCenter.x, scaleCenter.y);
  let scale = 1;
  if (
    canAnimate &&
    "scale" in element.animation &&
    element.animation.scale.isActivate
  ) {
    scale =
      interpolate(10, element.animation.scale.ax, startTime, timelineCursor) /
      10;
  }
  ctx.scale(scale, scale); // TODO: x, y 스케일을 다르게 지정할 수 있도록 수정
  ctx.translate(-scaleCenter.x, -scaleCenter.y);
}

export function renderElement<T extends VisualTimelineElement>(
  ctx: CanvasRenderingContext2D,
  elementId: string,
  element: T,
  timelineCursor: number,
  controlOutlineEnabled: boolean,
  renderFunction: ElementRenderFunction<T>,
): void {
  ctx.save();

  const { width, height, opacity, startTime } = element;
  const canAnimate = "animation" in element;

  applyElementTransform(ctx, element, timelineCursor);

  // Opacity
  let opacityScaledBy100 = opacity;
  if (
    canAnimate &&
    "opacity" in element.animation &&
    element.animation.opacity.isActivate
  ) {
    opacityScaledBy100 = interpolate(
      opacity,
      element.animation.opacity.ax,
      startTime,
      timelineCursor,
    );
  }
  ctx.globalAlpha *= opacityScaledBy100 / 100;

  renderFunction(ctx, elementId, element, timelineCursor);

  if (controlOutlineEnabled) {
    renderControlOutline(ctx, 0, 0, width, height);
  }

  ctx.restore();
}
