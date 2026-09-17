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

import type { TimelineElement } from "../../@types/timeline";
import { createTextElement } from "../element/textElement";
import { removeRanges, type TimeRange } from "../timeline/clipOps";
import { spanStart } from "../timeline/geometry";
import { placeNewElement } from "../timeline/placement";
import { shiftSpan } from "../timeline/rippleMap";
import type { TimelineDocument } from "../timeline/tracks";
import type { CaptionRow } from "./rows";
import { captionToTimeline } from "./timing";

/** One caption's ids: the element, and the track it makes if it needs one. */
export type CaptionIds = { element: string; track: string };

/** One chosen clip's part of a commit. */
export type CaptionCommitClip = {
  key: string;
  /** Timeline ms, already snapped, clamped and merged by `cuts.ts#planCuts`. */
  cuts: TimeRange[];
  /** **Two per cut**, drawn in order. See the header. */
  splits: string[];
};

export type CaptionCommit = {
  /** Every chosen clip, cut or not. A row whose clip is absent is not placed. */
  clips: CaptionCommitClip[];
  /** Source ms, from `rows.ts#captionRows`, each carrying its clip's key. */
  rows: CaptionRow[];
  ids: {
    /** One per row, in order. */
    captions: CaptionIds[];
  };
};

/**
 * Cut, then place.
 *
 * Returns `doc` **by identity** when there is nothing to do, so
 * `withCheckpoint` records no undo step and the store notifies nobody. That is
 * the convention `features/timeline/` states, and here it is what stops a
 * Complate on an untouched transcript from costing the user an undo press.
 *
 * With several clips, each is cut with its own list, **latest first**. A cut
 * ripples only what comes after it on its own track, so cutting the later clip
 * first leaves the earlier one where it was and no list needs shifting to
 * account for another. Each row is then carried across every cut on its own
 * clip's track, and the rows are placed in reveal order, so the text track each
 * one lands on is the one the reveal gives it.
 */
export function applyCaptionCommit(
  doc: TimelineDocument,
  plan: CaptionCommit,
): TimelineDocument {
  if (plan.clips.every((clip) => clip.cuts.length === 0) && plan.rows.length === 0) {
    return doc;
  }

  // Read before cutting. See the header: the original id may not survive.
  const sources = new Map<string, TimelineElement | undefined>(
    plan.clips.map((clip) => [clip.key, doc.elements[clip.key]]),
  );

  const lanes = new Map<string, TimeRange[]>();
  for (const clip of plan.clips) {
    const trackId = sources.get(clip.key)?.trackId;
    if (trackId != null) {
      lanes.set(trackId, [...(lanes.get(trackId) ?? []), ...clip.cuts]);
    }
  }

  let next = doc;

  const latestFirst = plan.clips
    .filter((clip) => clip.cuts.length > 0 && sources.get(clip.key) != null)
    .sort(
      (a, b) => spanStart(sources.get(b.key)!) - spanStart(sources.get(a.key)!),
    );

  for (const clip of latestFirst) {
    const pool = clip.splits;
    let drawn = 0;
    next = removeRanges(
      next,
      clip.key,
      clip.cuts,
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

  type Placement = {
    row: CaptionRow;
    ids: CaptionIds;
    source: TimelineElement | undefined;
    cuts: TimeRange[];
    at: number;
  };
  const placed: Placement[] = [];
  plan.rows.forEach((row, index) => {
    const ids = plan.ids.captions[index];
    if (ids == null || (row.sourceKey != null && !sources.has(row.sourceKey))) {
      return;
    }
    const source = row.sourceKey == null ? undefined : sources.get(row.sourceKey);
    const trackId = source?.trackId;
    placed.push({
      row,
      ids,
      source,
      cuts: trackId == null ? [] : (lanes.get(trackId) ?? []),
      at: captionToTimeline(
        { startTime: row.startTime, duration: row.duration },
        source,
      ).startTime,
    });
  });
  // Stable, so rows that start together keep their order.
  placed.sort((a, b) => a.at - b.at);

  for (const entry of placed) {
    next = placeCaptionRow(next, entry.row, entry.ids, entry.source, entry.cuts);
  }

  return next;
}

/**
 * Place one caption, mapped through its clip and carried across the cuts.
 *
 * Lifted out of the loop above so the caption session can place rows **one at a
 * time** during its reveal and reach the same document the batch reaches. Two
 * copies of this arithmetic is the thing worth avoiding: the conversion is easy
 * to get subtly wrong, and wrong here means captions a frame or two off the
 * words, which is the failure nobody reports and everybody notices.
 *
 * `cuts` is every cut on the track of the clip this caption belongs to, the
 * whole list and not the part applied so far: a caption straddling a later cut
 * has to come out shorter. `captionProjection.ts` states why the incremental
 * caller still lands where the batch does.
 *
 * Returns `doc` by identity when the cuts consumed the caption's footage, so a
 * caller can tell that nothing was placed.
 */
export function placeCaptionRow(
  doc: TimelineDocument,
  row: CaptionRow,
  ids: CaptionIds,
  source: TimelineElement | undefined,
  cuts: TimeRange[],
): TimelineDocument {
  const { sourceKey, lineId, text, startTime, duration, ...style } = row;
  const onOriginal = captionToTimeline({ startTime, duration }, source);
  const shifted = shiftSpan(
    {
      startMs: onOriginal.startTime,
      endMs: onOriginal.startTime + onOriginal.duration,
    },
    cuts,
  );

  // Null means the cuts consumed this caption's footage. Placing it anyway
  // would put words over a moment that no longer exists.
  if (shifted == null) {
    return doc;
  }

  const placedStart = shifted.startMs;
  const placedDuration = shifted.endMs - shifted.startMs;

  return placeNewElement(
    doc,
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
}
