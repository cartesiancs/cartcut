/**
 * Where a clip's keyframe diamonds go.
 *
 * Deliberately *not* part of `TimelineLayout`. The markers are display-only —
 * they take no part in hit-testing — and keeping them out of the object
 * `hitTest` walks makes that structural rather than merely tested: there is no
 * marker data in there for a press to land on, however the hit-test changes
 * later. It also keeps `layoutTimeline`, which runs on every pointer move,
 * from doing a union-and-sort per clip for something only the painter needs.
 *
 * Keyframe times are stored relative to `element.startTime` in *timeline*
 * milliseconds. `ClipRect.x` is already the element's start in screen pixels,
 * so a marker sits at `rect.x + msToPxSigned(t, range)` — no scroll term, and
 * no speed term either: a 2x clip's keyframe at t=1000 lands one second of
 * timeline along, which is where it plays.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../@types/timeline";
import { msToPxSigned, spanLength } from "./geometry";
import type { ClipRect } from "./layout";

/** Height of the strip along the bottom of a clip that holds the diamonds. */
export const KEYFRAME_LANE_PX = 8;
/** Corner-to-corner size of one diamond. */
export const KEYFRAME_SIZE_PX = 7;
/** Below this a lane would take a clip's whole height; draw nothing. */
export const KEYFRAME_MIN_CLIP_H = 16;
/**
 * Two markers closer than this merge into one.
 *
 * A diamond is 3.5px either side of centre, so anything nearer overlaps into an
 * unreadable smear — which is what a track with a keyframe every frame looks
 * like when the timeline is zoomed out.
 */
export const KEYFRAME_MIN_SPACING_PX = 5;
/**
 * Hard cap on markers drawn for one clip.
 *
 * The spacing rule already bounds this at `rect.w / 5`; the cap is what stops a
 * pathological `range` from making that number enormous.
 */
export const MAX_MARKERS_PER_CLIP = 512;

export type KeyframeMarker = {
  /** Centre x, in canvas pixels. */
  x: number;
  /** Time relative to `element.startTime`, in timeline ms. */
  tMs: number;
  /** How many keyframes collapsed into this marker. `1` is the common case. */
  count: number;
};

export type KeyframeLane = {
  top: number;
  height: number;
  centerY: number;
};

/** Whether a property is animated and has something to show. */
function isLive(element: TimelineElement, property: AnimatableProperty): boolean {
  const track = (element as any).animation?.[property];
  if (track == null || typeof track !== "object" || track.isActivate !== true) {
    return false;
  }
  const x = Array.isArray(track.x) ? track.x : [];
  const y = Array.isArray(track.y) ? track.y : [];
  return x.length > 0 || y.length > 0;
}

/**
 * Every instant this element has a keyframe at, across all live properties.
 *
 * The union is what makes one lane work instead of four: the user cares that
 * *something* is keyed at 1.2s, and which property it was is the curve editor's
 * job to show.
 *
 * `animatableProperties` is the gate rather than a bare `in` check, so a shape
 * contributes only its opacity track and gif and audio contribute nothing —
 * they carry no `animation` block at all.
 */
export function keyframeTimes(element: TimelineElement): number[] {
  const times: number[] = [];

  for (const property of animatableProperties(element)) {
    if (!isLive(element, property)) {
      continue;
    }
    const track = (element as any).animation[property];
    for (const lane of ["x", "y"]) {
      const list = Array.isArray(track[lane]) ? track[lane] : [];
      for (const keyframe of list) {
        const t = keyframe?.p?.[0];
        if (typeof t === "number" && Number.isFinite(t)) {
          times.push(t);
        }
      }
    }
  }

  times.sort((a, b) => a - b);
  return times;
}

/**
 * The strip a clip's diamonds occupy, or `null` if it should have none.
 *
 * The lane sits along the bottom because that is the only band nothing else has
 * a claim on: the label owns the top ~16px and the filmstrip the middle. A
 * video's waveform also ends up here, and `drawWaveform` takes an inset to make
 * room — but only when this returns a lane, so a clip with no keyframes keeps
 * every pixel it had.
 */
export function keyframeLane(
  rect: ClipRect,
  element: TimelineElement,
  range?: number,
): KeyframeLane | null {
  if (rect.h < KEYFRAME_MIN_CLIP_H) {
    return null;
  }
  if (keyframeTimes(element).length === 0) {
    return null;
  }
  // Having keyframes is not the same as having any to *draw*. A trim that
  // pushes them all outside the clip leaves the times in place — so they come
  // back if the edge is dragged out again — but nothing to mark. Without this
  // the clip kept an 8px dead band with the waveform squeezed up into it and
  // no diamonds in it.
  if (
    range != null &&
    planKeyframeMarkers({ element, rect, range }).length === 0
  ) {
    return null;
  }
  const top = rect.y + rect.h - KEYFRAME_LANE_PX;
  return {
    top,
    height: KEYFRAME_LANE_PX,
    centerY: top + KEYFRAME_LANE_PX / 2,
  };
}

/**
 * Place the diamonds for one clip.
 *
 * A single pass over the sorted times: markers closer together than
 * `minSpacingPx` collapse into the earliest of them, which keeps the count
 * bounded by the clip's width no matter how many keyframes the element carries.
 * Breaking ties toward the earlier time matches how the sampler resolves them.
 */
export function planKeyframeMarkers(input: {
  element: TimelineElement;
  rect: ClipRect;
  range: number;
  minSpacingPx?: number;
}): KeyframeMarker[] {
  const { element, rect, range } = input;
  const minSpacing = input.minSpacingPx ?? KEYFRAME_MIN_SPACING_PX;
  const times = keyframeTimes(element);
  if (times.length === 0) {
    return [];
  }

  // A trim can leave keyframes outside the visible window — they are kept, so
  // dragging the edge back out restores them, but they have nowhere to draw.
  const span = spanLength(element);
  // Half a diamond of tolerance, so one sitting exactly on the clip's end still
  // shows the half of itself that falls inside.
  const overhang = KEYFRAME_SIZE_PX / 2;
  const minX = rect.x - overhang;
  const maxX = rect.x + rect.w + overhang;
  const markers: KeyframeMarker[] = [];

  for (const tMs of times) {
    if (tMs < 0 || tMs > span) {
      continue;
    }

    const x = rect.x + msToPxSigned(tMs, range);
    // Anything outside the clip's own box is cut away by the clip path, so
    // planning it is pure waste — and on a long clip zoomed in, that waste is
    // thousands of markers per repaint.
    if (x < minX) {
      continue;
    }
    if (x > maxX) {
      break;
    }
    const previous = markers[markers.length - 1];
    if (previous != null && x - previous.x < minSpacing) {
      previous.count++;
      continue;
    }
    if (markers.length >= MAX_MARKERS_PER_CLIP) {
      break;
    }
    markers.push({ x, tMs, count: 1 });
  }

  return markers;
}
