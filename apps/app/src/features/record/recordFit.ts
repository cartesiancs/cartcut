/**
 * Putting a screen recording into a project frame.
 *
 * A capture is the display's own pixel count and a project frame is whatever the
 * user set, so the two almost never agree. `buildVideo` gives every video its
 * native size at (0,0), deliberately, and its comment says why, which for a
 * 3024x1964 capture in a 1920x1080 frame puts about a quarter of the picture on
 * screen anchored top-left. This is the recording-only correction, applied after
 * placement so nothing about an ordinary file drop moves.
 *
 * ## Two boxes, and why the zoom is measured against the larger one
 *
 * **`cover`** fills the frame and overflows on one axis. It is not what the clip
 * is set to; it is the *unit of zoom*. Measuring zoom against it makes `z = 1`
 * mean "the picture exactly fills the frame", which is the only value at which
 * the pan clamp has anything to say, and it makes the whole mapping from a camera
 * to a clip box two lines with no special case for the resting pose.
 *
 * **`base`** is where the clip actually sits between zooms: contained, so the
 * entire screen is visible, inset by `padding` so it reads as a screen on a
 * background rather than a video that happens to be there. Expressed as a
 * fraction `k` of `cover`, which is what lets one formula produce both.
 *
 * Contain rather than cover was a choice: a 16:10 laptop panel in a 16:9 project
 * cannot be cropped to fit without losing the menu bar or the Dock, and losing
 * either is worse than an inch of background.
 *
 * Pure arithmetic, no store, no DOM.
 */

export type Size = { width: number; height: number };

export type Box = { width: number; height: number; x: number; y: number };

/** Inset of the contained pose, as a fraction of the frame. */
export const DEFAULT_RECORD_PADDING = 0.05;

export type RecordFit = {
  /** Fills the frame, overflowing one axis. The unit of zoom. */
  cover: Size;
  /**
   * The resting pose, as a fraction of `cover`. Always in `(0, 1]`.
   *
   * `1` exactly when the source and the frame share an aspect *and* there is no
   * padding, which is the only case where contain and cover agree.
   */
  base: number;
};

/**
 * `cover` and `base` for a capture in a frame.
 *
 * Both degenerate inputs answer a unit fit rather than throwing: this runs on a
 * probe result, and a zero-width capture should land the clip unchanged, not
 * abort an import the user cannot retry without recording again.
 */
export function recordFit(
  source: Size,
  frame: Size,
  padding = DEFAULT_RECORD_PADDING,
): RecordFit {
  const usable =
    source.width > 0 && source.height > 0 && frame.width > 0 && frame.height > 0;

  if (!usable) {
    return { cover: { width: frame.width, height: frame.height }, base: 1 };
  }

  const byWidth = frame.width / source.width;
  const byHeight = frame.height / source.height;

  const coverScale = Math.max(byWidth, byHeight);
  const containScale = Math.min(byWidth, byHeight);

  const inset = 1 - clampPadding(padding);

  return {
    cover: {
      width: source.width * coverScale,
      height: source.height * coverScale,
    },
    // `containScale / coverScale` is the aspect mismatch and `inset` is the
    // margin; multiplying them is the whole of it.
    base: (containScale / coverScale) * inset,
  };
}

/**
 * Half the frame is the most that can be given away.
 *
 * Not taste: at `padding >= 1` the box has no area and the clip is invisible with
 * nothing on screen to explain it.
 */
function clampPadding(padding: number): number {
  if (!Number.isFinite(padding) || padding <= 0) {
    return 0;
  }
  return Math.min(0.5, padding);
}

/**
 * The clip's box at zoom `z`, aimed at `(u, v)`.
 *
 * The one formula this module exists to state, and the same one at rest and at
 * full zoom:
 *
 *     w = cover.width * z        x = frame.width / 2 - u * w
 *     h = cover.height * z       y = frame.height / 2 - v * h
 *
 * `(u, v)` is the point of the *source* to put at the centre of the frame, as a
 * fraction of the capture. At rest `z = base` and `u = v = 0.5`, which the same
 * lines produce: `x = W/2 - w/2`, the centred contained box.
 *
 * This is `zoomFocus.test.ts`'s geometry, whose header derives why holding a
 * point means `x(t) = C - u*w(t)` and why that being *affine in w* is what makes
 * a `size` plus `position` pair exact at every sample rather than only at its
 * anchors.
 */
export function recordBox(
  fit: RecordFit,
  frame: Size,
  z: number,
  u = 0.5,
  v = 0.5,
): Box {
  const width = fit.cover.width * z;
  const height = fit.cover.height * z;

  return {
    width,
    height,
    x: frame.width / 2 - u * width,
    y: frame.height / 2 - v * height,
  };
}

/**
 * Keep the frame covered: the centre a zoom may actually aim at.
 *
 * **Not `zoomPlan.ts#clampCenter`.** That one derives the visible box as
 * `frame / scale`, which assumes the visible window has the *capture's* aspect.
 * Under a cover fit it has the *frame's*, and the two differ by exactly the
 * amount being cropped. Getting it wrong is invisible in a node suite where
 * every fixture shares one aspect, and shows in the app as background creeping
 * in at the edge of a zoom.
 *
 * Expressed in source fractions because that is what `recordBox` takes. At
 * `z = 1` on a 16:10 capture in a 16:9 frame this forces `u = 0.5` and leaves
 * `v` free across roughly 0.43 to 0.57, which is right: there is nothing to pan
 * to horizontally and a little to pan to vertically.
 *
 * Below `z = 1` the picture does not cover the frame at all and there is no
 * constraint to apply, so the bounds cross and both collapse to the centre.
 */
export function clampAim(
  fit: RecordFit,
  frame: Size,
  z: number,
  u: number,
  v: number,
): { u: number; v: number } {
  return {
    u: clampAxis(u, frame.width, fit.cover.width * z),
    v: clampAxis(v, frame.height, fit.cover.height * z),
  };
}

function clampAxis(value: number, frameExtent: number, boxExtent: number): number {
  if (!Number.isFinite(value) || boxExtent <= 0) {
    return 0.5;
  }
  const half = frameExtent / (2 * boxExtent);
  if (half >= 0.5) {
    // The box is no wider than the frame on this axis. Nothing to aim at.
    return 0.5;
  }
  return Math.min(1 - half, Math.max(half, value));
}

/**
 * The smallest zoom worth taking, in `cover` units.
 *
 * Always `1`, and named rather than inlined because the *reason* is the thing
 * worth keeping: below it the picture does not fill the frame, so panning would
 * slide it around inside its own padding with background on the leading edge.
 * A zoom that means anything goes at least to full bleed.
 */
export const Z_COVER = 1;
