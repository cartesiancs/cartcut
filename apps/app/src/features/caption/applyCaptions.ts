/**
 * Cutting the picture and placing the captions, as one document transform.
 *
 * The panel's "Complate Edit" used to be a loop of `elementControl.addText`,
 * one store commit and one undo step per caption. That was survivable while the
 * panel only added text. It is not survivable now that the same gesture also
 * removes footage: a user pressing Cmd+Z would take back one caption and leave
 * the cuts in place, and would have to press it forty more times to get their
 * clip back. One transform, one checkpoint, one press.
 *
 * `agent/commands/text.ts#add_subtitles` already had the shape, placing many
 * captions through `placeNewElement` inside a single transform; this is that
 * with the cuts in front of it.
 *
 * ## Resolve the clip before cutting it, never after
 *
 * `removeRanges` splits the clip into pieces and **the original id does not
 * always survive**: a cut flush to the clip's left edge makes the head the
 * deleted middle, so the id the caller started with is gone and the footage
 * that remains carries a new one with a different `trim.startTime`. Reading
 * `doc.elements[sourceKey]` after the cut therefore gets `undefined` for a case
 * that is otherwise completely ordinary, and `captionToTimeline` would quietly
 * fall back to treating source times as timeline times.
 *
 * So the clip is read **first**, and every caption is mapped through the clip as
 * it was, then carried across the cuts by `timeline/rippleMap.ts`. That module's
 * parity suite is what makes the second step trustworthy: it performs the real
 * `removeRanges` and checks the prediction against where the footage measurably
 * landed, across three speeds and six shapes of cut.
 *
 * ## No ids are minted here
 *
 * Every id arrives in `ids`, because `agent/commit.ts#commit` runs the
 * transform **twice** and anything minted inside would differ between the probe
 * and the run that counts. `plan.ts` states the same rule, and had the same bug
 * this pool shape avoids: `removeRanges` mints up to *two* ids per range.
 */

import { v4 as uuidv4 } from "uuid";
import type { TimelineElement } from "../../@types/timeline";
import { createTextElement } from "../element/textElement";
import { removeRanges, type TimeRange } from "../timeline/clipOps";
import { placeNewElement } from "../timeline/placement";
import { shiftSpan } from "../timeline/rippleMap";
import type { TimelineDocument } from "../timeline/tracks";
import type { CaptionRow } from "./rows";
import { captionToTimeline } from "./timing";

/** One caption's ids: the element, and the track it makes if it needs one. */
export type CaptionIds = { element: string; track: string };

export type CaptionCommit = {
  /** The transcribed clip, or null when the captions are not mapped to one. */
  sourceKey: string | null;
  /** Timeline ms, already snapped, clamped and merged by `cuts.ts#planCuts`. */
  cuts: TimeRange[];
  /** Source ms, from `rows.ts#captionRows`. */
  rows: CaptionRow[];
  ids: {
    /** One per row, in order. */
    captions: CaptionIds[];
    /** **Two per cut**, drawn in order. See the header. */
    splits: string[];
  };
};

/** The ids a commit needs, minted outside the transform. */
export function mintCaptionIds(
  rowCount: number,
  cutCount: number,
): CaptionCommit["ids"] {
  return {
    captions: Array.from({ length: rowCount }, () => ({
      element: uuidv4(),
      track: uuidv4(),
    })),
    splits: Array.from({ length: cutCount * 2 }, () => uuidv4()),
  };
}

/**
 * Cut, then place.
 *
 * Returns `doc` **by identity** when there is nothing to do, so
 * `withCheckpoint` records no undo step and the store notifies nobody. That is
 * the convention `features/timeline/` states, and here it is what stops a
 * Complate on an untouched transcript from costing the user an undo press.
 */
export function applyCaptionCommit(
  doc: TimelineDocument,
  plan: CaptionCommit,
): TimelineDocument {
  if (plan.cuts.length === 0 && plan.rows.length === 0) {
    return doc;
  }

  // Read before cutting. See the header: the original id may not survive.
  const source: TimelineElement | undefined =
    plan.sourceKey != null ? doc.elements[plan.sourceKey] : undefined;

  let next = doc;

  if (plan.cuts.length > 0 && plan.sourceKey != null) {
    const pool = plan.ids.splits;
    let drawn = 0;
    next = removeRanges(
      next,
      plan.sourceKey,
      plan.cuts,
      // Ripple, always. A caption edit that left holes where the words were
      // would be a worse answer than not cutting at all.
      true,
      () => {
        const id = pool[drawn++];
        if (id == null) {
          // Falling back to a fresh uuid is what made `plan.ts` mint different
          // ids on `commit`'s two runs. Failing loudly beats that.
          throw new Error("applyCaptionCommit ran out of split ids.");
        }
        return id;
      },
    );
  }

  plan.rows.forEach((row, index) => {
    const ids = plan.ids.captions[index];
    if (ids == null) {
      return;
    }

    const { sourceKey, text, startTime, duration, ...style } = row;
    const onOriginal = captionToTimeline({ startTime, duration }, source);
    const shifted = shiftSpan(
      {
        startMs: onOriginal.startTime,
        endMs: onOriginal.startTime + onOriginal.duration,
      },
      plan.cuts,
    );

    // Null means the cuts consumed this caption's footage. Placing it anyway
    // would put words over a moment that no longer exists.
    if (shifted == null) {
      return;
    }

    const placedStart = shifted.startMs;
    const placedDuration = shifted.endMs - shifted.startMs;

    next = placeNewElement(
      next,
      ids.element,
      createTextElement({
        ...style,
        text,
        startTime: placedStart,
        duration: placedDuration,
      }),
      placedStart,
      ids.track,
    );
  });

  return next;
}
