/**
 * Cues onto the timeline.
 *
 * Deliberately thin. `applyCaptionCommit` already places many captions in one
 * document transform, maps each through its clip's trim and speed, and is
 * backed by `rippleMap.ts`'s parity suite; an importer that placed elements
 * itself would be a second copy of arithmetic that is easy to get subtly wrong,
 * and wrong here means captions a frame or two off the words.
 *
 * So this module does two things: turn cues into `CaptionRow`s, and call that
 * function with **no cuts**. Zero cuts makes `shiftSpan` the identity, which
 * leaves `captionToTimeline` as the only conversion in the path.
 *
 * ## Whose clock the cues are in
 *
 * `sourceKey: null` means they are timeline milliseconds, which is what a file
 * exported from a finished edit holds. A key means they are that clip's source
 * milliseconds, which is what a transcription service hands back when it was
 * given the raw file, and then the clip's trim and speed have to be applied.
 *
 * **A key naming an element that is gone is a caller error, not a fallback.**
 * `applyCaptionCommit` guards with `row.sourceKey != null && !sources.has(key)`,
 * so a key that is present in `clips` but absent from `doc.elements` passes the
 * guard, resolves to `undefined`, and is quietly treated as a timeline time. The
 * caller resolves the element before planning and passes `null` explicitly;
 * `importCues.test.ts` pins that, because nothing here can detect it.
 *
 * ## No ids are minted here
 *
 * Every id arrives in `ids`. The rule is `applyCaptions.ts`'s, and it is there
 * because an agent commit runs its transform twice, so anything minted inside
 * would differ between the probe and the run that counts.
 */

import { captionStyle, type CaptionFrame, type CaptionPlacement } from "../caption/layout";
import { applyCaptionCommit, type CaptionIds } from "../caption/applyCaptions";
import type { CaptionRow } from "../caption/rows";
import type { TimelineDocument } from "../timeline/tracks";
import type { SubtitleCue } from "./cues";

export type SubtitleImportPlan = {
  cues: readonly SubtitleCue[];
  /** The project's frame. `renderOptionStore.options.previewSize`. */
  frame: CaptionFrame;
  placement?: CaptionPlacement;
  /** null: the cues are timeline ms. Otherwise the clip whose source clock they count in. */
  sourceKey: string | null;
  /** One per cue, in order, minted by the caller. */
  ids: readonly CaptionIds[];
};

/**
 * Cues as placeable rows, with the caption look applied.
 *
 * The style is computed **once**, not per row. `rows.ts` states the rule and the
 * bug that came of ignoring it; here it is simply the truth, since every cue in
 * one file gets the same treatment.
 *
 * `lineId` is the cue's position in the file. It only has to be unique within
 * this plan: `applyCaptionCommit` reads it off the row and discards it, and a
 * caption session is the only thing that ever keys by it.
 */
export function cueRows(plan: SubtitleImportPlan): CaptionRow[] {
  const style = captionStyle(plan.frame, plan.placement ?? "lowerThird");

  return plan.cues.map((cue, index) => ({
    ...style,
    sourceKey: plan.sourceKey,
    lineId: `cue-${index + 1}`,
    text: cue.text,
    startTime: cue.startMs,
    // The cue owns two timestamps and this is the one place the difference is
    // taken. `normalizeCues` has already guaranteed the span is positive.
    duration: cue.endMs - cue.startMs,
  }));
}

/**
 * Place every cue, in one transform.
 *
 * Returns `doc` **by identity** when there is nothing to place, so
 * `withCheckpoint` records no undo step and an import of an empty file costs the
 * user nothing. That is the convention `features/timeline/` states.
 */
export function importSubtitles(
  doc: TimelineDocument,
  plan: SubtitleImportPlan,
): TimelineDocument {
  if (plan.cues.length === 0) {
    return doc;
  }

  return applyCaptionCommit(doc, {
    // No cuts: an import removes no footage. The clip is named only so
    // `applyCaptionCommit` resolves it and the rows can be mapped through its
    // trim and speed.
    clips:
      plan.sourceKey == null
        ? []
        : [{ key: plan.sourceKey, cuts: [], splits: [] }],
    rows: cueRows(plan),
    ids: { captions: [...plan.ids] },
  });
}
