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
  return (text ?? "").split(/\r\n|\r|\n/);
}
