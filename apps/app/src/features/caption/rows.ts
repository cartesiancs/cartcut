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
 * Every field is a `TextElementOptions` key except `sourceKey`, which `Control`
 * removes before placing. The times are source-file milliseconds.
 */
export type CaptionRow = CaptionStyle &
  CaptionOut & {
    /** The element key of the transcribed clip, or null if none was chosen. */
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

  return captionsFrom(lines).map((caption) => ({
    sourceKey,
    ...style,
    ...caption,
  }));
}
