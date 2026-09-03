/**
 * Where the camera bubble goes, and which part of the camera it shows.
 *
 * Two separate questions, and conflating them is the classic bubble bug. A
 * webcam is 16:9; a bubble is usually a circle. Drawing the whole camera frame
 * into a square destination squashes the face — so the *destination* is decided
 * by the layout and the *source* is a centre crop of the camera at the
 * destination's aspect, which is what `object-fit: cover` does in CSS and what
 * `drawImage`'s nine-argument form has to be told explicitly.
 *
 * Sizes are fractions of the frame *height* rather than of its diagonal or its
 * area, so a bubble looks the same on a 16:9 display and a 21:9 one. On an
 * ultrawide a diagonal-relative bubble grows for no reason anybody watching can
 * see.
 *
 * All of it is arithmetic on plain numbers, so it runs under `environment:
 * "node"` and the same function serves the live overlay preview and the
 * composite pass. That shared use is the point: if the two disagreed, the
 * bubble the user positions during recording would not be the bubble in the
 * file.
 */

import type { BubbleCorner, BubbleShape, BubbleSize } from "./recordSettings";
import type { Size } from "./captureSettings";

export type Rect = { x: number; y: number; width: number; height: number };

/** Bubble height as a fraction of the frame's height. */
const SIZE_FRACTIONS: Record<BubbleSize, number> = {
  small: 0.14,
  medium: 0.2,
  large: 0.28,
};

/** Gap between the bubble and the frame edge, also as a fraction of height. */
const MARGIN_FRACTION = 0.025;

/**
 * Corner rounding for the `"rounded"` shape, as a fraction of the shorter side.
 *
 * A circle is not this with the fraction at 0.5 — `bubbleRect` gives a circle a
 * square destination, and a rounded rectangle the camera's own aspect, so the
 * two differ in shape before any rounding happens.
 */
const ROUNDED_CORNER_FRACTION = 0.14;

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The bubble's box in frame pixels.
 *
 * `source` is the camera's own frame, and it only matters for the `"rounded"`
 * shape, which keeps the camera's aspect. A circle is always square, whatever
 * the camera is.
 *
 * The result is clamped into the frame, so a bubble larger than the frame it
 * sits in degrades to filling it rather than hanging off the edge.
 */
export function bubbleRect(
  frame: Size,
  source: Size,
  size: BubbleSize,
  corner: BubbleCorner,
  shape: BubbleShape,
): Rect {
  const frameWidth = positiveOr(frame.width, 1);
  const frameHeight = positiveOr(frame.height, 1);

  const margin = Math.round(frameHeight * MARGIN_FRACTION);
  const height = Math.round(frameHeight * SIZE_FRACTIONS[size]);

  const sourceAspect =
    positiveOr(source.width, 16) / positiveOr(source.height, 9);
  const width =
    shape === "circle" ? height : Math.round(height * sourceAspect);

  // Fit rather than overflow. Both axes, because a wide `"rounded"` bubble on a
  // narrow frame runs out of width long before it runs out of height.
  const fit = Math.min(
    1,
    (frameWidth - margin * 2) / width,
    (frameHeight - margin * 2) / height,
  );
  const fitted = {
    width: Math.max(2, Math.round(width * Math.min(1, fit))),
    height: Math.max(2, Math.round(height * Math.min(1, fit))),
  };

  const left = corner === "top-left" || corner === "bottom-left";
  const top = corner === "top-left" || corner === "top-right";

  return {
    x: left ? margin : frameWidth - margin - fitted.width,
    y: top ? margin : frameHeight - margin - fitted.height,
    width: fitted.width,
    height: fitted.height,
  };
}

/**
 * The part of the camera frame that fills `destination` without distortion.
 *
 * A centre crop: the source rectangle has the destination's aspect ratio, is as
 * large as it can be inside the camera frame, and is centred. Handing this to
 * `drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)` is what makes a 16:9
 * webcam sit in a circle looking like a person rather than like a face pressed
 * against glass.
 *
 * Centred horizontally *and* vertically. Cropping to the top would frame heads
 * better and is what some recorders do, but it also decapitates anyone sitting
 * low in frame, and a bubble the user can see live is a bubble they can adjust
 * themselves.
 */
export function bubbleSourceRect(source: Size, destination: Rect): Rect {
  const sourceWidth = positiveOr(source.width, 1);
  const sourceHeight = positiveOr(source.height, 1);
  const targetAspect =
    positiveOr(destination.width, 1) / positiveOr(destination.height, 1);
  const sourceAspect = sourceWidth / sourceHeight;

  if (sourceAspect > targetAspect) {
    // Camera is wider than the hole: keep full height, crop the sides.
    const width = sourceHeight * targetAspect;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  // Camera is taller than the hole: keep full width, crop top and bottom.
  const height = sourceWidth / targetAspect;
  return {
    x: 0,
    y: (sourceHeight - height) / 2,
    width: sourceWidth,
    height,
  };
}

/**
 * The rounding to apply to the bubble's box, in pixels.
 *
 * A circle is the degenerate rounded rectangle whose radius is half its shorter
 * side, so both shapes go through one path in the renderer and there is no
 * `if (shape === "circle")` in the drawing code.
 */
export function bubbleCornerRadius(rect: Rect, shape: BubbleShape): number {
  const shorter = Math.min(rect.width, rect.height);
  return shape === "circle"
    ? shorter / 2
    : Math.round(shorter * ROUNDED_CORNER_FRACTION);
}
