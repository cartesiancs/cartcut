/**
 * Resolve the animated box transform for image/video elements.
 *
 * This is the single home for the `scaleX = x - compareW/2` centering math and
 * the opacity/scale/rotation/position keyframe composition that was duplicated
 * ~6 times across the renderers. Behaviour (including the "abort the draw when a
 * keyframed track is sampled before the element start" quirk, and `compareW/H`
 * starting at 1 rather than 0) is preserved.
 *
 * The track order is opacity -> scale -> rotation -> position, which is what the
 * image path did everywhere. The preview's *video* path sampled position before
 * rotation and returned early inside the position branch, so an element with
 * both tracks active silently lost its rotation animation; video now composes
 * the same way image always has.
 */

import type { RenderElement } from "../model/timeline.types";
import {
  sampleScale,
  sampleRotation,
  samplePosition,
  sampleOpacityAlpha,
} from "../animation/sample";

export type BoxTransform = {
  /** When true the element must not be drawn this frame (matches the original
   * `return false` early-out when a keyframed track precedes the start). */
  abort: boolean;
  scaleX: number;
  scaleY: number;
  scaleW: number;
  scaleH: number;
  rotation: number; // radians
  alpha: number; // 0..1
};

export type BoxTransformOptions = {
  /** Skip the `position` track (the preview drags elements free of keyframes). */
  ignorePosition?: boolean;
};

export function resolveBoxTransform(
  el: RenderElement,
  timeMs: number,
  opts: BoxTransformOptions = {},
): BoxTransform {
  const x = el.location?.x ?? 0;
  const y = el.location?.y ?? 0;
  const w = Number(el.width) || 0;
  const h = Number(el.height) || 0;

  let scaleW = w;
  let scaleH = h;
  let scaleX = x;
  let scaleY = y;
  let compareW = 1;
  let compareH = 1;
  let rotation = (Number(el.rotation) || 0) * (Math.PI / 180);
  let alpha = (Number(el.opacity) || 0) / 100;

  const opacity = sampleOpacityAlpha(el, timeMs);
  const position = samplePosition(el, timeMs);
  // opacity-active-before-start OR position-active-before-start aborts the draw.
  if (opacity === false || position === false) {
    return { abort: true, scaleX, scaleY, scaleW, scaleH, rotation, alpha };
  }
  if (typeof opacity === "number") alpha = opacity;

  const scale = sampleScale(el, timeMs);
  if (typeof scale === "number") {
    scaleW = w * scale;
    scaleH = h * scale;
    compareW = scaleW - w;
    compareH = scaleH - h;
    scaleX = x - compareW / 2;
    scaleY = y - compareH / 2;
  }

  const rot = sampleRotation(el, timeMs);
  if (rot && typeof rot === "object") rotation = rot.ax;

  if (position && typeof position === "object" && !opts.ignorePosition) {
    scaleX = (position.ax ?? 0) - compareW / 2;
    scaleY = (position.ay ?? 0) - compareH / 2;
  }

  return { abort: false, scaleX, scaleY, scaleW, scaleH, rotation, alpha };
}
