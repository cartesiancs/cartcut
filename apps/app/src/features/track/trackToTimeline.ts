/**
 * From what the tracker measured to what the timeline stores.
 *
 * Two conversions, and both are easy to get subtly wrong in a way that only
 * shows on a project that is not the one you tested on.
 *
 * ## Space
 *
 * The tracker works in the pixels of a decoded video frame. The null object
 * lives in project pixels. In between sits the clip, which has its own box, may
 * be scaled or rotated, may have an animated `size`, and may be parented to
 * another null that is itself moving. So the chain is:
 *
 * ```
 *   source px  ──÷ video size──▶  0..1  ──× sampled box──▶  element-local px
 *              ──worldMatrixOf──▶  project px
 * ```
 *
 * The normalised step in the middle is what makes the working resolution
 * irrelevant: `frameSource.ts` decodes at whatever size is cheap, and dividing
 * by that same size cancels it. Nothing downstream needs to know the tracker
 * looked at a 960-pixel-wide copy of a 3600-pixel frame.
 *
 * `renderer/video.ts` draws the frame as
 * `drawImage(video, 0, 0, element.width, element.height)` — stretched to fill
 * the box, no letterbox — so "0..1 of the source" and "0..1 of the box" are the
 * same fraction. If that ever gains a fit mode, this is the function that has
 * to learn about it.
 *
 * The box comes from `sampledBoxOf`, never from `element.width`. CLAUDE.md is
 * blunt about why: a clip with its `size` track switched on has a box that
 * changes under the cursor, and a reader left on the static field is the
 * `previewCanvas.collisionCheck` bug again — the picture in one place, and
 * something else's idea of it in another.
 *
 * ## Time
 *
 * The tracker timestamps the **source file**; the timeline speaks absolute
 * timeline milliseconds. `timelineTimeAt` is the conversion, and it already
 * carries the trim offset and the speed — the same function the caption
 * placement uses for the same reason. Then the result is snapped to the frame
 * grid, because a keyframe between two frame instants is a value no frame is
 * ever sampled at.
 *
 * Pure and DOM-free.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { isDynamicElement, spanOf, timelineTimeAt } from "../timeline/geometry";
import { snapMsToFrame } from "../timeline/frames";
import {
  applyPoint,
  createMemo,
  sampledBoxOf,
  worldMatrixOf,
} from "../timeline/transform";
import type { PathSample } from "./simplify";
import type { TrackSample } from "./tracker";

export type ProjectPathInput = {
  /** Every element, so a parented clip's chain can be composed. */
  elements: Timeline;
  /** The clip the feature was tracked in. */
  clipId: string;
  /** Size of the frames the tracker was given, in their own pixels. */
  frameWidth: number;
  frameHeight: number;
  fps: number;
};

/**
 * Tracked samples as a path in project space, on the frame grid.
 *
 * Samples that fall outside the clip's own span are dropped rather than
 * clamped. They can only come from a decoder that overran the range it was
 * asked for, and a keyframe past the clip is one that never plays — writing it
 * would report an edit the user cannot see, which is the same argument
 * `agent/commands/animation.ts` makes for refusing an out-of-clip time.
 */
export function toProjectPath(
  samples: readonly TrackSample[],
  input: ProjectPathInput,
): PathSample[] {
  const element = input.elements[input.clipId];
  if (element == null || !isDynamicElement(element)) {
    return [];
  }
  if (!(input.frameWidth > 0) || !(input.frameHeight > 0)) {
    return [];
  }

  const span = spanOf(element);
  // One memo per call, not per sample: `worldMatrixOf` caches by element id and
  // the cursor moves every sample, so a memo shared across samples would hand
  // frame 400 the matrix it computed for frame 0. That is exactly the bug a
  // parented, moving clip would show and a static one would not.
  const out: PathSample[] = [];

  for (const sample of samples) {
    const tMs = snapMsToFrame(
      timelineTimeAt(element, sample.sourceMs),
      input.fps,
    );
    if (tMs < span.start || tMs > span.end) {
      continue;
    }

    const box = sampledBoxOf(element, tMs);
    const local = {
      x: (sample.x / input.frameWidth) * box.width,
      y: (sample.y / input.frameHeight) * box.height,
    };

    const world = applyPoint(
      worldMatrixOf(input.elements, input.clipId, tMs, createMemo()),
      local,
    );

    out.push({ tMs, x: world.x, y: world.y });
  }

  return out;
}

/**
 * Where a point on the preview lands in the decoded frame.
 *
 * The inverse of the space half of `toProjectPath`, for the panel: the user
 * clicks a canvas showing the frame at some display scale, and the tracker
 * needs the pixel in the image. Scalar rather than matrix because the panel
 * draws the frame square-on and unrotated — it is showing the *source*, not the
 * composite, which is the whole reason the panel has its own canvas.
 */
export function canvasToFramePoint(
  point: { x: number; y: number },
  canvas: { width: number; height: number },
  frame: { width: number; height: number },
): { x: number; y: number } {
  if (!(canvas.width > 0) || !(canvas.height > 0)) {
    return { x: 0, y: 0 };
  }
  return {
    x: (point.x / canvas.width) * frame.width,
    y: (point.y / canvas.height) * frame.height,
  };
}

/** The span of the clip a track may cover, in timeline ms. */
export function trackableSpan(
  element: TimelineElement,
): { start: number; end: number } {
  return spanOf(element);
}
