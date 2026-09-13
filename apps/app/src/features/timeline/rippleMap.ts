/**
 * Where a time ends up once a set of ranges has been rippled out of a lane.
 *
 * `removeRanges(doc, id, cuts, ripple: true, …)` leaves the surviving footage
 * contiguous: each cut is split out and everything after it on that track slides
 * back by the cut's length. So a caller who knows the cut list can say where any
 * time went without looking at the document at all, which is what this module
 * is for.
 *
 * That matters because after the cut the original clip is **N pieces with new
 * ids**, and the one id the caller started with names only the first of them.
 * Anything holding a source-file time, a transcript above all, would otherwise
 * have to re-find which piece now covers it. The arithmetic here is the same
 * answer, reached without the search:
 *
 * > `t' = t - removedBefore(t)`, and a span also loses whatever was cut *inside*
 * > it.
 *
 * ## The one thing that makes it true
 *
 * The prediction and the edit have to be driven by the **same list**. `onFrame`
 * snapping can collapse a range onto a single frame, and `removeRanges` skips a
 * range whose clamped width is zero, so a caller that snaps after predicting
 * gets a different answer from the one the document got. Snap and normalise
 * once, then hand the same array to both.
 *
 * Order-agnostic on purpose: `normalizeRanges` returns its ranges **descending**
 * because that is what makes the cuts land in un-moved coordinates, and nothing
 * here should quietly depend on that. Disjointness is what these sums need, and
 * `normalizeRanges` is what guarantees it.
 *
 * Times are timeline milliseconds throughout. No DOM, no store: this runs under
 * `environment: "node"`.
 */

import type { TimeRange } from "./clipOps";
import { spanOf } from "./geometry";
import { overlaps } from "./overlap";
import type { TimelineDocument } from "./tracks";

/** How much of `[0, tMs)` the cuts take away. */
export function removedBefore(tMs: number, cuts: TimeRange[]): number {
  let total = 0;
  for (const cut of cuts) {
    if (cut.startMs >= tMs) {
      continue;
    }
    // `min(endMs, tMs)` is what makes a time *inside* a cut answer usefully
    // rather than being a special case: only the part of the cut before it
    // counts, so the time lands exactly on the cut's start once shifted. That
    // is where the footage resumes, which is the honest place for it.
    total += Math.min(cut.endMs, tMs) - cut.startMs;
  }
  return total;
}

/** How much of `range` the cuts take away. */
export function removedWithin(range: TimeRange, cuts: TimeRange[]): number {
  let total = 0;
  for (const cut of cuts) {
    const from = Math.max(range.startMs, cut.startMs);
    const to = Math.min(range.endMs, cut.endMs);
    if (to > from) {
      total += to - from;
    }
  }
  return total;
}

/**
 * Where a single instant ends up.
 *
 * Never negative: a cut cannot start before 0, so neither can the result.
 */
export function shiftPoint(tMs: number, cuts: TimeRange[]): number {
  return Math.max(0, tMs - removedBefore(tMs, cuts));
}

/**
 * Where a span ends up, or `null` when the cuts consumed all of it.
 *
 * The length is recomputed from what survives **inside** the span rather than
 * by shifting both edges independently. A caption straddling a cut has to come
 * out shorter, not merely earlier, and shifting the end alone would do that
 * only by accident: the end is shifted by everything removed before it, which
 * includes cuts that lie entirely *before* the span and must not shorten it.
 *
 * `null` rather than a zero-length span, because the two mean different things
 * to a caller placing an element. A zero-length caption is invisible and
 * unfindable on the timeline, which is the same reason `captionsFrom` drops an
 * empty line instead of placing it.
 */
export function shiftSpan(
  span: TimeRange,
  cuts: TimeRange[],
): TimeRange | null {
  const length = span.endMs - span.startMs - removedWithin(span, cuts);
  if (length <= 0) {
    return null;
  }
  const startMs = shiftPoint(span.startMs, cuts);
  return { startMs, endMs: startMs + length };
}

/** Total length the cuts remove. What a summary line reports. */
export function removedTotal(cuts: TimeRange[]): number {
  let total = 0;
  for (const cut of cuts) {
    total += Math.max(0, cut.endMs - cut.startMs);
  }
  return total;
}

/**
 * Clips on *other* tracks that the cuts run through.
 *
 * The ripple is lane-local by design, stated at `clipOps.ts#rippleDelete` and
 * again at `speedOps.ts`: a magnetic timeline "would be a different feature, and
 * not one this editor has anywhere else". So a detached audio twin, a music bed,
 * a title or a caption placed earlier keeps its old timing while the picture
 * under it gets shorter, and nothing repairs that.
 *
 * This is what lets a caller say so before committing, rather than leaving it to
 * be discovered on playback. **Text tracks are included**: a caption from a
 * previous pass is the single most likely thing to be sitting over the cuts, and
 * excluding it would leave the warning silent in the commonest case.
 *
 * Deliberately cheap and deliberately about *time*, not about audibility. A clip
 * that merely overlaps a cut is worth naming whether or not the user would
 * notice, for the same reason `add_subtitles` reports what is stacked over a
 * caption rather than trying to decide whether the pixels are covered.
 */
export function clipsAcrossCuts(
  doc: TimelineDocument,
  cutTrackId: string,
  cuts: TimeRange[],
): string[] {
  if (cuts.length === 0) {
    return [];
  }

  const stranded: string[] = [];
  for (const [id, element] of Object.entries(doc.elements)) {
    if (element.trackId === cutTrackId) {
      continue;
    }
    const span = spanOf(element);
    // The same half-open predicate `findPieceCovering` uses, so "overlaps a
    // cut" means one thing across the module.
    if (cuts.some((cut) => overlaps(span, { start: cut.startMs, end: cut.endMs }))) {
      stranded.push(id);
    }
  }
  return stranded;
}
