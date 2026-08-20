import type {
  Timeline,
  TimelineElement,
  VisualTimelineElement,
} from "../../@types/timeline";
import { interpolate } from "../animation/interpolation";
import {
  inheritedOpacityOf,
  localMatrixOf,
  parentMatrixOf,
  type TransformMemo,
} from "../timeline/transform";
import { renderControlOutline } from "./controlOutline";
import type { ElementRenderFunction } from "./type";

/**
 * What `renderElement` needs to resolve an element's parent chain.
 *
 * Optional throughout, and that is deliberate: an element with no `parentId`
 * needs none of it, so every existing caller and every existing test keeps
 * working untouched. Pass it and groups apply; omit it and the element is drawn
 * in canvas space exactly as before.
 *
 * `memo` must not outlive the frame — the matrices it holds are resolved at one
 * cursor. `renderTimelineAtTime` builds a fresh one per call.
 */
export type ElementRenderContext = {
  elements: Timeline;
  memo?: TransformMemo;
};

/**
 * Move `ctx` into the element's local space: after this call the element's
 * top-left corner is the origin, and its animated position, rotation and scale
 * are baked into the transform.
 *
 * Split out of `renderElement` so the preview can draw selection chrome in a
 * separate pass — the preview dims out-of-frame pixels, and the control handles
 * must stay at full opacity so they can still be seen and grabbed.
 *
 * The arithmetic moved to `features/timeline/transform.ts#localMatrixOf`, and
 * this is now a one-line application of it. The reason is not tidiness: while
 * the placement rule lived here, as a sequence of ctx calls, nothing else could
 * ask where an element was without reimplementing it — and `previewCanvas`
 * duly did, by hand, for rotation only. Drawing and hit-testing can no longer
 * disagree because they can no longer ask separately.
 *
 * Opacity is deliberately not applied here; it is not part of the transform.
 */
export function applyElementTransform(
  ctx: CanvasRenderingContext2D,
  element: TimelineElement,
  timelineCursor: number,
): void {
  const m = localMatrixOf(element, timelineCursor);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
}

/**
 * Move `ctx` into the space the element's `location` is expressed in.
 *
 * For a root element that is canvas space and this does nothing. For a child it
 * is the product of every ancestor group's transform — which is the entire
 * mechanism by which moving a group moves what is inside it, with not one of
 * the child's keyframes rewritten.
 */
export function applyParentTransform(
  ctx: CanvasRenderingContext2D,
  elementId: string,
  timelineCursor: number,
  context: ElementRenderContext,
): void {
  const m = parentMatrixOf(
    context.elements,
    elementId,
    timelineCursor,
    context.memo,
  );
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
}

export function renderElement<T extends VisualTimelineElement>(
  ctx: CanvasRenderingContext2D,
  elementId: string,
  element: T,
  timelineCursor: number,
  controlOutlineEnabled: boolean,
  renderFunction: ElementRenderFunction<T>,
  context?: ElementRenderContext,
): void {
  ctx.save();

  const { width, height, opacity, startTime } = element;
  const canAnimate = "animation" in element;

  if (context != null) {
    applyParentTransform(ctx, elementId, timelineCursor, context);
  }
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
  // Ancestor opacity multiplies in alongside the element's own. Unlike position,
  // scale and rotation this is a *group* convention rather than an After
  // Effects one — AE parenting deliberately does not pass opacity down — but
  // fading a group ought to fade what is in it, or the name misleads.
  //
  // `globalAlpha *=` was already a multiplication, so the two compose without
  // either side knowing about the other.
  if (context != null) {
    ctx.globalAlpha *= inheritedOpacityOf(
      context.elements,
      elementId,
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
