/**
 * The panel's intent, as one list of timeline ranges to remove.
 *
 * Two gestures feed it and they are the same thing by the time they get here: a
 * struck-out caption line contributes its own span (`lines.ts#removedSpans`),
 * and the silence sweep contributes what `silence.ts` agreed on. Both arrive as
 * source milliseconds and leave as timeline milliseconds, snapped to the frame
 * grid and merged.
 *
 * It takes ranges rather than lines so that the panel, which owns the lines,
 * and `Control`, which owns the document and the frame rate, each hand over the
 * half they have. A `lines` parameter would have forced the whole caption list
 * through an event that only needs the times.
 *
 * ## Why one list, built once
 *
 * The list is used **twice**: `removeRanges` cuts the picture with it, and
 * `rippleMap` predicts where every surviving caption ends up. Those two answers
 * have to come from the same array or they disagree, and the disagreement is
 * silent: captions land a frame or two off, or over footage that is gone.
 *
 * The way that happens is snapping. `onFrame` can pull two edges of a short
 * range onto the same frame, and `removeRanges` skips a range whose clamped
 * width is zero (`clipOps.ts`), so a caller that snapped *after* predicting
 * would have predicted a cut that never happened. Snapping and dropping the
 * collapsed ranges here, before either consumer sees the list, is what makes
 * the prediction exact rather than nearly right.
 *
 * ## The clip is a window, the panel plays the file
 *
 * The panel's `<video>` carries the whole source file while the clip may be a
 * trimmed window into it, so a transcript can timestamp speech the clip does
 * not contain. Those times are clamped to `trim.startTime..trim.endTime` on the
 * way through, the same thing `agent/commands/read.ts#map_analysis` does to a
 * silence, rather than being converted and left to `timelineTimeAt` to place
 * somewhere before the clip starts.
 */

import type { TimelineElement } from "../../@types/timeline";
import { normalizeRanges, type TimeRange } from "../timeline/clipOps";
import {
  isDynamicElement,
  spanOf,
  timelineTimeAt,
} from "../timeline/geometry";
import { removedTotal } from "../timeline/rippleMap";

export type CutPlan = {
  /** Timeline ms, snapped, merged and clamped to the clip. Descending. */
  cuts: TimeRange[];
  /** What the cuts add up to, for the panel's summary line. */
  removedMs: number;
  /**
   * The cuts leave no footage at all.
   *
   * Worth its own field because `removeRanges` would happily ripple the clip
   * out of existence, taking every caption's anchor with it, and the user would
   * see the panel close onto an empty track. The caller refuses instead.
   */
  coversWholeClip: boolean;
};

export const EMPTY_CUT_PLAN: CutPlan = {
  cuts: [],
  removedMs: 0,
  coversWholeClip: false,
};

/**
 * The clip's window into its source file, in source ms.
 *
 * What `silence.ts#wordGaps` needs for its bounds, and the clamp every cut
 * passes through. A clip that is not dynamic has no source window, and neither
 * has one that is not there.
 */
export function sourceWindowOf(
  source: TimelineElement | undefined,
): TimeRange | null {
  if (source == null || !isDynamicElement(source)) {
    return null;
  }
  return {
    startMs: source.trim.startTime,
    endMs: source.trim.endTime,
  };
}

/**
 * Build the cut list.
 *
 * `sourceRanges` are source-file milliseconds, in any order and possibly
 * overlapping; merging is this function's job.
 *
 * `snap` puts a time on the project's frame grid. It is a parameter rather than
 * an import because this module stays free of the stores, the rule
 * `features/timeline/` and `features/animation/` both keep so they can run
 * under `environment: "node"`.
 */
export function planCuts(
  sourceRanges: TimeRange[],
  source: TimelineElement | undefined,
  snap: (ms: number) => number = (ms) => ms,
): CutPlan {
  const window = sourceWindowOf(source);
  if (window == null || source == null || !isDynamicElement(source)) {
    return EMPTY_CUT_PLAN;
  }

  const span = spanOf(source);
  const cuts: TimeRange[] = [];

  for (const range of sourceRanges) {
    // Clamp in source ms first: a caption for speech the clip trimmed away has
    // nothing to cut, and converting it would put it outside the clip anyway.
    const fromSource = Math.max(range.startMs, window.startMs);
    const toSource = Math.min(range.endMs, window.endMs);
    if (toSource <= fromSource) {
      continue;
    }

    // Snapped, then clamped again: a snap can push an edge a fraction of a
    // frame past the clip, and a range wider than the clip would make
    // `removedTotal` overstate what the edit actually removes.
    const startMs = Math.max(span.start, snap(timelineTimeAt(source, fromSource)));
    const endMs = Math.min(span.end, snap(timelineTimeAt(source, toSource)));
    if (endMs <= startMs) {
      continue;
    }

    cuts.push({ startMs, endMs });
  }

  const merged = normalizeRanges(cuts);
  const removedMs = removedTotal(merged);

  return {
    cuts: merged,
    removedMs,
    // Floating point: `spanLength` divides by speed, so an exact equality here
    // would miss the case it exists to catch.
    coversWholeClip: merged.length > 0 && removedMs >= span.length - 0.5,
  };
}
