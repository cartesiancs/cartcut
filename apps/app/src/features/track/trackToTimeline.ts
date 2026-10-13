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
import {
  isDynamicElement,
  spanOf,
  timelineTimeAt,
  type DynamicElement,
} from "../timeline/geometry";
import {
  frameDurationMs,
  frameToMs,
  msToFrameCeil,
  snapMsToFrame,
  sourceTimeAtFrame,
} from "../timeline/frames";
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
  const out: PathSample[] = [];

  for (const sample of samples) {
    const tMs = snapMsToFrame(
      timelineTimeAt(element, sample.sourceMs),
      input.fps,
    );
    if (tMs < span.start || tMs > span.end) {
      continue;
    }

    out.push({ tMs, ...projectPointAt(input, element, tMs, sample) });
  }

  return out;
}

/**
 * A point in the decoded frame, in project pixels, as the clip draws it at
 * `tMs`.
 *
 * One memo per call, not per path: `worldMatrixOf` caches by element id and
 * the cursor moves every sample, so a memo shared across samples would hand
 * frame 400 the matrix it computed for frame 0. That is exactly the bug a
 * parented, moving clip would show and a static one would not.
 */
function projectPointAt(
  input: ProjectPathInput,
  element: TimelineElement,
  tMs: number,
  point: { x: number; y: number },
): { x: number; y: number } {
  const box = sampledBoxOf(element, tMs);
  const local = {
    x: (point.x / input.frameWidth) * box.width,
    y: (point.y / input.frameHeight) * box.height,
  };
  return applyPoint(
    worldMatrixOf(input.elements, input.clipId, tMs, createMemo()),
    local,
  );
}

/**
 * How far short of a frame's start the instant shown must be for that frame to
 * count as not yet on show, in source ms.
 *
 * Only matters where the frame centre `sourceTimeAtFrame` asks for lands
 * exactly on a source frame's start: 60fps footage in a 30fps project on every
 * frame, 24 in 60 on every fifth. Which neighbour shows there is the decoder's
 * microsecond rounding, and measured end to end (`tests/e2e/specs/
 * stabilize.spec.ts`, 60 in 30) it is the earlier one on two frames in three
 * and the later on the third, the same pattern `tests/e2e/FINDINGS.md` reports
 * for boundary seeks. So a tie counts as the earlier frame, which is right
 * where the decoder is right most often; the third frame is a decoder fault no
 * prediction can follow. A microsecond is far above the doubles' noise here
 * and far below any frame.
 */
export const SHOWN_FRAME_TIE_MS = 1e-3;

export type DisplayedPathInput = ProjectPathInput & {
  /**
   * One source frame, in source ms, as the harvest measured it
   * (`frameSource.ts#nextFrameGap`). Absent for a path tracked before the
   * harvest reported it, which falls back to the samples' own spacing.
   */
  sourceFrameMs?: number | null;
};

/**
 * Tracked samples as a path with one point per project frame, each at the
 * source frame that frame actually shows.
 *
 * `toProjectPath` places each sample on the project frame nearest its own
 * time, and a null built from it interpolates linearly in between. The
 * picture does not: at project frame `k` the clip shows the source frame
 * under `sourceTimeAtFrame` and holds it. For 30fps footage in a 60fps
 * project that left the null half a step ahead of the picture on every other
 * frame, which a match-move hides and a stabilized frame turns into judder.
 *
 * So the question asked per project frame is which source frame is on show:
 *
 * - The latest sample at or before the instant shown, advanced by whole source
 *   frames up to that instant. When that is the sample itself, its value is
 *   the answer exactly. That is every frame for footage at or below the
 *   project's rate, where the harvest keeps every source frame.
 * - Otherwise the frame on show is one the harvest's stride skipped (faster
 *   footage) or the compositor dropped, and its position is interpolated in
 *   source time at that frame's own time between the samples either side.
 *   The error is the curve's bend over one gap, not a frame of motion.
 * - Without `sourceFrameMs`, the samples' median spacing stands in for it: a
 *   sample is held, and a gap wider than one and a half spacings is
 *   interpolated at the instant shown.
 *
 * Frames before the first sample and after the last one's frame ends are left
 * out, so the path covers what was tracked and nothing else. Pure and
 * DOM-free.
 */
export function toDisplayedPath(
  samples: readonly TrackSample[],
  input: DisplayedPathInput,
): PathSample[] {
  const element = input.elements[input.clipId];
  if (element == null || !isDynamicElement(element)) {
    return [];
  }
  if (!(input.frameWidth > 0) || !(input.frameHeight > 0)) {
    return [];
  }

  const ordered = orderedSamples(samples);
  if (ordered.length === 0) {
    return [];
  }

  const frameMs =
    Number.isFinite(input.sourceFrameMs) && (input.sourceFrameMs as number) > 0
      ? (input.sourceFrameMs as number)
      : null;
  const spacing = medianSpacing(ordered);
  // How long the last sample stays on show. A lone sample with nothing to
  // measure against is given one project frame, as `trackedEndMs` gives it.
  const lastHeldMs = frameMs ?? spacing ?? frameDurationMs(input.fps);

  const span = spanOf(element);
  const out: PathSample[] = [];
  let latest = 0;

  for (
    let k = msToFrameCeil(span.start, input.fps);
    frameToMs(k, input.fps) < span.end;
    k++
  ) {
    const tMs = frameToMs(k, input.fps);
    const reach = sourceTimeAtFrame(element as DynamicElement, tMs, input.fps) -
      SHOWN_FRAME_TIE_MS;

    if (reach < ordered[0].sourceMs) {
      continue;
    }
    while (latest + 1 < ordered.length && ordered[latest + 1].sourceMs <= reach) {
      latest++;
    }

    const held = ordered[latest];
    const next = ordered[latest + 1] ?? null;
    const shown = shownPoint(held, next, reach, frameMs, spacing, lastHeldMs);
    if (shown == null) {
      break;
    }

    out.push({ tMs, ...projectPointAt(input, element, tMs, shown) });
  }

  return out;
}

/**
 * The picture's point at one project frame, from the samples either side of
 * the instant it shows. `null` once that instant is past the last sample's
 * frame.
 */
function shownPoint(
  held: TrackSample,
  next: TrackSample | null,
  reach: number,
  frameMs: number | null,
  spacing: number | null,
  lastHeldMs: number,
): { x: number; y: number } | null {
  if (frameMs != null) {
    // Whole source frames from the held sample to the instant shown. The
    // nudge keeps `33.33.../16.66...` from flooring to 1 short of 2.
    const steps = Math.floor((reach - held.sourceMs) / frameMs + 1e-9);
    if (steps === 0) {
      return held;
    }
    if (next == null) {
      return null;
    }
    return between(held, next, held.sourceMs + steps * frameMs);
  }

  if (next == null) {
    return reach - held.sourceMs < lastHeldMs ? held : null;
  }
  const gap = next.sourceMs - held.sourceMs;
  if (spacing != null && gap > 1.5 * spacing) {
    return between(held, next, reach + SHOWN_FRAME_TIE_MS);
  }
  return held;
}

/** Linear in source time, clamped to the two samples. */
function between(
  a: TrackSample,
  b: TrackSample,
  sourceMs: number,
): { x: number; y: number } {
  const span = b.sourceMs - a.sourceMs;
  const f = span > 0 ? Math.min(1, Math.max(0, (sourceMs - a.sourceMs) / span)) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Finite, ascending in source time, one per instant (the later wins). */
function orderedSamples(samples: readonly TrackSample[]): TrackSample[] {
  const usable = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.sourceMs) &&
        Number.isFinite(sample.x) &&
        Number.isFinite(sample.y),
    )
    .map((sample, index) => ({ sample, index }));
  usable.sort((a, b) => a.sample.sourceMs - b.sample.sourceMs || a.index - b.index);

  const out: TrackSample[] = [];
  for (const { sample } of usable) {
    if (out.length > 0 && out[out.length - 1].sourceMs === sample.sourceMs) {
      out[out.length - 1] = sample;
      continue;
    }
    out.push(sample);
  }
  return out;
}

/** The median gap between consecutive samples, or `null` for fewer than two. */
function medianSpacing(ordered: readonly TrackSample[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(ordered[i].sourceMs - ordered[i - 1].sourceMs);
  }
  if (gaps.length === 0) {
    return null;
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
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

/**
 * Where the null made from a tracked path ends on the timeline, exclusive.
 *
 * Where the picture the last sample was measured on stops being shown, which
 * is the source's next frame and so one sample spacing on: a project frame for
 * footage at or above the project's rate, two for 30fps footage in a 60fps
 * project. Never less than one project frame, which is all a single sample
 * has to go on. Ending on the last sample itself would leave its keyframe on
 * the bar's open end. Snapped to the frame grid, because the sum of two
 * snapped times is not one (`12966.67 + 33.33` is `12999.999999999998`), then
 * clamped to the clip, so tracking a whole clip gives a bar exactly as long as
 * the clip. `null` for an empty path.
 */
export function trackedEndMs(
  path: readonly PathSample[],
  element: TimelineElement,
  fps: number,
): number | null {
  const times = path
    .map((sample) => sample.tMs)
    .filter((tMs) => Number.isFinite(tMs))
    .sort((a, b) => a - b);
  if (times.length === 0) {
    return null;
  }

  const lastMs = times[times.length - 1];
  let heldMs = frameDurationMs(fps);
  for (let i = times.length - 2; i >= 0; i--) {
    if (times[i] < lastMs) {
      heldMs = Math.max(heldMs, lastMs - times[i]);
      break;
    }
  }

  const span = spanOf(element);
  return Math.max(
    lastMs,
    Math.min(span.end, snapMsToFrame(lastMs + heldMs, fps)),
  );
}
