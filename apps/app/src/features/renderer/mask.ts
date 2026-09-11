/**
 * Where a clip's mask becomes coverage.
 *
 * Two steps, and the split between them is the whole design:
 *
 *  1. **`maskRenderFor` resolves the mask into device pixels**, on the CPU,
 *     with no canvas involved. It samples the mask's keyframes, builds the path
 *     in the element's own local space, and maps it through the full matrix the
 *     destination will be drawn under.
 *  2. **`applyMask` erases what the path does not cover**, with a single
 *     `destination-in` fill under an identity transform.
 *
 * ## Why the path is mapped to device space rather than drawn under a transform
 *
 * The feather is a blur, and canvas blur units are not transform-safe. Measured
 * on the shipped `@napi-rs/canvas`, `ctx.filter = "blur(4px)"` under a scale of
 * 2 produces roughly a 26px ramp rather than a 14px one — it is scaled by the
 * current transform. `shadowBlur`, in both engines, is not. `renderer/shadow.ts`
 * documents the same hazard from the other side and pays for it with an
 * explicit device conversion.
 *
 * Rather than depend on which of those two behaviours a given engine applies to
 * `filter` — and the preview runs on Chromium while every renderer suite runs
 * on Skia, so a divergence there would be invisible in the suite and wrong in
 * the app — the path is transformed to device pixels here and filled with the
 * identity transform set. The blur radius is then a device number by
 * construction, and both engines have to agree because neither is being asked
 * to scale anything.
 *
 * An affine matrix maps a cubic's control points to the transformed cubic's
 * control points exactly, so nothing is approximated by doing this
 * (`features/mask/geometry.ts`).
 *
 * ## Why the matrix is not `worldMatrixOf`
 *
 * `worldMatrixOf` maps element-local into *project* space. The destination is
 * not in project space: the preview's context carries `zoom × dpr` and a pan
 * offset before `renderElement` is ever entered. So the matrix here is the
 * destination's own transform, composed with the parent chain and the
 * element's local transform — precisely the three that `renderElement` and
 * `drawDirect` apply between them.
 *
 * The trap this avoids is a nasty one: every renderer suite draws at identity,
 * so a `worldMatrixOf`-only mask is exact in every test and misplaced in the
 * app at any zoom other than 100% on any display other than 1x.
 */

import type { MaskNode, TimelineElement } from "../../@types/timeline";
import { traceMaskPath } from "../mask/draw";
import { transformNodes } from "../mask/geometry";
import { isMaskActive, maskOf } from "../mask/maskShape";
import { maskNodesInElementSpace } from "../mask/place";
import { maskSampleAt } from "../mask/sample";
import {
  type Mat,
  localMatrixOf,
  multiply,
  parentMatrixOf,
  sampledBoxOf,
  type TransformMemo,
} from "../timeline/transform";
import type { Surface } from "./surface";

/** A mask resolved for one element at one cursor, ready to be composited. */
export type MaskRender = {
  /** The closed path, in the destination's device pixels. */
  nodes: MaskNode[];
  /** Blur radius for the edge, already in device pixels. */
  featherDevicePx: number;
  /** Keep the outside instead of the inside. */
  invert: boolean;
};

/** `sqrt(|det|)`, matching `renderer/shadow.ts#matrixScale`. */
function scaleOfMat(m: Mat): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function toMat(m: {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}): Mat {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

/**
 * The destination transform, as a `Mat`.
 *
 * Read before the layer is allocated, because the layer inherits it
 * (`renderElement` does `layer.ctx.setTransform(ctx.getTransform())`) and then
 * `drawDirect` composes the element's own on top — so this is the base of the
 * same chain, captured at the same moment.
 */
export function destinationMatrix(ctx: CanvasRenderingContext2D): Mat {
  return toMat(ctx.getTransform());
}

/**
 * Element-local pixels to the destination's device pixels.
 *
 * `base` is `destinationMatrix(ctx)`, then the parent chain, then the element's
 * own transform — exactly the three `renderElement` and `drawDirect` apply
 * between them. Shared by the mask and the colour adjustments' finish pass,
 * because both have to know where the clip's box lands on the layer, and two
 * derivations of that would be the `worldMatrixOf` trap waiting to happen
 * twice.
 */
export function elementDeviceMatrix(
  elements: Record<string, TimelineElement> | undefined,
  elementId: string,
  element: TimelineElement,
  timelineCursor: number,
  base: Mat,
  memo?: TransformMemo,
): Mat {
  const parent =
    elements == null
      ? null
      : parentMatrixOf(elements, elementId, timelineCursor, memo);
  return multiply(
    parent == null ? base : multiply(base, parent),
    localMatrixOf(element, timelineCursor),
  );
}

/** Device pixels per element pixel, `sqrt(|det|)`. */
export function deviceScaleOf(m: Mat): number {
  return scaleOfMat(m);
}

/**
 * Resolve an element's mask into device space, or `null` if it cuts nothing.
 *
 * `null` for: no mask, a `pen` mask with too few nodes to enclose anything, a
 * degenerate transform, or a path that came out empty. All of them render as a
 * pass-through — the contract a LUT that is not installed already has — and all
 * of them cost nothing, because `renderElement` checks this *before* deciding
 * whether to allocate a layer.
 *
 * Deliberately not suspended inside a transition. A mask is a property of the
 * clip, in the same family as its grade and unlike its blend: a masked clip has
 * to stay masked through a cross-dissolve, or it would pop to its full frame
 * for the length of every transition it is in.
 */
export function maskRenderFor(
  elements: Record<string, TimelineElement> | undefined,
  elementId: string,
  element: TimelineElement,
  timelineCursor: number,
  base: Mat,
  memo?: TransformMemo,
): MaskRender | null {
  const mask = maskOf(element);
  if (!isMaskActive(mask) || mask == null) {
    return null;
  }

  const sample = maskSampleAt(element, mask, timelineCursor);
  // The box the clip is *drawn* at, so the mask keeps its grip on the picture
  // while a `size` track moves it. A mask's own location and size are stored
  // as percentages of this box, so reading the stored one instead would slide
  // the mask off the clip over the length of the resize — visible only in a
  // project that animates both, which is exactly when it matters.
  const box = sampledBoxOf(element, timelineCursor);
  const local = maskNodesInElementSpace(mask, sample, box);
  if (local.length < 2) {
    return null;
  }

  const chain = elementDeviceMatrix(
    elements,
    elementId,
    element,
    timelineCursor,
    base,
    memo,
  );

  const scale = scaleOfMat(chain);
  // A clip scaled to nothing covers no pixels, so there is nothing to cut out
  // of it — and `feather * 0` would be a blur of zero on a path collapsed to a
  // point, which is a fill of nothing that `destination-in` would read as
  // "erase the whole layer".
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  return {
    nodes: transformNodes(local, chain),
    featherDevicePx: sample.feather * scale,
    invert: mask.invert === true,
  };
}

/**
 * Cut the finished, isolated clip layer down to the mask, in place.
 *
 * `destination-in` multiplies the layer's alpha by the alpha of what is drawn,
 * so a hard path erases everything outside it and a blurred one leaves a ramp.
 * The layer is the size of the whole destination and the clip has already been
 * drawn into it alone, so "everything outside" is exactly right — there is
 * nothing else on the layer to erase by accident.
 *
 * The blur is set through `ctx.filter` rather than approximated with
 * `shadowBlur`, and the transform is identity because the path arrives already
 * in device pixels — see this module's header for why that pairing is the
 * point rather than a convenience.
 */
export function applyMask(surface: Surface, render: MaskRender): boolean {
  const ctx = surface.ctx;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = render.invert
      ? "destination-out"
      : "destination-in";
    if (render.featherDevicePx > 0) {
      ctx.filter = `blur(${render.featherDevicePx}px)`;
    }
    // Opaque white: only the alpha of this fill is read, and white is the value
    // that survives a `filter` chain unchanged in every engine.
    ctx.fillStyle = "#ffffff";
    if (!traceMaskPath(ctx, render.nodes)) {
      return false;
    }
    ctx.fill();
    return true;
  } finally {
    // `filter` is context state like any other, and a leaked `blur()` would
    // apply to the next element drawn onto this layer.
    ctx.filter = "none";
    ctx.restore();
  }
}

/**
 * The mask, as a clip region, for the path with no layer to composite onto.
 *
 * Reached only where no surface factory is installed and there is no
 * `document` — no shipping path, and no test path either, since
 * `renderer/testing.ts` installs the Skia factory. It exists so that the
 * degraded branch is *honest* rather than silently unmasked.
 *
 * Two things are lost here and both are stated rather than approximated, the
 * way `renderElement` states that a grade is simply lost on this branch:
 *
 *  - **the feather**, because a clip region has no partial coverage. The edge
 *    comes out hard.
 *  - **`invert`**, because `clip()` intersects and cannot subtract. An inverted
 *    mask is dropped entirely on this branch rather than being applied the
 *    wrong way round, which would hide exactly the part the user meant to keep.
 *
 * Must be called with the destination's transform already saved by the caller:
 * it sets the identity transform to install the region (clip regions are stored
 * in device space, so the transform in force afterwards does not move it) and
 * leaves the transform for the caller to restore.
 */
export function clipToMask(
  ctx: CanvasRenderingContext2D,
  render: MaskRender,
): boolean {
  if (render.invert) {
    return false;
  }
  const before = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const traced = traceMaskPath(ctx, render.nodes);
  if (traced) {
    ctx.clip();
  }
  ctx.setTransform(before);
  return traced;
}
