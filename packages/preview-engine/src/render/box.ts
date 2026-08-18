/**
 * Where an element actually landed this frame.
 *
 * The preview draws selection chrome — outline, resize handles, the rotation
 * grip — around the element, which means it needs the *composited* box, not the
 * authored one: after scale, after the position track, at the sampled rotation.
 * That used to work because the outline was drawn from inside each drawer,
 * sharing its local variables. With compositing behind `renderFrame`, the editor
 * asks for the box instead.
 *
 * Kinds differ in which tracks move their box: image and video are driven by the
 * full transform, text moves but does not resize (its scale track changes the
 * font), and gif and shape ignore the position/scale tracks entirely. Those are
 * the same rules the drawers apply.
 */

import type { RenderElement } from "../model/timeline.types";
import { resolveBoxTransform, type BoxTransformOptions } from "./transform";
import {
  samplePosition,
  sampleRotation,
  sampleOpacityAlpha,
} from "../animation/sample";

export type ElementBox = {
  /** Top-left of the unrotated box, in project pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, applied about the box center. */
  rotation: number;
};

/**
 * The box `renderFrame` composited `el` into at `timeMs`, or `null` if the
 * element aborted its draw (a keyframe track sampled before its start).
 */
export function resolveElementBox(
  el: RenderElement,
  timeMs: number,
  opts: BoxTransformOptions = {},
): ElementBox | null {
  const w = Number(el.width) || 0;
  const h = Number(el.height) || 0;
  const staticRotation = (Number(el.rotation) || 0) * (Math.PI / 180);

  switch (el.filetype) {
    case "image":
    case "video": {
      const tf = resolveBoxTransform(el, timeMs, opts);
      if (tf.abort) return null;
      return {
        x: tf.scaleX,
        y: tf.scaleY,
        w: tf.scaleW,
        h: tf.scaleH,
        rotation: tf.rotation,
      };
    }

    case "text": {
      // drawText bails on either track being sampled before the start.
      if (sampleOpacityAlpha(el, timeMs) === false) return null;
      const position = samplePosition(el, timeMs);
      if (position === false) return null;
      let x = el.location?.x ?? 0;
      let y = el.location?.y ?? 0;
      if (position && typeof position === "object" && !opts.ignorePosition) {
        x = position.ax ?? 0;
        y = position.ay ?? 0;
      }
      const rot = sampleRotation(el, timeMs);
      return {
        x,
        y,
        w,
        h,
        rotation: rot && typeof rot === "object" ? rot.ax : staticRotation,
      };
    }

    // gif and shape composite from their authored box; only shape can abort,
    // and only through its opacity track, which does not move the box.
    default:
      return {
        x: el.location?.x ?? 0,
        y: el.location?.y ?? 0,
        w,
        h,
        rotation: staticRotation,
      };
  }
}
