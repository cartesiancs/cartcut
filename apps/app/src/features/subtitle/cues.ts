/**
 * What a subtitle file holds, once the syntax is gone.
 *
 * Deliberately free of every import, like `features/project/assetPaths.ts`: a
 * `.srt` has nothing to do with a `TimelineDocument`, and keeping the format
 * layer unable to reach the timeline is what lets `parse.ts` and `serialize.ts`
 * be checked against each other with nothing else in the way.
 *
 * ## Two timestamps, not a timestamp and a length
 *
 * A cue carries `endMs` rather than a duration because that is what the file
 * says. `CaptionOut` and `TextElementType` both want a duration, and the
 * conversion is one subtraction at the boundary in `importCues.ts`. Storing the
 * duration here instead would round on the way in and round again on the way
 * out, and a cue that comes back a millisecond short of where it started is
 * exactly the drift a round-trip suite exists to catch.
 *
 * ## Whose clock
 *
 * Nobody's, as far as this module is concerned. The same `SubtitleCue` describes
 * a time on the timeline and a time in one clip's source file; which one it is
 * belongs to the caller, and `importCues.ts` is where the question is answered.
 */

export type SubtitleFlavour = "srt" | "vtt";

export type SubtitleCue = {
  /** Milliseconds, in the caller's clock. */
  startMs: number;
  endMs: number;
  /** Plain text, no markup. `\n` separates lines within the one cue. */
  text: string;
};

/**
 * The shortest cue worth keeping, in ms. Matches `lines.ts#MIN_DURATION_MS`.
 *
 * A zero-length cue is legal in a file and invisible on a timeline, so it is
 * widened rather than dropped: the words were said, and a caption nobody can
 * see is a worse answer than one that flashes.
 */
export const MIN_CUE_MS = 1;

/**
 * The same cues, in a shape every consumer can rely on.
 *
 * Run at both ends: `parse.ts` finishes with it so a caller never sees a file's
 * disorder, and `serialize.ts` starts with it so an SRT's indices are sequential
 * in the order the cues are actually written. That is why it is not a document
 * op and does not follow the decline-by-identity rule: it always answers with a
 * new array, and both callers want it to.
 *
 * Blank text goes, because a text element with no words is invisible and
 * unfindable on the timeline (the argument `captionsFrom` makes). Sorting
 * breaks ties on `endMs` so two cues starting together have one order rather
 * than whichever order the file happened to list them in.
 */
export function normalizeCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  return cues
    .map((cue) => {
      const startMs = Math.max(0, Math.round(cue.startMs));
      return {
        startMs,
        endMs: Math.max(startMs + MIN_CUE_MS, Math.round(cue.endMs)),
        text: cue.text.trim(),
      };
    })
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
