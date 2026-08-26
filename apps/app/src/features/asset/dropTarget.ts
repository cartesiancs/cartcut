/**
 * Where a drop on the timeline lands: the moment, and the row.
 *
 * This lived inline inside `elementTimelineCanvas._handleDrop`, which is the
 * same smell the canvas already fixed once for clip dragging by extracting
 * `timeline/dragResolve.ts` — the arithmetic that decides where something ends
 * up is exactly the part worth testing, and it was the part with no test.
 *
 * Pulling it out also gives the two drop paths one answer. An asset dragged out
 * of the panel and a file dragged in from the OS have nothing in common up to
 * this point, and every reason to land in exactly the same place once they get
 * here.
 */

import { snapMsToFrame } from "../timeline/frames";
import { timeAtX, trackAtY, type TimelineLayout } from "../timeline/layout";

export type DropTarget = {
  /** Timeline ms, never negative, always on a frame boundary. */
  startMs: number;
  /** The row under the pointer, or null for the ruler gutter and the gaps. */
  trackId: string | null;
};

/**
 * Read a drop's canvas-local coordinates as a placement.
 *
 * Quantised to a frame like every other edit, so a dropped clip is already
 * aligned with whatever it is about to be cut against — an unsnapped drop
 * leaves a sub-frame sliver that only shows up on export.
 */
export function dropTargetAt(
  layout: TimelineLayout,
  x: number,
  y: number,
  range: number,
  hScroll: number,
  fps: number,
): DropTarget {
  // Clamped before snapping: `snapMsToFrame` rounds, so a drop a few pixels
  // left of zero would otherwise snap to a negative frame rather than to zero.
  const raw = Math.max(0, timeAtX(x, range, hScroll));

  return {
    startMs: Math.max(0, snapMsToFrame(raw, fps)),
    trackId: trackAtY(layout, y),
  };
}
