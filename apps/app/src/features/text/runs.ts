/**
 * Per-range text style: what one stretch of a text element overrides about the
 * clip it sits in, and how a stored list of those survives being read, written
 * and edited.
 *
 * The module follows the split the rest of the codebase uses:
 *
 *  - **`runsOf` guards reads.** It runs inside the layout, once per element per
 *    frame, and must never throw. Whatever is in the file, it answers a sorted,
 *    disjoint, non-empty list clamped to the string that is actually there.
 *  - **`coerceRunStyle` validates writes.** It runs once, where a value arrives
 *    from the panel, and drops a field it cannot read rather than defaulting
 *    it. Past that point an unusable override is unrepresentable.
 *
 * Two things are worth knowing before changing anything here.
 *
 * **Offsets are UTF-16 code units, and that is not a choice.**
 * `textarea.selectionStart` is measured that way and its value is what lands in
 * a run. `runsOf` snaps an offset that falls inside a surrogate pair outward,
 * so no consumer can `slice` out a lone surrogate.
 *
 * **A style with no keys is not a style.** The whole default-deletes-the-key
 * rule rests on it: `applyRunStyle` answers "paint this range the colour it
 * already is" by producing an empty style, which is then dropped, which leaves
 * no runs, which lets `timeline/textRunOps.ts` delete the field and save the
 * project byte-identically to one written before the feature existed.
 *
 * Deliberately DOM-free and store-free, like `style.ts` and `metrics.ts`: it
 * runs under `environment: "node"` and the pure ops import it.
 */

import type {
  TextElementType,
  TextRun,
  TextRunStyle,
} from "../../@types/timeline";
import {
  coerceFontWeight,
  elementFontWeight,
} from "../font/fontWeight";
import { resolveTextStyle } from "./style";

/**
 * Every field a run may override, in the order everything here iterates them.
 *
 * A canonical order is what makes two equal styles stringify identically, which
 * is what the styled wrap cache's key depends on.
 */
export const RUN_STYLE_KEYS = [
  "fontname",
  "fontpath",
  "fonttype",
  "fontweight",
  "fontsize",
  "color",
  "bold",
  "italic",
  "outlineEnable",
  "outlineSize",
  "outlineColor",
] as const satisfies readonly (keyof TextRunStyle)[];

export type RunStyleKey = (typeof RUN_STYLE_KEYS)[number];

/** The clip's own style, said in the run vocabulary. Every key present. */
export type RunStyleValues = Required<TextRunStyle>;

/**
 * Shared, so the overwhelmingly common "this clip has no runs" answer costs no
 * allocation. It is returned frozen because callers hold it for a frame.
 */
const NO_RUNS: readonly TextRun[] = Object.freeze([]);

/** `#rgb` or `#rrggbb`. What `text/style.ts#withAlpha` is able to parse. */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// --------------------------------------------------------------- field coercion

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : undefined;
}

function readBool(value: unknown): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

function readNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min) {
    return undefined;
  }
  return Math.min(max, n);
}

/**
 * A size, refusing zero as well as the unreadable.
 *
 * A zero-size run draws nothing and measures nothing, so it would be an
 * invisible hole in the middle of a line rather than a small piece of text.
 */
function readPositive(value: unknown, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.min(max, n);
}

/**
 * Validate one override on the way into the document.
 *
 * A field it cannot read is **dropped**, not defaulted, and dropping is the
 * right answer here rather than the refusal `coerceMask` gives: an absent key
 * already means "the clip's own value", so a junk `fontsize` falls back to
 * exactly what the user sees today. `null` comes back only when nothing at all
 * survived, which is the caller's signal that the write is a no-op.
 *
 * The bounds match `text/style.ts#resolveTextStyle`, so a run can never ask for
 * something the clip itself could not.
 */
export function coerceRunStyle(value: unknown): TextRunStyle | null {
  if (value == null || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const style: TextRunStyle = {};

  for (const key of RUN_STYLE_KEYS) {
    if (!(key in source)) {
      continue;
    }
    switch (key) {
      case "fontname":
      case "fontpath":
      case "fonttype": {
        const read = readString(source[key]);
        if (read !== undefined) {
          style[key] = read;
        }
        break;
      }
      case "fontweight": {
        // Snapped to the ladder, for the reason `coerceFontWeight` gives: the
        // picker only ever offers rungs, and a weight of 437 is
        // unrepresentable in the UI that has to show it back.
        if (readNumber(source[key], 1, 1000) !== undefined) {
          style.fontweight = coerceFontWeight(source[key]);
        }
        break;
      }
      case "fontsize": {
        const read = readPositive(source[key], 2000);
        if (read !== undefined) {
          style.fontsize = read;
        }
        break;
      }
      case "color":
      case "outlineColor": {
        const read = readColor(source[key]);
        if (read !== undefined) {
          style[key] = read;
        }
        break;
      }
      case "bold":
      case "italic":
      case "outlineEnable": {
        const read = readBool(source[key]);
        if (read !== undefined) {
          style[key] = read;
        }
        break;
      }
      case "outlineSize": {
        const read = readNumber(source[key], 0, 200);
        if (read !== undefined) {
          style.outlineSize = read;
        }
        break;
      }
    }
  }

  return isEmptyStyle(style) ? null : style;
}

function isEmptyStyle(style: TextRunStyle): boolean {
  for (const key of RUN_STYLE_KEYS) {
    if (style[key] !== undefined) {
      return false;
    }
  }
  return true;
}

export function sameRunStyle(
  a: TextRunStyle | undefined,
  b: TextRunStyle | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  for (const key of RUN_STYLE_KEYS) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two run lists say the same thing.
 *
 * Not a convenience. Every panel control rebuilds the whole patch on every
 * change, so `!==` would report a change for a click that asked for the style a
 * range already had, and `withCheckpoint` would spend an undo step on nothing.
 * `mask/maskShape.ts#sameMask` exists for the same reason.
 */
export function sameRuns(
  a: readonly TextRun[] | undefined,
  b: readonly TextRun[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  const left = a ?? NO_RUNS;
  const right = b ?? NO_RUNS;
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (
      left[i].from !== right[i].from ||
      left[i].to !== right[i].to ||
      !sameRunStyle(left[i].style, right[i].style)
    ) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------ offset arithmetic

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Move an offset off the inside of a surrogate pair.
 *
 * `direction` is which way the boundary should travel to leave the pair whole:
 * a run's `from` moves back onto the pair's start and its `to` moves forward
 * past its end, so a run covering an emoji covers all of it or none of it and
 * `slice` can never produce a lone surrogate.
 */
function snapOffset(
  text: string,
  offset: number,
  direction: -1 | 1,
): number {
  const clamped = Math.min(text.length, Math.max(0, Math.trunc(offset)));
  if (clamped <= 0 || clamped >= text.length) {
    return clamped;
  }
  if (
    isLowSurrogate(text.charCodeAt(clamped)) &&
    isHighSurrogate(text.charCodeAt(clamped - 1))
  ) {
    return clamped + direction;
  }
  return clamped;
}

/** A range as the document should store it, or null when it covers nothing. */
export function snapRange(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const start = snapOffset(text, lo, -1);
  const end = snapOffset(text, hi, 1);
  return start < end ? { from: start, to: end } : null;
}

// ------------------------------------------------------------------ read guard

/**
 * The runs in force on an element, normalized.
 *
 * Never throws: the argument can be a hand-edited file, a clip of another type,
 * or nothing at all. The result is sorted by `from`, disjoint, clamped to the
 * element's current string, free of empty styles, and has every pair of
 * adjacent equal runs merged, so two equal settings always produce one list.
 *
 * Overlaps resolve **later wins**, which is what `applyRunStyle` produces
 * anyway, so a file somebody edited by hand behaves like an ordinary edit.
 */
export function runsOf(
  element: TextElementType | null | undefined,
): readonly TextRun[] {
  const stored = (element as { runs?: unknown } | null | undefined)?.runs;
  if (!Array.isArray(stored) || stored.length === 0) {
    return NO_RUNS;
  }
  const text = typeof element?.text === "string" ? element.text : "";
  if (text.length === 0) {
    return NO_RUNS;
  }

  type Piece = { from: number; to: number; style: TextRunStyle };
  const pieces: Piece[] = [];
  for (const entry of stored as unknown[]) {
    if (entry == null || typeof entry !== "object") {
      continue;
    }
    const run = entry as { from?: unknown; to?: unknown; style?: unknown };
    const from = typeof run.from === "number" ? run.from : Number(run.from);
    const to = typeof run.to === "number" ? run.to : Number(run.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      continue;
    }
    const range = snapRange(text, from, to);
    if (range == null) {
      continue;
    }
    const style = coerceRunStyle(run.style);
    if (style == null) {
      continue;
    }
    pieces.push({ from: range.from, to: range.to, style });
  }

  return flatten(pieces);
}

/** True when this element draws anything other than its own one style. */
export function hasRuns(element: TextElementType | null | undefined): boolean {
  return runsOf(element).length > 0;
}

/**
 * Turn possibly overlapping pieces into a sorted, disjoint, merged list.
 *
 * Every boundary becomes a cut, each elementary interval takes the style of the
 * **last** piece covering it, and equal neighbours are then merged back
 * together. Quadratic in the number of pieces, which is fine: pieces come from
 * a person selecting text, and the merge keeps the count near the number of
 * visibly distinct stretches rather than the number of edits.
 */
function flatten(
  pieces: { from: number; to: number; style: TextRunStyle }[],
): readonly TextRun[] {
  if (pieces.length === 0) {
    return NO_RUNS;
  }

  const cuts = new Set<number>();
  for (const piece of pieces) {
    cuts.add(piece.from);
    cuts.add(piece.to);
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const out: TextRun[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i];
    const to = bounds[i + 1];

    let style: TextRunStyle | null = null;
    for (const piece of pieces) {
      if (piece.from <= from && piece.to >= to) {
        style = piece.style;
      }
    }
    if (style == null) {
      continue;
    }

    const previous = out[out.length - 1];
    if (previous != null && previous.to === from && sameRunStyle(previous.style, style)) {
      previous.to = to;
      continue;
    }
    out.push({ from, to, style });
  }

  return out.length === 0 ? NO_RUNS : out;
}

// --------------------------------------------------------------- resolved style

/**
 * The clip's own values, said in the run vocabulary.
 *
 * One function so that three things cannot disagree: what a segment with no
 * override draws with, what the panel shows for an unstyled range, and which
 * patch fields `setTextRangeStyle` drops as "already that".
 */
export function elementRunStyle(element: TextElementType): RunStyleValues {
  const outline = resolveTextStyle(element).outline;
  return {
    fontname: element.fontname,
    fontpath: element.fontpath,
    fonttype: element.fonttype,
    fontweight: elementFontWeight(element.fontname, element.fontweight),
    fontsize: element.fontsize,
    color: element.textcolor,
    bold: element.options?.isBold === true,
    italic: element.options?.isItalic === true,
    outlineEnable: outline.enable,
    outlineSize: outline.size,
    outlineColor: outline.color,
  };
}

/** The sparse override covering an offset, or `{}` where there is none. */
export function runStyleAt(
  runs: readonly TextRun[],
  offset: number,
): TextRunStyle {
  for (const run of runs) {
    if (run.from <= offset && offset < run.to) {
      return run.style;
    }
  }
  return {};
}

/** What is actually drawn at an offset: the clip's style under the run's. */
export function resolvedStyleAt(
  element: TextElementType,
  runs: readonly TextRun[],
  offset: number,
): RunStyleValues {
  return { ...elementRunStyle(element), ...runStyleAt(runs, offset) };
}

// ------------------------------------------------------------------- the writer

/**
 * Merge a patch over `[from, to)`.
 *
 * The only producer of run geometry. It splits every run the range crosses,
 * merges the patch onto the covered pieces, drops a merged style that has ended
 * up empty, and merges equal neighbours back together.
 *
 * Returns its input **by identity** when nothing moved, which is what carries
 * the decline contract up to `timeline/textRunOps.ts` and from there to
 * `withCheckpoint`.
 *
 * It does not know about the element's own values. Dropping the patch fields a
 * clip already has is `setTextRangeStyle`'s job, because that is where the
 * element is in hand.
 */
export function applyRunStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  patch: TextRunStyle,
  text: string,
): readonly TextRun[] {
  const range = snapRange(text, from, to);
  if (range == null) {
    return runs;
  }
  const clean = coerceRunStyle(patch);
  if (clean == null) {
    return runs;
  }

  const pieces: { from: number; to: number; style: TextRunStyle }[] = [];

  // What survives outside the range, unchanged.
  for (const run of runs) {
    if (run.from < range.from) {
      pieces.push({
        from: run.from,
        to: Math.min(run.to, range.from),
        style: run.style,
      });
    }
    if (run.to > range.to) {
      pieces.push({
        from: Math.max(run.from, range.to),
        to: run.to,
        style: run.style,
      });
    }
  }

  // The range itself, cut at every boundary an existing run puts inside it so
  // that each piece has exactly one base style to merge the patch onto.
  const inner = new Set<number>([range.from, range.to]);
  for (const run of runs) {
    if (run.from > range.from && run.from < range.to) {
      inner.add(run.from);
    }
    if (run.to > range.from && run.to < range.to) {
      inner.add(run.to);
    }
  }
  const bounds = [...inner].sort((a, b) => a - b);
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const merged = { ...runStyleAt(runs, bounds[i]), ...clean };
    if (isEmptyStyle(merged)) {
      continue;
    }
    pieces.push({ from: bounds[i], to: bounds[i + 1], style: merged });
  }

  const next = flatten(
    pieces.filter((piece) => piece.from < piece.to),
  );
  return sameRuns(next, runs) ? runs : next;
}

/** Drop every override over `[from, to)`, leaving the clip's own style. */
export function clearRunStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  text: string,
): readonly TextRun[] {
  const range = snapRange(text, from, to);
  if (range == null) {
    return runs;
  }

  const pieces: { from: number; to: number; style: TextRunStyle }[] = [];
  for (const run of runs) {
    if (run.from < range.from) {
      pieces.push({
        from: run.from,
        to: Math.min(run.to, range.from),
        style: run.style,
      });
    }
    if (run.to > range.to) {
      pieces.push({
        from: Math.max(run.from, range.to),
        to: run.to,
        style: run.style,
      });
    }
  }

  const next = flatten(pieces.filter((piece) => piece.from < piece.to));
  return sameRuns(next, runs) ? runs : next;
}

// ------------------------------------------------------------- following edits

/** One splice of the string, as `diffEdit` reports it. */
export type TextEdit = { at: number; removed: number; inserted: number };

/**
 * What changed between two versions of the string, as a single splice.
 *
 * Exact rather than approximate for the field this serves. A `<textarea>` has
 * no multiple carets, so one `input` event is one contiguous replacement, and
 * the common prefix and suffix recover it precisely.
 *
 * The one ambiguity is a repeated character: `"aa"` becoming `"aaa"` could be
 * an insert at 0, 1 or 2 and the prefix scan resolves it at 2. That is where
 * the caret lands when somebody types at the end, which is the overwhelmingly
 * common case; typing the same character at the *start* of a repeat moves the
 * boundary of a run that ends exactly there, and nothing else.
 */
export function diffEdit(before: string, after: string): TextEdit | null {
  if (before === after) {
    return null;
  }

  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix += 1;
  }

  let suffix = 0;
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < suffixLimit &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  return {
    at: prefix,
    removed: before.length - prefix - suffix,
    inserted: after.length - prefix - suffix,
  };
}

/**
 * Move the runs so they still cover the same text after an edit.
 *
 * Deletion first, then insertion, because `at` is the offset in the string that
 * remains after the removal. The two insertion rules are not symmetric, and
 * that asymmetry is the behaviour every text editor has: text typed at a run's
 * **end** joins it, text typed at its **start** does not. So a `to` at the
 * insertion point grows and a `from` at it shifts.
 *
 * Returns its input by identity when nothing moved.
 */
export function shiftRuns(
  runs: readonly TextRun[],
  edit: TextEdit,
): readonly TextRun[] {
  if (runs.length === 0) {
    return runs;
  }
  const at = Math.max(0, Math.trunc(edit.at));
  const removed = Math.max(0, Math.trunc(edit.removed));
  const inserted = Math.max(0, Math.trunc(edit.inserted));
  if (removed === 0 && inserted === 0) {
    return runs;
  }

  const end = at + removed;
  const afterDelete = (x: number) => (x <= at ? x : x >= end ? x - removed : at);

  const out: TextRun[] = [];
  for (const run of runs) {
    const from = afterDelete(run.from);
    const to = afterDelete(run.to);
    if (from >= to) {
      continue;
    }
    out.push({
      from: from >= at ? from + inserted : from,
      to: to >= at ? to + inserted : to,
      style: run.style,
    });
  }

  // The delete can leave two pieces of one run touching, or two runs that were
  // separated by the removed text. `flatten` merges equal neighbours, which is
  // what keeps the list from growing by one entry per backspace.
  const next = flatten(out);
  return sameRuns(next, runs) ? runs : next;
}

// ----------------------------------------------------------- panel and bleed

/** A value shared by a whole range, or the fact that it is not. */
export type RangeValue<T> = { kind: "one"; value: T } | { kind: "mixed" };

export type RangeSummary = {
  [K in RunStyleKey]: RangeValue<RunStyleValues[K]>;
};

/**
 * What the panel should show for a range: one value per control, or "mixed".
 *
 * Resolved rather than sparse, because that is the question the controls ask.
 * A range with no runs in it reports the clip's own values, which is what makes
 * the panel read the same whether or not the user has styled anything.
 */
export function rangeStyleSummary(
  element: TextElementType,
  runs: readonly TextRun[],
  from: number,
  to: number,
): RangeSummary {
  const base = elementRunStyle(element);
  const range = snapRange(element.text ?? "", from, to);
  if (range == null) {
    return summaryOf([base]);
  }

  // Every elementary interval of the range: the boundaries the runs put inside
  // it, plus its own ends.
  const cuts = new Set<number>([range.from]);
  for (const run of runs) {
    if (run.from > range.from && run.from < range.to) {
      cuts.add(run.from);
    }
    if (run.to > range.from && run.to < range.to) {
      cuts.add(run.to);
    }
  }
  const starts = [...cuts].sort((a, b) => a - b);

  return summaryOf(
    starts.map((offset) => ({ ...base, ...runStyleAt(runs, offset) })),
  );
}

function summaryOf(samples: RunStyleValues[]): RangeSummary {
  const summary = {} as RangeSummary;
  for (const key of RUN_STYLE_KEYS) {
    const first = samples[0][key];
    const uniform = samples.every((sample) => sample[key] === first);
    (summary[key] as RangeValue<unknown>) = uniform
      ? { kind: "one", value: first }
      : { kind: "mixed" };
  }
  return summary;
}

/**
 * The widest stroke any run asks for, for `style.ts#styleBleed`.
 *
 * Rasterisation renders onto a canvas sized from the element plus that margin,
 * so a run whose outline is wider than the clip's would be sliced off at the
 * edge of the PNG without this.
 */
export function runsOutlineBleed(element: TextElementType): number {
  const base = elementRunStyle(element);
  let widest = 0;
  for (const run of runsOf(element)) {
    const enable = run.style.outlineEnable ?? base.outlineEnable;
    if (!enable) {
      continue;
    }
    widest = Math.max(widest, run.style.outlineSize ?? base.outlineSize);
  }
  return widest;
}
