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
import { blendOf, DEFAULT_BLEND, isBlendIsolating } from "./blend";
import { renderControlOutline } from "./controlOutline";
import { applyLutGrade, lutGradeFor } from "./lut/apply";
import { layerFor } from "./surface";
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
  /**
   * True while drawing into a buffer that holds this element alone.
   *
   * A transition renders each of its two clips into its own cleared,
   * *transparent* canvas before mixing them in GL — see
   * `fx/compositor.ts#renderClip`. There is nothing beneath a clip there, so a
   * blend mode has nothing to blend with: `multiply` against transparent black
   * would annihilate the clip and the dissolve would play into a hole.
   *
   * So blend is suspended for the length of the transition. That matches what
   * every NLE does, and it follows from what a transition is — an operation on
   * a *pair* of clips, not a property of one of them. The clip's own transform,
   * opacity, keyframes and group parenting all still apply, because those are
   * properties of the clip alone.
   */
  isolated?: boolean;
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
  const blend = context?.isolated === true ? DEFAULT_BLEND : blendOf(element);

  /**
   * The clip's colour grade, or `null` when there is nothing to do.
   *
   * Deliberately **not** suspended by `isolated`, which is the one place this
   * differs from `blend`. A blend mode describes how a clip meets what is
   * beneath it, and inside a transition there is nothing beneath it — so it is
   * suspended. A grade is a property of the clip itself, in the same family as
   * its opacity, its transform and its keyframes, and a cross-dissolve between
   * two graded shots has to dissolve the *graded* pictures. Suspending it here
   * would make a clip jump colour for the length of every transition.
   *
   * Resolved before the fast-path decision below rather than inside the layer
   * branch, because a clip whose LUT is not installed must keep the untouched
   * code path instead of allocating a layer in order to do nothing to it.
   */
  const grade = lutGradeFor(element);

  // The path every clip took before blend modes existed, and the one almost
  // every clip still takes. Byte-for-byte what it was: no layer is allocated,
  // no extra blit is issued, and `golden.test.ts`'s digests are the proof.
  if (!isBlendIsolating(blend) && grade == null) {
    drawDirect(
      ctx,
      elementId,
      element,
      timelineCursor,
      controlOutlineEnabled,
      renderFunction,
      context,
    );
    return;
  }

  const layer = layerFor(ctx);

  if (layer != null) {
    // Isolation: the clip is drawn whole — every sub-draw its renderer makes,
    // in order, against transparency — and then composited once. Anything less
    // blends a text clip's outline against its own fill.
    layer.ctx.setTransform(ctx.getTransform());
    // Inherited from the caller rather than reset: `globalAlpha` is a *group*
    // multiplier here, and the FX compositor draws through this function with
    // one already set. Baking it into the layer and blitting at 1 is also what
    // gives "layer opacity, then blend" — the order Photoshop uses — instead of
    // opacity fighting the blend per sub-draw.
    layer.ctx.globalAlpha = ctx.globalAlpha;

    drawDirect(
      layer.ctx,
      elementId,
      element,
      timelineCursor,
      false,
      renderFunction,
      context,
    );

    // The clip is finished, alone, at destination resolution and against
    // transparency — which is exactly the input a colour grade wants. Before
    // the blend, so the order is "grade the clip, then combine it with the
    // scene", which is what every NLE does and the only order under which a
    // `multiply` clip and a graded clip mean independent things.
    //
    // Group opacity has already been baked in above, and that is harmless:
    // `getImageData` and `texImage2D` both hand over *straight* colour, so a
    // clip at 50% is graded as the colour it is rather than as a darker one.
    if (grade != null) {
      applyLutGrade(layer, grade);
    }

    ctx.save();
    // Identity, because the layer is already in the destination's pixel space —
    // it was drawn under the destination's own transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  } else {
    // No surface to isolate onto — a host with no `document` and no factory
    // installed. Set the mode and draw straight through: exact for the element
    // types that issue a single `drawImage` or a single `fill`, which is all of
    // them except text, and never a blank frame.
    //
    // A grade is simply lost here rather than approximated. There is nowhere to
    // read the clip's pixels back from without also reading the scene under it,
    // and grading the scene would be far more wrong than not grading the clip.
    ctx.save();
    ctx.globalCompositeOperation = blend;
    drawDirect(
      ctx,
      elementId,
      element,
      timelineCursor,
      false,
      renderFunction,
      context,
    );
    ctx.restore();
  }

  // Deliberately outside the blend. The selection outline is chrome, not
  // picture: under `difference` a blended one would render as its own inverse
  // and become invisible on exactly the clip the user just selected.
  if (controlOutlineEnabled) {
    ctx.save();
    if (context != null) {
      applyParentTransform(ctx, elementId, timelineCursor, context);
    }
    applyElementTransform(ctx, element, timelineCursor);
    renderControlOutline(ctx, 0, 0, element.width, element.height);
    ctx.restore();
  }
}

/**
 * Place the element and draw it, straight into `ctx`.
 *
 * This is `renderElement`'s original body, unchanged. It is a separate function
 * only so that the blended path can aim it at a layer instead of at the frame.
 */
function drawDirect<T extends VisualTimelineElement>(
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
