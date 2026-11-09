/**
 * Which line each word of a split sits on, from where the browser laid it out.
 *
 * A new line starts where a word's centre on the block axis moves by more than
 * 2px from the line's first word. Measured on the sum of the two edges rather
 * than the centre, so the comparison stays in whole layout units. DOM-free: the
 * host reads the rectangles and writes `--line-index` back.
 */

export type WordRect = { top: number; bottom: number; left: number; right: number };

/** One line index per word, in order; the line count is the last index plus one. */
export function lineIndices(rects: readonly WordRect[], vertical: boolean): number[] {
  const out: number[] = [];
  let line = -1;
  let last = Number.NaN;
  for (const rect of rects) {
    const at = vertical ? rect.left + rect.right : rect.top + rect.bottom;
    if (Number.isNaN(last) || Math.abs(at - last) > 2) {
      line += 1;
      last = at;
    }
    out.push(line);
  }
  return out;
}
