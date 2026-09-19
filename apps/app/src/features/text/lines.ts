/**
 * Where a text element's stored string becomes lines the renderer can draw.
 *
 * `ctx.fillText` draws no line breaks — it collapses a `\n` and paints the run
 * as one line — so an author's explicit break has to be turned into separate
 * draws before it reaches the canvas. `renderer/text.ts` already wraps to the
 * box width; this is the other half, and the *only* place a break character is
 * given a meaning.
 *
 * Resolved on read, never on write. The stored string stays exactly what the
 * user typed, and this answers on every draw — the same rule `normalizeFps`
 * follows, and the reason `SCHEMA_VERSION` does not move for this feature.
 *
 * Deliberately DOM-free, like `text/style.ts`: it runs under
 * `environment: "node"`, and the renderer suites import it while drawing onto a
 * Skia canvas.
 */

/**
 * Split on every flavour of line break, keeping blank paragraphs.
 *
 * `\r\n` and a lone `\r` are accepted because only *one* of the writers is a
 * `<textarea>` — that one normalises its value to `\n` before we ever see it.
 * The MCP tools take `z.string()` and pass through whatever was pasted, which
 * on Windows or out of a word processor is routinely CRLF.
 *
 * An empty string yields `[""]` rather than `[]`. Callers treat the result as
 * "at least one line": `measureTextBlock` reads `lines[lines.length - 1]` for
 * the block's trailing descent, and an empty list would make it `undefined`.
 * A blank paragraph is likewise kept — it is the whole point of a double break,
 * and it has to reach the renderer to consume a line advance.
 *
 * Nothing is trimmed. What a run of spaces means is the greedy wrap's decision,
 * not this function's.
 */
export function splitParagraphs(text: string): string[] {
  return splitParagraphsWithOffsets(text).map((paragraph) => paragraph.text);
}

/** One paragraph, with where it starts in the string it came out of. */
export type Paragraph = { text: string; at: number };

/**
 * The same split, carrying each paragraph's offset in the original string.
 *
 * Per-range styling needs to map a character offset to a place on the canvas,
 * and the offset cannot be recovered downstream: the separators here are one or
 * two code units (`\r\n`), and the greedy wrap in `renderer/text.ts` drops
 * exactly one space per break it makes. Searching for the line's text in the
 * original would also find the wrong copy of a repeated line.
 *
 * So the producers emit the offset and nobody reconstructs it.
 * `splitParagraphs` stays as the answer to the simpler question, and delegates,
 * so the two can never disagree about where a break is.
 */
export function splitParagraphsWithOffsets(text: string): Paragraph[] {
  const source = text ?? "";
  const out: Paragraph[] = [];

  let at = 0;
  const breaks = /\r\n|\r|\n/g;
  let match = breaks.exec(source);
  while (match != null) {
    out.push({ text: source.slice(at, match.index), at });
    at = match.index + match[0].length;
    match = breaks.exec(source);
  }
  out.push({ text: source.slice(at), at });

  return out;
}
