/**
 * Word-wrap line breaking for text elements.
 *
 * Extracted from the identical loop that appeared (three times over) in
 * drawText and drawTextBackground for every align mode. The line-breaking rule
 * is align-independent — only the horizontal placement of each produced line
 * differs — so this single function drives left/center/right alike.
 *
 * `measure` is injected (`ctx.measureText(s).width` in production) which keeps
 * this pure and unit-testable without a canvas.
 */

export type MeasureText = (text: string) => number;

/**
 * Break `text` into lines that each fit within `maxWidth`. Mirrors the original
 * greedy algorithm exactly: split on spaces, accumulate `word + " "` while the
 * measured width stays below `maxWidth`, and always emit the trailing line
 * (each produced line keeps its trailing space, as the original did).
 */
export function wrapTextLines(
  measure: MeasureText,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (let index = 0; index < words.length; index++) {
    const testLine = line + words[index] + " ";
    const testWidth = measure(testLine);
    if (testWidth < maxWidth) {
      line = testLine;
    } else {
      lines.push(line);
      line = words[index] + " ";
    }
  }
  lines.push(line);
  return lines;
}
