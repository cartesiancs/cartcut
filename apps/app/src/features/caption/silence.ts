/**
 * What counts as a silence worth cutting.
 *
 * Two sources have to agree before anything is removed:
 *
 * - **the signal**, `electron/mcp/analysis/signal.ts#silentRanges`, an absolute
 *   dBFS threshold over an RMS envelope, arriving here through `analyze:silences`;
 * - **the words**, the gaps between one word's end and the next one's start,
 *   which the panel already holds because a transcript timestamps every word.
 *
 * Neither is enough on its own, and they fail in opposite directions. The signal
 * alone hears laughter, a held note, music under the take and room tone at a
 * level, and reads none of them as silence, so the cut never happens; worse, it
 * reads a quiet *word* as silence and cuts speech. The words alone see a gap
 * wherever nobody is speaking, including over a sound effect or a musical sting
 * that is the whole point of the moment. The intersection is the part both
 * agree is dead air, which is the only part it is safe to remove without
 * showing the user a waveform first.
 *
 * `signal.ts` says the same thing from the other side: the transcript cannot
 * infer a gap that is not between words, which is why the signal is needed at
 * all. This module is where the two meet.
 *
 * Times are **source-file milliseconds**, the clock both inputs already use.
 * `lines.ts` counts in seconds because a media element's `currentTime` does, so
 * the conversion happens here, on the way in, exactly once.
 */

import type { TimeRange } from "../timeline/clipOps";
import { normalizeRanges } from "../timeline/clipOps";
import type { CaptionLine } from "./lines";

export type SilenceOptions = {
  /**
   * Silence to leave behind, in ms, split evenly between the two edges.
   *
   * A pause is trimmed *to* this, never to nothing. The same rule
   * `electron/mcp/analysis/style.ts` writes as `cutting.maxSilenceMs`: butting
   * two sentences hard against each other leaves nowhere to breathe and reads
   * as a mistake rather than as tightening. Splitting it evenly keeps a beat
   * after the last word and a beat before the next, which is what the ear is
   * listening for at a sentence boundary.
   */
  keepMs: number;
  /**
   * The shortest cut worth making.
   *
   * Below this the edit costs a clip boundary, two extra elements on the track
   * and a possible frame of judder, and buys back a gap nobody can hear. It is
   * also what stops a sweep from turning one clip into two hundred.
   */
  minCutMs: number;
};

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  keepMs: 200,
  minCutMs: 150,
};

/**
 * The stretches no word covers, in source ms.
 *
 * `bounds` is the window the cut may touch, which is the clip's own trim window
 * rather than the file's length. Passing it is what makes the lead-in and the
 * lead-out candidates at all: the pause before the first word and the dead room
 * after the last one are usually the two longest silences in a take, and a
 * function that only looked between words would be unable to name either.
 *
 * Words are read across every line, struck out or not. A struck-out line's
 * footage is cut whole, so its internal gaps are merged away by
 * `normalizeRanges` in `cuts.ts` rather than being a case to handle here.
 *
 * Words are sorted before the walk because a merge can leave a line's array in
 * an order the clock does not agree with, and an unsorted walk would mint a
 * negative gap and, once clamped, a cut in the wrong place.
 */
export function wordGaps(
  lines: CaptionLine[],
  bounds: TimeRange,
): TimeRange[] {
  const spoken = lines
    .flatMap((line) => line.words)
    .map((word) => ({
      startMs: word.start * 1000,
      endMs: word.end * 1000,
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const gaps: TimeRange[] = [];
  let cursor = bounds.startMs;

  for (const word of spoken) {
    if (word.startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: word.startMs });
    }
    // `max` rather than assignment: words can overlap, and a shorter word
    // sitting inside a longer one must not pull the cursor backwards and
    // reopen a gap that was already spoken over.
    cursor = Math.max(cursor, word.endMs);
  }

  if (bounds.endMs > cursor) {
    gaps.push({ startMs: cursor, endMs: bounds.endMs });
  }

  return clampAll(gaps, bounds);
}

/**
 * The ranges to cut: silent by the signal, empty by the words, minus the breath.
 *
 * Ordered ascending, which is what `cuts.ts` wants before it converts and
 * normalises. Nothing here snaps to a frame grid: these are source times, and
 * the grid is a timeline concept.
 */
export function silenceCuts(
  silences: TimeRange[],
  gaps: TimeRange[],
  options: SilenceOptions = DEFAULT_SILENCE_OPTIONS,
): TimeRange[] {
  const keep = Math.max(0, options.keepMs);
  const minCut = Math.max(0, options.minCutMs);
  const cuts: TimeRange[] = [];

  for (const silence of silences) {
    for (const gap of gaps) {
      const startMs = Math.max(silence.startMs, gap.startMs);
      const endMs = Math.min(silence.endMs, gap.endMs);
      if (endMs <= startMs) {
        continue;
      }

      // The breath comes off the agreed stretch, not off the silence the signal
      // reported: the part of a silence that runs under a word is not ours to
      // spend.
      const half = keep / 2;
      const cut = { startMs: startMs + half, endMs: endMs - half };
      if (cut.endMs - cut.startMs >= minCut) {
        cuts.push(cut);
      }
    }
  }

  // Ascending and merged. Two gaps can both meet one long silence, and the two
  // pieces are one cut as far as anything downstream is concerned.
  return normalizeRanges(cuts).slice().reverse();
}

function clampAll(ranges: TimeRange[], bounds: TimeRange): TimeRange[] {
  const out: TimeRange[] = [];
  for (const range of ranges) {
    const startMs = Math.max(range.startMs, bounds.startMs);
    const endMs = Math.min(range.endMs, bounds.endMs);
    if (endMs > startMs) {
      out.push({ startMs, endMs });
    }
  }
  return out;
}
