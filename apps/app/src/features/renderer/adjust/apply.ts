/**
 * Where a clip's colour adjustments are turned into pixels.
 *
 * Two halves, applied at two different points in `renderElement`'s layer path
 * (`features/adjust/spec.ts` says which control is which):
 *
 *  - **Tone** is a 3D LUT baked from the settings and handed to the *existing*
 *    clip-LUT applier. It runs before the clip's own LUT — correct the shot,
 *    then apply the look, which is Lumetri's Basic-then-Creative order.
 *  - **Finish** runs after the clip's LUT, through its own applier, injected
 *    here the way `lut/apply.ts` injects its own: the GPU applier is tried
 *    first, the CPU applier takes over permanently if no WebGL context can be
 *    made, and the node suites install the CPU one on purpose so the shipping
 *    fallback is what they test.
 *
 * Neither is suspended inside a transition. Like a grade and a mask, and
 * unlike a blend, an adjustment is a property of the clip itself.
 */

import type {
  ColorAdjustments,
  TimelineElement,
} from "../../../@types/timeline";
import { toneLutFor } from "../../adjust/bake";
import {
  blurStepFor,
  clarityRadiusDevice,
  grainOffsetFor,
  type FinishAmounts,
} from "../../adjust/finishMath";
import {
  CLARITY_STRENGTH,
  FINISH_KEYS,
  PARTICLES_CELL_PX,
  PARTICLES_STRENGTH,
  SHARPEN_RADIUS_PX,
  SHARPEN_STRENGTH,
} from "../../adjust/spec";
import {
  type Mat,
  invert,
  sampledBoxOf,
  type TransformMemo,
} from "../../timeline/transform";
import { adjustOf, pickAdjustments } from "../adjust";
import { directLutGrade, type LutGrade } from "../lut/apply";
import { deviceScaleOf, elementDeviceMatrix } from "../mask";
import type { Surface } from "../surface";
import { createCpuFinishApplier } from "./cpu";
import { createGpuFinishApplier } from "./gpu";

// -------------------------------------------------------------------- tone

/**
 * The tone half of a clip's adjustments, as a LUT grade, or `null` when the
 * tone controls are all at zero.
 *
 * Resolved before `renderElement`'s fast-path decision, like the clip's LUT, so
 * a clip whose only adjustment is a sharpen does not bake an identity table.
 */
export function adjustToneFor(
  element: TimelineElement | undefined | null,
): LutGrade | null {
  const values = adjustOf(element);
  if (values == null) {
    return null;
  }
  const baked = toneLutFor(values);
  if (baked == null) {
    return null;
  }
  return directLutGrade(baked.key, baked.lut, 1);
}

// ------------------------------------------------------------------ finish

/** The finish half, resolved for one element at one cursor. */
export type FinishRender = {
  amounts: FinishAmounts;
  /** Element-local pixels → the layer's device pixels. */
  toDevice: Mat;
  /** Device pixels → element-local pixels. */
  toLocal: Mat;
  /** The box the clip is drawn at, in element-local pixels. */
  box: { width: number; height: number };
  /** Sharpen's tap spacing, in device pixels. */
  sharpenStep: number;
  /** Clarity's blur tap spacing, in device pixels. */
  clarityStep: number;
  /** One grain cell, in element-local pixels. */
  grainCell: number;
  /** The per-frame offset into the grain hash. */
  grainOffset: [number, number];
};

/** Just the scaled strengths, from normalized values. Zero means skipped. */
export function finishAmountsOf(values: ColorAdjustments): FinishAmounts {
  const u = (v: number | undefined) => (v ?? 0) / 100;
  return {
    clarity: u(values.clarity) * CLARITY_STRENGTH,
    sharpen: u(values.sharpen) * SHARPEN_STRENGTH,
    particles: u(values.particles) * PARTICLES_STRENGTH,
    fade: u(values.fade),
    vignette: u(values.vignette),
  };
}

export function isFinishActive(amounts: FinishAmounts): boolean {
  return (
    amounts.clarity > 0 ||
    amounts.sharpen > 0 ||
    amounts.particles > 0 ||
    amounts.fade > 0 ||
    amounts.vignette !== 0
  );
}

/**
 * The finish half of a clip's adjustments, placed on the layer, or `null`.
 *
 * `null` for: no adjustments, every finish control at zero, a clip scaled to
 * nothing, or no applier. All of them keep `renderElement`'s fast path.
 *
 * `base` is `destinationMatrix(ctx)`, read before the layer exists — the same
 * base the mask takes, for the same reason: the layer is in the destination's
 * device pixels, and the preview's context carries zoom and DPR. Every
 * distance below is therefore measured in the *clip's* pixels and converted,
 * so the picture is the same at any zoom and in the export.
 */
export function finishRenderFor(
  elements: Record<string, TimelineElement> | undefined,
  elementId: string,
  element: TimelineElement,
  timelineCursor: number,
  base: Mat,
  memo?: TransformMemo,
): FinishRender | null {
  const values = adjustOf(element);
  if (values == null) {
    return null;
  }
  const amounts = finishAmountsOf(pickAdjustments(values, FINISH_KEYS));
  if (!isFinishActive(amounts)) {
    return null;
  }
  if (currentApplier() == null) {
    return null;
  }

  const toDevice = elementDeviceMatrix(
    elements,
    elementId,
    element,
    timelineCursor,
    base,
    memo,
  );
  const scale = deviceScaleOf(toDevice);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const box = sampledBoxOf(element, timelineCursor);
  if (!(box.width > 0) || !(box.height > 0)) {
    return null;
  }

  return {
    amounts,
    toDevice,
    toLocal: invert(toDevice),
    box: { width: box.width, height: box.height },
    sharpenStep: SHARPEN_RADIUS_PX * scale,
    clarityStep: blurStepFor(clarityRadiusDevice(box.width, box.height, scale)),
    grainCell: PARTICLES_CELL_PX,
    grainOffset: grainOffsetFor(timelineCursor),
  };
}

// ----------------------------------------------------------------- applier

/** Finish a surface in place. `false` means it could not, so nothing changed. */
export type FinishApplier = {
  apply(surface: Surface, render: FinishRender): boolean;
  dispose(): void;
};

let applier: FinishApplier | null = null;
let applierChosen = false;

/** Install a specific applier, or `null` for the default choice. Tests only. */
export function setFinishApplier(next: FinishApplier | null): FinishApplier | null {
  const previous = applier;
  applier = next;
  applierChosen = next != null;
  return previous;
}

function currentApplier(): FinishApplier | null {
  if (applierChosen) {
    return applier;
  }
  applierChosen = true;
  applier = createGpuFinishApplier() ?? createCpuFinishApplier();
  return applier;
}

/** Test-only: forget the chosen applier so the next call picks again. */
export function resetFinishApplier(): void {
  applier?.dispose();
  applier = null;
  applierChosen = false;
}

/**
 * Finish a graded, isolated clip layer in place.
 *
 * `false` is not an error: the clip is composited with its tone and LUT but
 * without the finish, which is what a build without the feature draws plus
 * what did succeed.
 */
export function applyFinish(surface: Surface, render: FinishRender): boolean {
  const active = currentApplier();
  if (active == null) {
    return false;
  }
  return active.apply(surface, render);
}
