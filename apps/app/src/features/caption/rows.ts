/**
 * The rows the auto-caption panel hands back when the user is done.
 *
 * One row per caption, carrying everything `elementControl.addText` needs plus
 * the key of the clip the transcript came from. `ui/control/Control.ts`
 * destructures that key off, resolves the clip, and spreads
 * `captionToTimeline(caption, source)` over the rest — so the row's
 * `startTime`/`duration` are in the **source file's** clock on the way out and
 * in the timeline's clock by the time they reach the store.
 *
 * Lifted out of the panel for the reason `layout.ts`, `locale.ts` and
 * `sources.ts` all give: `apps/automatic-caption/` is outside every vitest
 * include pattern, and this is the panel's contract with the rest of the app.
 * A change here is visible at `Control.ts:147-160` and nowhere else, which is
 * exactly the kind of seam worth pinning.
 *
 * **The style is computed once, not per row.** The panel computed it per row,
 * from the row's index — while the rows it was indexing came from
 * `captionsFrom`, which drops a line the user emptied. From the first emptied
 * line onwards the two lists disagreed, and the only thing that made it
 * harmless was the spread order putting the caption's own `text` last. See
 * `layout.ts#captionStyle`.
 */

import { captionStyle, type CaptionFrame, type CaptionPlacement, type CaptionStyle } from "./layout";
import { captionsFrom, type CaptionLine, type CaptionOut } from "./lines";

/**
 * One caption, ready for `addText`.
 *
 * Every field is a `TextElementOptions` key except `sourceKey` and `lineId`,
 * both of which are destructured off before placing. The times are source-file
 * milliseconds.
 *
 * `lineId` rides along rather than being looked up because the row is the only
 * thing that crosses into `applyCaptions.ts`, and by then `captionsFrom` has
 * already dropped the empty and struck-out lines: there is no index that would
 * find the line again.
 */
export type CaptionRow = CaptionStyle &
  CaptionOut & {
    /**
     * The element key of the clip this caption was spoken in, or null if none
     * was chosen. A line's own key wins over the fallback, which is what lets
     * one list hold the captions of several clips.
     */
    sourceKey: string | null;
  };

/**
 * Every caption worth placing, with the shared style applied.
 *
 * Empty lines are already gone — `captionsFrom` drops them, because an empty
 * text element on the timeline is invisible and unfindable — and it is what
 * guarantees every row has a `text`, which is what makes an index-free style
 * safe here.
 */
export function captionRows(
  lines: CaptionLine[],
  sourceKey: string | null,
  frame: CaptionFrame,
  placement: CaptionPlacement = "lowerThird",
): CaptionRow[] {
  const style = captionStyle(frame, placement);
  // By id, because `captionsFrom` drops lines and no index survives it.
  const keys = new Map(lines.map((line) => [line.id, line.sourceKey]));

  return captionsFrom(lines).map((caption) => ({
    sourceKey: keys.get(caption.lineId) ?? sourceKey,
    ...style,
    ...caption,
  }));
}
