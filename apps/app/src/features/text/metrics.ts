/**
 * How far apart a text element's lines sit, and how tall one line's box is.
 *
 * This used to be `element.height`, which made the box height and the line
 * spacing the same number: growing the box to make room pushed the lines apart
 * instead, and there was no way to ask for either one on its own. No NLE works
 * that way — leading is a property of the *type*, derived from the font size,
 * and the box is a consequence of the text rather than an input to it.
 *
 * So the advance comes from here, `element.height` no longer reaches the
 * layout at all, and `element/textFit.ts` writes the box back from what this
 * produces.
 *
 * Deliberately DOM-free, like `style.ts` and `lines.ts`: it runs under
 * `environment: "node"`, and the renderer suites import it while drawing onto a
 * Skia canvas.
 */

import type { TextElementType } from "../../@types/timeline";

/**
 * CSS `line-height: normal` lands near 1.2em in nearly every face, and it is
 * what Premiere, Resolve and After Effects all default their leading to.
 *
 * It is also close to what this app was already doing by accident:
 * `changeTextSize` wrote `fontsize + 16`, which at the default 52px is 1.31×.
 * So a project whose text was last sized through the sidebar tightens very
 * slightly rather than reflowing.
 */
export const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * Half an em is the tightest that still reads as separate lines; four is past
 * any real design. Both are limits rather than refusals — a value outside them
 * is clamped, never rejected, because the alternative is text that vanishes.
 */
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 4;

/**
 * The fraction of the em that hangs below the baseline, when nothing can be
 * measured. Only a fallback: `renderer/text.ts` asks the font itself through
 * `fontBoundingBoxDescent` whenever there is a context to ask.
 */
export const FALLBACK_DESCENT_RATIO = 0.25;

/**
 * The read guard. Runs on every draw and must never throw.
 *
 * Numeric strings are accepted because the option panel writes straight from an
 * `<input>`, and an emptied field arrives as `""` → `NaN`. A `NaN` advance
 * would stack every line on one baseline, which reads as "the text disappeared"
 * rather than as a bad number.
 */
export function normalizeLineHeight(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) {
    return DEFAULT_LINE_HEIGHT;
  }
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, n));
}

/**
 * The write validator. Runs once, where a value is stored, so an unusable
 * leading is unrepresentable from then on. Same split as
 * `normalizeFps`/`coerceFps`.
 */
export function coerceLineHeight(value: unknown): number {
  return normalizeLineHeight(value);
}

/**
 * The gap between one baseline and the next, in pixels.
 *
 * Line *i* of an element sits at `fontsize + i * lineAdvanceOf(element)`.
 * `element.height` is deliberately not read here — that is the whole change.
 */
export function lineAdvanceOf(element: TextElementType): number {
  const fontsize = Number(element?.fontsize);
  const size = Number.isFinite(fontsize) && fontsize > 0 ? fontsize : 1;
  return size * normalizeLineHeight(element?.options?.lineHeight);
}

/**
 * A one-line box height for a size, for the two moments nothing can be measured
 * yet: creating an element, and running without a canvas.
 *
 * It only has to be close. `textFit` corrects it against the real font as soon
 * as there is something to measure against.
 */
export function defaultTextHeight(
  fontsize: number,
  lineHeight?: number,
): number {
  const size = Number.isFinite(fontsize) && fontsize > 0 ? fontsize : 1;
  // The same shape `measureTextBlock` uses for one line: the first baseline
  // plus whatever hangs below it. The leading only enters from the second line
  // on, so it is applied to the descent alone here — a taller leading gives a
  // slightly roomier single-line box, which is what a text tool shows.
  return Math.round(
    size + size * FALLBACK_DESCENT_RATIO * normalizeLineHeight(lineHeight),
  );
}
