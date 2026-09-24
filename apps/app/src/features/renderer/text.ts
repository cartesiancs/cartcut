import type { TextElementType, TextRun } from "../../@types/timeline";
import type { ElementRenderFunction } from "./type";
import type { ResolvedTextStyle } from "../text/style";
import {
  displayTextOf,
  resolveTextStyle,
  styleBleed,
  withAlpha,
} from "../text/style";
import { splitParagraphsWithOffsets } from "../text/lines";
import type { RunStyleValues } from "../text/runs";
import {
  RUN_STYLE_KEYS,
  elementRunStyle,
  runStyleAt,
  runsOf,
  snapRange,
} from "../text/runs";
import {
  FALLBACK_DESCENT_RATIO,
  lineAdvanceForSize,
  lineAdvanceOf,
  normalizeLineHeight,
} from "../text/metrics";
import type { LineReveal, RevealHead } from "../text/reveal";
import { revealOf, revealPlan, sampledRevealProgress } from "../text/reveal";
import { matrixScale, paintShadowOnly } from "./shadow";
import { frostBackdrop } from "./backdrop";
import { fontWeightToken } from "../font/fontWeight";
import type { HighlightRect } from "./textRangeHighlight";

type WrappedLine = {
  line: string;
  /**
   * Where `line[0]` sits in the element's own string.
   *
   * Emitted by the producers rather than recovered here, because it cannot be
   * recovered: the paragraph split consumes a separator of one or two code
   * units and the greedy wrap below drops exactly one space per break it
   * makes, and searching for the line's text would find the wrong copy of a
   * repeated line. Per-range styling and the selection highlight both map a
   * character offset to a place on the canvas through this.
   */
  at: number;
  width: number;
  ascent: number;
  descent: number;
  /**
   * The largest type on this line. The element's own size unless a run asks
   * for something bigger, which is what makes the advance below it grow.
   */
  maxSize: number;
  /**
   * The pieces this line is drawn in, or `null` when the clip has no runs.
   *
   * `null` is not "one segment". It is the branch that takes the original
   * single-`fillText` path, which keeps a clip nobody has styled a range in
   * drawing byte-identically to what it always drew - kerning included, which
   * segmenting necessarily loses at every boundary.
   */
  segments: LineSegment[] | null;
};

/**
 * One stretch of a line drawn in one face at one size.
 *
 * It carries both coordinate systems on purpose. `at`/`sourceLength` index the
 * element's **stored** string, which is what a run and a textarea selection are
 * measured in; `text` is what actually reaches the canvas, which is the stored
 * slice after the case transform and so may be a different length (`"ß"`
 * uppercases to `"SS"`). Keeping both is what lets the selection highlight map
 * an offset to a position without the two ever being confused.
 */
type LineSegment = {
  at: number;
  sourceLength: number;
  text: string;
  font: string;
  style: RunStyleValues;
  /**
   * The colour the run asked for, or `null` to take the block's fill. A run
   * that does not name a colour must keep the gradient, or recolouring one word
   * of a gradient title would knock every other word off it.
   */
  colorOverride: string | null;
  width: number;
  /** Where this segment starts, measured from the line's left edge. */
  dx: number;
};

/**
 * Word-wrap results, keyed by everything they depend on.
 *
 * The wrap is greedy and calls `measureText` once per word plus once per
 * committed line — text shaping, not arithmetic — and it was running on every
 * frame for every caption even though nothing it reads depends on the cursor.
 *
 * The key includes the *resolved* `ctx.font` rather than the element's
 * `fontname`, because the metrics baked into each entry belong to whichever
 * face the canvas actually picked. Measuring before a webfont has loaded would
 * otherwise pin the fallback's ascent/descent forever, and the caption
 * background box (which is sized from them) would come out wrong in export
 * while looking right in preview. `document.fonts` clears the cache when a
 * face arrives, so those entries are re-measured rather than trusted.
 */
const wrapCache = new Map<string, WrappedLine[]>();
const WRAP_CACHE_LIMIT = 512;

let fontsListenerAttached = false;
function watchFontLoads() {
  if (fontsListenerAttached || typeof document === "undefined") {
    return;
  }
  fontsListenerAttached = true;
  // Both caches. `styledWrapCache` holds metrics measured in whichever faces
  // its segments resolved to, so it goes stale on a face arriving for exactly
  // the reason `wrapCache` does, and it is declared further down this file
  // rather than here only because it belongs with the rest of the styled path.
  document.fonts?.addEventListener?.("loadingdone", () => {
    wrapCache.clear();
    styledWrapCache.clear();
  });
}

function cachedWrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  letterSpacing: string,
  maxSize: number,
): WrappedLine[] {
  watchFontLoads();

  // `\u0000` as an escape, never the raw byte. Written literally, three of
  // them landed in this file and `git` classified the whole module as
  // binary: no diff, no blame, no textual merge on the largest renderer
  // source in the tree. The escape is the same character at runtime.
  // `fx/overlaySource.ts` spells its own separator this way.
  const key = `${ctx.font}\u0000${letterSpacing}\u0000${width}\u0000${text}`;
  const hit = wrapCache.get(key);
  if (hit != null) {
    return hit;
  }

  const lines = getWrappedLines(ctx, text, width, maxSize);

  // Plain insertion-order eviction: animated text would otherwise grow this
  // without bound, one entry per distinct string it passes through.
  if (wrapCache.size >= WRAP_CACHE_LIMIT) {
    const oldest = wrapCache.keys().next().value;
    if (oldest !== undefined) {
      wrapCache.delete(oldest);
    }
  }
  wrapCache.set(key, lines);
  return lines;
}

function measureLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  at: number,
  maxSize: number,
): WrappedLine {
  const metrics = ctx.measureText(line);
  return {
    line,
    at,
    width: metrics.width,
    ascent: metrics.actualBoundingBoxAscent,
    descent: metrics.actualBoundingBoxDescent,
    maxSize,
    segments: null,
  };
}

/**
 * Greedy word wrap for one paragraph, appended to `out`.
 *
 * An empty paragraph still emits a line — `measureText("")` gives zero width,
 * ascent and descent, so it draws nothing but consumes a full line advance.
 * That is what makes a blank line between two paragraphs mean anything.
 */
function wrapParagraph(
  ctx: CanvasRenderingContext2D,
  paragraph: string,
  at: number,
  width: number,
  maxSize: number,
  out: WrappedLine[],
): void {
  const textSplited = paragraph.split(" ");
  let currentLine = textSplited[0];

  // Where the line being built starts, and where it currently ends, both in
  // the element's own string. `cursor` counts the separator each join puts
  // back, so the pair stays exact through a run of consecutive spaces.
  let lineAt = at;
  let cursor = at + textSplited[0].length;

  for (let i = 1; i < textSplited.length; i++) {
    const word = textSplited[i];
    const candidate = `${currentLine} ${word}`;
    const candidateMetrics = ctx.measureText(candidate);

    if (candidateMetrics.width < width) {
      currentLine += " " + word;
      cursor += 1 + word.length;
    } else {
      out.push(measureLine(ctx, currentLine, lineAt, maxSize));
      currentLine = word;
      // Past the space this break swallowed.
      lineAt = cursor + 1;
      cursor = lineAt + word.length;
    }
  }

  out.push(measureLine(ctx, currentLine, lineAt, maxSize));
}

/**
 * Every line the element draws: the author's breaks first, then the wrap.
 *
 * The two are different questions and only one of them is negotiable. A `\n`
 * says where a line ends whatever the box measures; the wrap only decides where
 * a line ends *because* the box ran out. Splitting first means a paragraph too
 * short to wrap still breaks, which is the case `text.split(" ")` alone can
 * never see.
 */
function getWrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  maxSize: number,
) {
  const lines: WrappedLine[] = [];
  for (const paragraph of splitParagraphsWithOffsets(text)) {
    wrapParagraph(ctx, paragraph.text, paragraph.at, width, maxSize, lines);
  }
  return lines;
}

/**
 * The canvas `font` shorthand for one face at one size.
 *
 * Lifted out of `layoutFor` so that a per-range override can ask for the same
 * string with different values, and so there is one place that knows the stack.
 *
 * The bundled Google Fonts are Latin-only, so a Korean caption set in one of
 * them would draw as tofu with the family alone. Naming `notosanskr` after it
 * makes the canvas fall through per *glyph* rather than per element, which is
 * what a font stack is for: the Latin comes out in the chosen face and the
 * Hangul in the built-in one. `wrapCache` keys on the resolved `ctx.font`, so
 * the metrics cached there belong to whichever faces actually got used.
 *
 * The weight comes from `fontWeightToken` rather than from `isBold` alone, and
 * for a static face it answers exactly what this used to say - see there for
 * why a picked weight must *not* be repeated to the canvas.
 */
function fontStringOf(
  fontname: string,
  fontweight: unknown,
  isItalic: boolean,
  isBold: boolean,
  fontSize: number,
): string {
  return `${isItalic ? "italic" : ""} ${fontWeightToken(
    fontname,
    fontweight,
    isBold,
  )} ${fontSize}px "${fontname}", notosanskr, sans-serif`;
}

/**
 * Set up `ctx.font` and `letterSpacing` for an element, and hand back the
 * measured lines.
 *
 * Shared by `renderText` and `measureTextBlock` so that the two can never
 * disagree about how tall a block is — rasterisation sizes its canvas from the
 * measurement and then calls the renderer, and a mismatch there crops glyphs.
 */
function layoutFor(ctx: CanvasRenderingContext2D, textElement: TextElementType) {
  const { width, fontsize: fontSize } = textElement;

  // `letterSpacing` is missing from the DOM types this repo's TypeScript ships
  // with, though every browser the app runs in supports it.
  const letterSpacing = `${textElement.letterSpacing}px`;
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
    letterSpacing;

  const font = fontStringOf(
    textElement.fontname,
    textElement.fontweight,
    textElement.options.isItalic === true,
    textElement.options.isBold === true,
    fontSize,
  );
  ctx.font = font;

  const runs = runsOf(textElement);

  // Case conversion happens *before* measurement: the wrap is greedy over
  // `measureText`, and "ABCDE" is wider than "abcde" in nearly every face.
  // Passing the transformed string on also means `wrapCache`'s key picks the
  // change up for free, since the key already contains the text.
  //
  // The styled branch transforms per segment instead, for the reason
  // `segmentsOf` gives, and is entered only when there is something to style.
  const lines =
    runs.length === 0
      ? cachedWrappedLines(
          ctx,
          displayTextOf(textElement),
          width,
          letterSpacing,
          fontSize ?? 0,
        )
      : cachedStyledLines(
          ctx,
          textElement,
          runs,
          elementRunStyle(textElement),
          resolveTextStyle(textElement).textTransform,
          width,
          letterSpacing,
        );

  // Back onto the element's own face. A cache miss above left `ctx.font` on the
  // last segment measured, and `fontDescentOf` below asks the *current* face
  // how far it hangs below the baseline.
  ctx.font = font;

  const baselines = baselinesOf(lines, textElement);

  // The advance comes from the type, never from the box. `element.height` used
  // to be handed back here, which made growing a text clip push its lines
  // apart instead of resizing it — see `text/metrics.ts`.
  return {
    lines,
    font,
    letterSpacing,
    baselines,
    firstBaseline: baselines[0],
    advance: meanAdvance(baselines, textElement),
    // The font's own descent rather than the last line's ink. A box measured
    // from the ink is shorter for "oo" than for "gg", so the element would
    // resize itself every time the final line's letters changed.
    //
    // Measured under the largest face on the *last* line, because that is what
    // hangs under the block. With one size everywhere that face is the
    // element's own and the number is the one this always returned.
    fontDescent: descentUnderLastLine(ctx, lines, font, fontSize ?? 0),
  };
}

/**
 * Where every line's baseline sits, in the element's own space.
 *
 * A list rather than the closed form `firstBaseline + advance * i` it replaces,
 * because a line carrying a larger per-range size needs more room under it.
 * The gap between two lines is driven by the **larger** of the pair: that is
 * what stops a 100px line's descenders landing in a 20px line's ascenders, and
 * it is the typographic convention besides.
 *
 * With one size everywhere it reduces to the closed form exactly, which is what
 * keeps a clip with no runs spacing its lines to the pixel it always did.
 */
function baselinesOf(
  lines: WrappedLine[],
  textElement: TextElementType,
): number[] {
  const lineHeight = normalizeLineHeight(textElement.options?.lineHeight);
  const out: number[] = [lines[0]?.maxSize ?? 0];

  for (let i = 1; i < lines.length; i += 1) {
    out.push(
      out[i - 1] +
        lineAdvanceForSize(
          Math.max(lines[i - 1].maxSize, lines[i].maxSize),
          lineHeight,
        ),
    );
  }

  return out;
}

/**
 * The average gap between baselines, for the one consumer that needs a scalar.
 *
 * `blockGradient` spans the whole block and takes its height as
 * `advance * lineCount`. The mean is that height divided the same way, and with
 * one size everywhere it *is* `lineAdvanceOf`, so a gradient on an unstyled
 * clip is the gradient it always was.
 */
function meanAdvance(
  baselines: number[],
  textElement: TextElementType,
): number {
  if (baselines.length < 2) {
    return lineAdvanceOf(textElement);
  }
  return (
    (baselines[baselines.length - 1] - baselines[0]) / (baselines.length - 1)
  );
}

/**
 * How far the face hangs below the baseline, in pixels.
 *
 * `fontBoundingBoxDescent` is a property of the *font at this size*, so it is
 * the same for every line and for every string. Hosts that do not report it
 * fall back to a quarter em, which is close enough for a box nobody measures
 * against.
 */
function fontDescentOf(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
): number {
  const descent = ctx.measureText("").fontBoundingBoxDescent;
  return Number.isFinite(descent) && descent > 0
    ? descent
    : fontSize * FALLBACK_DESCENT_RATIO;
}

/**
 * The descent under the block, measured in whichever face sits lowest.
 *
 * On a clip with no runs the last line has no segments and this is
 * `fontDescentOf` under the element's own font, unchanged. On a styled one the
 * largest type on the last line is what the box has to clear.
 *
 * Leaves `ctx.font` where it found it, because `layoutFor` hands that state on.
 */
function descentUnderLastLine(
  ctx: CanvasRenderingContext2D,
  lines: WrappedLine[],
  elementFont: string,
  fontSize: number,
): number {
  const last = lines[lines.length - 1];
  let widest: LineSegment | null = null;
  for (const segment of last?.segments ?? []) {
    if (widest == null || segment.style.fontsize > widest.style.fontsize) {
      widest = segment;
    }
  }

  if (widest == null) {
    return fontDescentOf(ctx, fontSize);
  }

  ctx.font = widest.font;
  const descent = fontDescentOf(ctx, widest.style.fontsize);
  ctx.font = elementFont;
  return descent;
}

/**
 * How tall the wrapped block is, and where its baselines fall.
 *
 * The source of truth for a text element's box. `element/textFit.ts` writes
 * this back as `height`, and rasterisation sizes its offscreen canvas from it —
 * the two agree because both come through `layoutFor`.
 *
 * Note the direction: the block is measured *from* the text, never the other
 * way round. Nothing here reads `element.height`.
 */
export function measureTextBlock(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
): { lineCount: number; blockHeight: number; firstBaseline: number } {
  const { lines, baselines, firstBaseline, fontDescent } = layoutFor(
    ctx,
    textElement,
  );

  return {
    lineCount: lines.length,
    // Baseline of the last line, plus the face's descent under it.
    blockHeight: baselines[baselines.length - 1] + fontDescent,
    firstBaseline,
  };
}

/**
 * Everything measurable about a text block, in the element's own space.
 *
 * `measureTextBlock` answers the three numbers `textFit` and rasterisation
 * need. This answers the ones a caller outside the editor needs in order to
 * lay type out without rendering it and looking: the widths, and — the whole
 * reason this exists — `capHeight` next to `emSize`.
 *
 * **`fontsize` is the em size, and it is not what you measure in a screenshot.**
 * It goes into `ctx.font` verbatim; nothing scales it. What a ruler finds on
 * screen is the ink, and for a Latin face the capitals are roughly three
 * quarters of the em — 57px of type measures about 43px of capital. Reporting
 * both is what turns "the size I asked for is wrong" into one division.
 */
export type TextBlockMetrics = {
  lines: Array<{
    text: string;
    /** Where `text[0]` sits in the element's own string. */
    at: number;
    width: number;
    ascent: number;
    descent: number;
  }>;
  /** The widest line. The wrap box is `element.width`, which can be wider. */
  blockWidth: number;
  blockHeight: number;
  firstBaseline: number;
  /** Baseline to baseline, averaged over the block. */
  lineAdvance: number;
  /** The number in `fontsize`, echoed so the two can be compared. */
  emSize: number;
  /** Cap height: the ink a capital H covers above the baseline. */
  capHeight: number;
};

/**
 * Measure a block without drawing it.
 *
 * Goes through `layoutFor`, so it wraps, transforms case and honours per-range
 * styling exactly as the draw does — the same guarantee `measureTextBlock`
 * gives rasterisation, for the same reason.
 */
export function measureTextDetail(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
): TextBlockMetrics {
  const { lines, baselines, firstBaseline, advance, fontDescent } = layoutFor(
    ctx,
    textElement,
  );

  // `layoutFor` leaves `ctx.font` on the element's own face, so this asks the
  // face the block is set in rather than whatever a run last measured.
  const capAscent = ctx.measureText("H").actualBoundingBoxAscent;

  return {
    lines: lines.map((wrapped) => ({
      text: wrapped.line,
      at: wrapped.at,
      width: wrapped.width,
      ascent: wrapped.ascent,
      descent: wrapped.descent,
    })),
    blockWidth: lines.reduce((widest, line) => Math.max(widest, line.width), 0),
    blockHeight: baselines[baselines.length - 1] + fontDescent,
    firstBaseline,
    lineAdvance: advance,
    emSize: textElement.fontsize,
    capHeight:
      Number.isFinite(capAscent) && capAscent > 0
        ? capAscent
        : // No metrics to ask — a host that reports nothing for the ink box.
          // Three quarters of the em is the ratio the common Latin faces sit
          // at, and it is better than reporting the em as if it were the ink.
          textElement.fontsize * 0.75,
  };
}

/**
 * One line's band, in the element's own space.
 *
 * A named shape because two passes need it and they run at different times: the
 * frost clips to the union of every band on the block, and the tint fills them
 * one at a time afterwards. Deriving the geometry twice is exactly how the
 * frosted region and the coloured one would come to disagree.
 */
type BandBox = { x: number; y: number; w: number; h: number };

/**
 * Append a band to the current path, corners and all.
 *
 * A radius past half the shorter side is not representable; clamping here turns
 * an over-large value into a stadium instead of a throw. `rect` rather than
 * `fillRect` at radius 0, because this one call has to serve a clip region as
 * well as a fill, and the two describe the same rectangle.
 */
function traceBand(
  ctx: CanvasRenderingContext2D,
  band: BandBox,
  radius: number,
): void {
  const r = Math.min(radius, band.w / 2, band.h / 2);
  if (r > 0) {
    ctx.roundRect(band.x, band.y, band.w, band.h, r);
  } else {
    ctx.rect(band.x, band.y, band.w, band.h);
  }
}


// ---------------------------------------------------------------- styled lines
//
// Everything from here to `layoutFor` runs only for a clip that carries runs.
// A clip without them never reaches any of it, which is the whole reason the
// two paths are separate rather than one path with a segment list of length
// one: `measureText` on a substring loses the kerning with the glyph before it
// (`paintRevealHead` says the same, below), so measuring a line in pieces
// cannot reproduce measuring it whole. Losing kerning at a boundary where the
// face or the size changes is unavoidable and is what a browser does across an
// inline box; losing it on a clip nobody has styled would be a regression.

/**
 * The runs, as a string, for the cache key.
 *
 * Canonical because `runsOf` sorts and merges and `RUN_STYLE_KEYS` fixes the
 * field order, so two equal run lists always produce one signature.
 */
function runsSignature(runs: readonly TextRun[]): string {
  let out = "";
  for (const run of runs) {
    out += `${run.from}:${run.to}:`;
    for (const key of RUN_STYLE_KEYS) {
      const value = run.style[key];
      if (value !== undefined) {
        out += `${key}=${String(value)},`;
      }
    }
    out += "|";
  }
  return out;
}

/** The case transform, applied to one piece rather than to the whole string. */
function transformed(
  source: string,
  transform: ResolvedTextStyle["textTransform"],
): string {
  switch (transform) {
    case "uppercase":
      return source.toUpperCase();
    case "lowercase":
      return source.toLowerCase();
    default:
      return source;
  }
}

/**
 * Cut `[from, to)` of the stored string into segments and measure each.
 *
 * Cuts fall at every run boundary inside the range, plus anything the caller
 * adds. The selection highlight adds its own ends, so a highlight edge is
 * always a segment edge and never needs an offset mapped inside a piece.
 *
 * **The case transform is applied per segment, not to the whole string.**
 * Transforming first and cutting afterwards would misplace every run after the
 * first length-changing character, silently.
 *
 * Leaves `ctx.font` on the last segment's face. A caller that goes on to
 * measure something of the element's own has to set it back.
 */
function segmentsOf(
  ctx: CanvasRenderingContext2D,
  body: string,
  runs: readonly TextRun[],
  base: RunStyleValues,
  transform: ResolvedTextStyle["textTransform"],
  from: number,
  to: number,
  extraCuts?: readonly number[],
): LineSegment[] {
  if (from >= to) {
    return [];
  }

  const cuts = new Set<number>([from, to]);
  for (const run of runs) {
    if (run.from > from && run.from < to) {
      cuts.add(run.from);
    }
    if (run.to > from && run.to < to) {
      cuts.add(run.to);
    }
  }
  for (const cut of extraCuts ?? []) {
    if (cut > from && cut < to) {
      cuts.add(cut);
    }
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const out: LineSegment[] = [];
  let dx = 0;
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const at = bounds[i];
    const end = bounds[i + 1];
    const override = runStyleAt(runs, at);
    const style = { ...base, ...override };
    const font = fontStringOf(
      style.fontname,
      style.fontweight,
      style.italic,
      style.bold,
      style.fontsize,
    );
    const text = transformed(body.slice(at, end), transform);
    ctx.font = font;
    const metrics = ctx.measureText(text);
    out.push({
      at,
      sourceLength: end - at,
      text,
      font,
      style,
      colorOverride: override.color ?? null,
      width: metrics.width,
      dx,
    });
    dx += metrics.width;
  }

  return out;
}

/** One measured styled line, from a range of the stored string. */
function measureStyledLine(
  ctx: CanvasRenderingContext2D,
  body: string,
  runs: readonly TextRun[],
  base: RunStyleValues,
  transform: ResolvedTextStyle["textTransform"],
  from: number,
  to: number,
): WrappedLine {
  const segments = segmentsOf(ctx, body, runs, base, transform, from, to);

  let width = 0;
  let ascent = 0;
  let descent = 0;
  let maxSize = base.fontsize;
  let line = "";
  for (const segment of segments) {
    ctx.font = segment.font;
    const metrics = ctx.measureText(segment.text);
    width += segment.width;
    ascent = Math.max(ascent, metrics.actualBoundingBoxAscent);
    descent = Math.max(descent, metrics.actualBoundingBoxDescent);
    maxSize = Math.max(maxSize, segment.style.fontsize);
    line += segment.text;
  }

  return { line, at: from, width, ascent, descent, maxSize, segments };
}

/** The greedy wrap again, measuring each candidate in its own faces. */
function wrapStyledParagraph(
  ctx: CanvasRenderingContext2D,
  body: string,
  runs: readonly TextRun[],
  base: RunStyleValues,
  transform: ResolvedTextStyle["textTransform"],
  at: number,
  paragraph: string,
  width: number,
  out: WrappedLine[],
): void {
  const words = paragraph.split(" ");
  let lineAt = at;
  let cursor = at + words[0].length;

  for (let i = 1; i < words.length; i += 1) {
    const candidateEnd = cursor + 1 + words[i].length;
    const candidate = segmentsOf(
      ctx,
      body,
      runs,
      base,
      transform,
      lineAt,
      candidateEnd,
    );
    // The same `<` against the same width the unstyled wrap uses, so a line
    // breaks in the same place when every segment happens to agree.
    const candidateWidth = candidate.reduce((sum, seg) => sum + seg.width, 0);

    if (candidateWidth < width) {
      cursor = candidateEnd;
    } else {
      out.push(
        measureStyledLine(ctx, body, runs, base, transform, lineAt, cursor),
      );
      lineAt = cursor + 1;
      cursor = lineAt + words[i].length;
    }
  }

  out.push(measureStyledLine(ctx, body, runs, base, transform, lineAt, cursor));
}

/**
 * The styled wrap, cached.
 *
 * A second map rather than a widened key on `wrapCache`, so the unstyled path
 * keeps its key, its eviction and its hit rate exactly. Both are emptied by the
 * same `loadingdone` listener.
 */
const styledWrapCache = new Map<string, WrappedLine[]>();

function cachedStyledLines(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
  runs: readonly TextRun[],
  base: RunStyleValues,
  transform: ResolvedTextStyle["textTransform"],
  width: number,
  letterSpacing: string,
): WrappedLine[] {
  watchFontLoads();

  const body = textElement.text ?? "";
  // The element's own font is in `ctx.font` here and belongs in the key for the
  // reason the unstyled key holds it: the metrics cached below belong to
  // whichever faces the canvas actually resolved. The separator is an escape
  // and never the raw byte, for the reason `cachedWrappedLines` gives.
  const key = `${ctx.font}\u0000${letterSpacing}\u0000${width}\u0000${transform}\u0000${runsSignature(
    runs,
  )}\u0000${body}`;
  const hit = styledWrapCache.get(key);
  if (hit != null) {
    return hit;
  }

  const lines: WrappedLine[] = [];
  for (const paragraph of splitParagraphsWithOffsets(body)) {
    wrapStyledParagraph(
      ctx,
      body,
      runs,
      base,
      transform,
      paragraph.at,
      paragraph.text,
      width,
      lines,
    );
  }

  if (styledWrapCache.size >= WRAP_CACHE_LIMIT) {
    const oldest = styledWrapCache.keys().next().value;
    if (oldest !== undefined) {
      styledWrapCache.delete(oldest);
    }
  }
  styledWrapCache.set(key, lines);
  return lines;
}

/** How far into the drawn line `chars` drawn characters reach. */
function prefixWidthOfDrawn(
  ctx: CanvasRenderingContext2D,
  segments: readonly LineSegment[],
  chars: number,
): number {
  let consumed = 0;
  for (const segment of segments) {
    if (chars <= consumed) {
      return segment.dx;
    }
    if (chars >= consumed + segment.text.length) {
      consumed += segment.text.length;
      continue;
    }
    ctx.font = segment.font;
    return (
      segment.dx + ctx.measureText(segment.text.slice(0, chars - consumed)).width
    );
  }
  const last = segments[segments.length - 1];
  return last == null ? 0 : last.dx + last.width;
}

/**
 * How far into the drawn line a **stored-string** offset reaches.
 *
 * Exact wherever the case transform left the segment's length alone, which is
 * every transform on every ordinary string. Where it did not, the offset snaps
 * to the segment's start: a highlight edge a few glyphs out is better than a
 * mapping that is confidently wrong, and the selection highlight adds its own
 * ends as cuts so the case does not arise for it at all.
 */
function prefixWidthOfSource(
  ctx: CanvasRenderingContext2D,
  segments: readonly LineSegment[],
  offset: number,
): number {
  for (const segment of segments) {
    if (offset <= segment.at) {
      return segment.dx;
    }
    if (offset >= segment.at + segment.sourceLength) {
      continue;
    }
    if (segment.text.length !== segment.sourceLength) {
      return segment.dx;
    }
    ctx.font = segment.font;
    return (
      segment.dx +
      ctx.measureText(segment.text.slice(0, offset - segment.at)).width
    );
  }
  const last = segments[segments.length - 1];
  return last == null ? 0 : last.dx + last.width;
}

/** The first `chars` drawn characters of a line, as segments. */
function sliceSegments(
  segments: readonly LineSegment[],
  chars: number,
): LineSegment[] {
  const out: LineSegment[] = [];
  let consumed = 0;
  for (const segment of segments) {
    if (chars <= consumed) {
      break;
    }
    const take = Math.min(segment.text.length, chars - consumed);
    out.push(
      take === segment.text.length
        ? segment
        : { ...segment, text: segment.text.slice(0, take) },
    );
    consumed += segment.text.length;
  }
  return out;
}

/** Where one line's lettering and band go. */
type LinePlacement = {
  wrapped: WrappedLine;
  /** What of the line has arrived, or `null` when nothing is being revealed. */
  cut: LineReveal | null;
  baselineY: number;
  /** Where the lettering is drawn from, under `align`. */
  drawX: number;
  align: CanvasTextAlign;
  /** `null` for a line that draws no band: a blank one, or the background off. */
  band: BandBox | null;
};

/**
 * Every line that draws anything, placed — the layout decision for the whole
 * block, taken before a single pixel is committed.
 *
 * Pulled out of the drawing loop because the frost has to see all the bands
 * before the first of them is painted. Pure, and node-tested through the
 * renderer suites: it reads the measured lines and the style, never `ctx`.
 *
 * A line whose reveal has not started yet is **absent** rather than present and
 * empty — not even the band behind it, which belongs to the line rather than to
 * the block. `baselineY` comes from the line's index, so the advance is taken
 * for it regardless and the lines below stay where they will be.
 */
function placeLines(
  lines: WrappedLine[],
  plan: (LineReveal | null)[] | null,
  style: ResolvedTextStyle,
  align: "left" | "center" | "right",
  width: number,
  baselines: number[],
): LinePlacement[] {
  const pad = style.background.padding;
  const placements: LinePlacement[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const wrapped = lines[lineIndex];
    const cut = plan == null ? null : plan[lineIndex];
    // Nothing of this line has arrived yet: no band, no frost, no draw.
    if (cut != null && cut.chars <= 0 && cut.heads.length === 0) {
      continue;
    }

    const styled = wrapped.segments != null;
    const baselineY = baselines[lineIndex];
    let textX: number;
    let backgroundX: number;
    switch (align) {
      case "center":
        textX = width / 2;
        backgroundX = textX - wrapped.width / 2 - pad;
        break;
      case "right":
        textX = width;
        backgroundX = textX - wrapped.width - pad;
        break;
      default:
        textX = 0;
        backgroundX = -pad;
    }

    placements.push({
      wrapped,
      cut,
      baselineY,
      // While revealing, the lettering is drawn from the line's left edge with
      // `textAlign: "left"` rather than from its alignment anchor. Drawing a
      // prefix at a centre or right anchor re-centres it every frame, so the
      // text creeps sideways as it types and no glyph is ever where it will end
      // up — the defect Premiere's Source Text keyframing has. `backgroundX +
      // pad` is already the full line's left edge under all three alignments,
      // so the coordinate costs nothing to find.
      //
      // A styled line needs the same coordinate for a different reason: its
      // pieces are drawn one after another at explicit offsets, and an anchor
      // can only place one of them. So it reuses the mechanism rather than
      // inventing a second one.
      drawX: cut == null && !styled ? textX : backgroundX + pad,
      align: cut == null && !styled ? align : "left",
      // Mid-reveal the band is placed at the **full** line's width, from the
      // full line's metrics: a band is a layout element, not something that
      // types. One that grew with the lettering would redraw at a new size every
      // frame and, under centre alignment, grow in both directions at once — so
      // it appears whole with the line's first unit and then holds still.
      //
      // A blank line gets none. Its width, ascent and descent are all zero, so
      // the band would come out as a bare `2 * padding` square floating in the
      // gap — and, having no width to align against, it would sit under the left
      // edge, the centre or the right edge depending on `align`.
      band:
        style.background.enable && wrapped.line !== ""
          ? {
              x: backgroundX,
              y: baselineY - wrapped.ascent - pad,
              w: wrapped.width + pad * 2,
              h: wrapped.ascent + wrapped.descent + pad * 2,
            }
          : null,
    });
  }

  return placements;
}

/**
 * One run of lettering: the shadow silhouette's glow and drop shadow, then the
 * outline stroke, then the fill.
 *
 * Factored out of the line loop because a reveal's fading head draws the *same*
 * run a second time, under a clip and at a lower alpha. Two copies of this
 * sequence would drift apart the first time an effect was added to one of them,
 * and the head would silently lose its glow.
 *
 * The caller owns `ctx.save()`/`restore()` and `globalAlpha`.
 */
function paintLettering(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: ResolvedTextStyle,
  fill: string | CanvasGradient,
): void {
  // The silhouette a shadow should be cast from. With an outline on, that is
  // the stroke — it encloses the fill, so the fill's own shadow would be
  // hidden behind it anyway.
  const castShape = () => {
    if (style.outline.enable) {
      ctx.lineWidth = style.outline.size;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = "#000000";
    ctx.fillText(text, x, y);
  };

  // 2. Glow — a shadow with no offset, so it haloes evenly.
  if (style.glow.enable) {
    paintShadowOnly(ctx, castShape, {
      offsetX: 0,
      offsetY: 0,
      blur: style.glow.size,
      color: withAlpha(style.glow.color, style.glow.opacity),
    });
  }

  // 3. Drop shadow.
  if (style.shadow.enable) {
    paintShadowOnly(ctx, castShape, {
      offsetX: style.shadow.offsetX,
      offsetY: style.shadow.offsetY,
      blur: style.shadow.blur,
      color: withAlpha(style.shadow.color, style.shadow.opacity),
    });
  }

  // 4/5. The lettering itself, painted exactly once. `paintShadowOnly` left
  //      no body behind, so the caller's alpha is not applied twice over.
  if (style.outline.enable) {
    ctx.lineWidth = style.outline.size;
    ctx.strokeStyle = withAlpha(style.outline.color, style.outline.opacity);
    ctx.strokeText(text, x, y);
  }

  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/**
 * The one unit that is currently fading in, drawn over the settled prefix.
 *
 * Two things about it are deliberate.
 *
 * **The whole prefix is drawn and then clipped away**, rather than just the
 * head's own characters being drawn on their own. `measureText` on a substring
 * loses the kerning between the head and the glyph before it, so a separately
 * positioned head would slide by a fraction of a pixel as it settled — visible
 * precisely because the eye is already watching that glyph.
 *
 * **Only the left edge of the clip has to be exact.** Nothing past the head is
 * painted, so the right edge is taken generously from the full line rather than
 * measured, and the head keeps its own glow and shadow.
 */
function paintRevealHead(
  ctx: CanvasRenderingContext2D,
  line: string,
  head: RevealHead,
  x: number,
  y: number,
  lineWidth: number,
  ascent: number,
  descent: number,
  style: ResolvedTextStyle,
  fill: string | CanvasGradient,
): void {
  // `measureText` of the prefix is where the next glyph starts — letter
  // spacing is applied *after* each character, so it is already included.
  const from =
    head.from === 0 ? 0 : ctx.measureText(line.slice(0, head.from)).width;
  const to = ctx.measureText(line.slice(0, head.to)).width;
  const bleed = styleBleed(style);

  ctx.save();
  applyHeadMove(ctx, head, x + from, x + to, y, ascent, descent);
  ctx.beginPath();
  ctx.rect(
    x + from,
    y - ascent - bleed,
    lineWidth - from + bleed * 2,
    ascent + descent + bleed * 2,
  );
  ctx.clip();
  ctx.globalAlpha *= head.alpha;
  paintLettering(ctx, line.slice(0, head.to), x, y, style, fill);
  ctx.restore();
}

/**
 * Move the canvas so one arriving unit is drawn where the animator wants it.
 *
 * **The transform goes on before the clip, and both are in the same space.**
 * That is what makes this work at all. The unit is drawn by painting the whole
 * prefix and clipping to the unit's own band — the trick `paintRevealHead` has
 * always used, because `measureText` on a substring loses the kerning with the
 * glyph before it and a separately positioned unit would slide by a fraction of
 * a pixel as it settled, visibly, precisely because the eye is watching that
 * glyph.
 *
 * Under a transform the neighbours move too, but so does the band, and a
 * uniform scale about the unit's own centre preserves every distance from that
 * centre proportionally — so a neighbour that was outside the band stays
 * outside it. Nothing bleeds in, and the kerning is the font's own throughout.
 *
 * The blur is the one part that is not in element space: `ctx.filter` is
 * measured in device pixels, like the canvas shadow API, so it is pushed
 * through the matrix by the same `matrixScale` the drop shadow uses.
 */
function applyHeadMove(
  ctx: CanvasRenderingContext2D,
  head: RevealHead,
  left: number,
  right: number,
  baseline: number,
  ascent: number,
  descent: number,
): void {
  const move = head.move;
  if (move == null) {
    return;
  }

  // The unit's own centre: the middle of its advance, and the middle of the
  // band it occupies. Scaling and rotating about anything else would swing the
  // unit out of its own slot.
  const cx = (left + right) / 2;
  const cy = baseline - ascent / 2 + descent / 2;

  ctx.translate(move.offsetX, move.offsetY);
  ctx.translate(cx, cy);
  if (move.rotationDeg !== 0) {
    ctx.rotate((move.rotationDeg * Math.PI) / 180);
  }
  if (move.scale !== 1) {
    ctx.scale(move.scale, move.scale);
  }
  ctx.translate(-cx, -cy);

  if (move.blur > 0) {
    const scale = matrixScale(ctx.getTransform());
    if (Number.isFinite(scale) && scale > 0) {
      ctx.filter = `blur(${move.blur * scale}px)`;
    }
  }
}


/**
 * The same sequence, for a line drawn in pieces.
 *
 * Two things differ from `paintLettering`, and both are deliberate.
 *
 * **All the strokes, then all the fills**, rather than stroke-and-fill per
 * piece. `paintLettering` strokes the whole line and then fills the whole line,
 * so an outline can never cover a neighbouring glyph's interior; interleaving
 * would break that at every boundary, visibly with italics or tight tracking.
 *
 * **One shadow pass for the whole line**, cast from the union of the pieces.
 * A pass per piece would put each piece's shadow on its neighbour's glyphs and
 * would darken every overlap twice.
 *
 * Glow, drop shadow and the outline's opacity stay properties of the clip: they
 * are outside the per-range vocabulary, so `style` answers for them throughout.
 */
function paintStyledLettering(
  ctx: CanvasRenderingContext2D,
  segments: readonly LineSegment[],
  x: number,
  y: number,
  style: ResolvedTextStyle,
  fill: string | CanvasGradient,
): void {
  const castShape = () => {
    for (const segment of segments) {
      if (!segment.style.outlineEnable) {
        continue;
      }
      ctx.font = segment.font;
      ctx.lineWidth = segment.style.outlineSize;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(segment.text, x + segment.dx, y);
    }
    ctx.fillStyle = "#000000";
    for (const segment of segments) {
      ctx.font = segment.font;
      ctx.fillText(segment.text, x + segment.dx, y);
    }
  };

  // 2. Glow: a shadow with no offset, so it haloes evenly.
  if (style.glow.enable) {
    paintShadowOnly(ctx, castShape, {
      offsetX: 0,
      offsetY: 0,
      blur: style.glow.size,
      color: withAlpha(style.glow.color, style.glow.opacity),
    });
  }

  // 3. Drop shadow.
  if (style.shadow.enable) {
    paintShadowOnly(ctx, castShape, {
      offsetX: style.shadow.offsetX,
      offsetY: style.shadow.offsetY,
      blur: style.shadow.blur,
      color: withAlpha(style.shadow.color, style.shadow.opacity),
    });
  }

  // 4. Every outline.
  for (const segment of segments) {
    if (!segment.style.outlineEnable) {
      continue;
    }
    ctx.font = segment.font;
    ctx.lineWidth = segment.style.outlineSize;
    ctx.strokeStyle = withAlpha(
      segment.style.outlineColor,
      style.outline.opacity,
    );
    ctx.strokeText(segment.text, x + segment.dx, y);
  }

  // 5. Every fill. A piece that names no colour of its own takes the block's,
  //    so one recoloured word does not knock the rest off a gradient.
  for (const segment of segments) {
    ctx.font = segment.font;
    ctx.fillStyle = segment.colorOverride ?? fill;
    ctx.fillText(segment.text, x + segment.dx, y);
  }
}

/** The widest stroke on a line, for the clip a fading head needs. */
function segmentsBleed(
  segments: readonly LineSegment[],
  style: ResolvedTextStyle,
): number {
  let widest = 0;
  for (const segment of segments) {
    if (segment.style.outlineEnable) {
      widest = Math.max(widest, segment.style.outlineSize);
    }
  }
  return styleBleed(style, widest);
}

/** `paintRevealHead`, for a line drawn in pieces. */
function paintStyledRevealHead(
  ctx: CanvasRenderingContext2D,
  segments: readonly LineSegment[],
  head: RevealHead,
  x: number,
  y: number,
  lineWidth: number,
  ascent: number,
  descent: number,
  style: ResolvedTextStyle,
  fill: string | CanvasGradient,
): void {
  const from = head.from === 0 ? 0 : prefixWidthOfDrawn(ctx, segments, head.from);
  const to = prefixWidthOfDrawn(ctx, segments, head.to);
  const bleed = segmentsBleed(segments, style);

  ctx.save();
  applyHeadMove(ctx, head, x + from, x + to, y, ascent, descent);
  ctx.beginPath();
  ctx.rect(
    x + from,
    y - ascent - bleed,
    lineWidth - from + bleed * 2,
    ascent + descent + bleed * 2,
  );
  ctx.clip();
  ctx.globalAlpha *= head.alpha;
  paintStyledLettering(ctx, sliceSegments(segments, head.to), x, y, style, fill);
  ctx.restore();
}

export const renderText: ElementRenderFunction<TextElementType> = (
  ctx,
  elementId,
  textElement,
  timelineCursor,
  backdrop,
) => {
  paintText(ctx, textElement, timelineCursor, backdrop, false);
};

/**
 * The clip's lettering again, with nothing behind it.
 *
 * The preview's selection highlight draws a wash and then calls this, so the
 * glyphs end up on top of it and the range reads the way a browser's
 * `::selection` does. Band, frost, glow and drop shadow are left out: they are
 * already on the canvas from the composite, and drawing them a second time
 * would darken every overlap and paint the band over the wash that is the whole
 * point.
 *
 * Same layout and the same reveal as the real draw, because it is the same
 * function. A second implementation would drift the first time anything moved.
 */
export function paintTextGlyphsOnly(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
  timelineCursor: number,
): void {
  paintText(ctx, textElement, timelineCursor, undefined, true);
}

function paintText(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
  timelineCursor: number,
  backdrop: Parameters<ElementRenderFunction<TextElementType>>[4],
  glyphsOnly: boolean,
): void {
  const { width } = textElement;
  const style = resolveTextStyle(textElement);
  // `advance` comes from `layoutFor` rather than from `textElement.height`, so
  // there is exactly one place in this file that decides line spacing.
  const { lines, font, baselines, firstBaseline, advance } = layoutFor(
    ctx,
    textElement,
  );

  // The reveal is resolved *after* layout and never before it. `layoutFor`
  // caches its wrapped lines under a key holding the whole string, so wrapping
  // a growing prefix would miss that cache on every frame — and, worse, re-flow
  // the text as each word arrived. See `text/reveal.ts`.
  //
  // A progress of 100 takes the same path as no reveal at all, so a clip that
  // has finished typing costs nothing and draws byte-identically to one that
  // was never revealed.
  const reveal = revealOf(textElement);
  const progress =
    reveal == null
      ? 100
      : sampledRevealProgress(textElement, reveal, timelineCursor);
  const plan =
    reveal == null || progress >= 100
      ? null
      : revealPlan(
          lines.map((wrapped) => wrapped.line),
          reveal.unit,
          progress,
          reveal.fade,
          reveal.animate ?? null,
        );

  ctx.lineWidth = 0;

  // One gradient for the whole block rather than one per line: a per-line
  // gradient restarts at every line break, so a two-line title would run
  // white→purple twice instead of once down the block.
  const fill =
    style.fill.type === "gradient"
      ? blockGradient(ctx, style.fill, width, firstBaseline, advance, lines.length)
      : textElement.textcolor;

  const placements = placeLines(
    lines,
    plan,
    style,
    textElement.options.align,
    width,
    baselines,
  );

  // 0. The frost: what is *behind* the bands, blurred, before anything of this
  //    clip is painted over it. `background.blur` is a backdrop blur — CSS's
  //    `backdrop-filter`, frosted glass — so unlike every other property here
  //    it is a function of the picture rather than of the element, and
  //    `renderer/backdrop.ts` holds the whole mechanism.
  //
  //    **One pass over the union of the bands, not one pass per band.** At the
  //    default padding a multi-line caption's bands already overlap by a few
  //    pixels — the box is `ascent + descent + 2 * padding` tall against an
  //    advance of `1.2 * fontsize` — and frosting them one at a time would
  //    blur the first band's tint into the second's glass, on the fast path
  //    only, since the isolated path draws onto a layer the backdrop cannot
  //    see. Frosting the union reads the backdrop exactly once, so both paths
  //    render the same picture. It is also the cheaper of the two: one blurred
  //    blit per clip rather than one per line.
  if (!glyphsOnly && style.background.enable && style.background.blur > 0) {
    frostBackdrop(ctx, backdrop, style.background.blur, (target) => {
      let traced = false;
      for (const placement of placements) {
        if (placement.band == null) {
          continue;
        }
        traceBand(target, placement.band, style.background.radius);
        traced = true;
      }
      return traced;
    });
  }

  const textAlignOrigin = ctx.textAlign;

  for (const placement of placements) {
    const { wrapped, cut, baselineY: textY, drawX, band } = placement;
    const {
      line,
      width: lineWidth,
      ascent: lineAscent,
      descent: lineDescent,
    } = wrapped;
    ctx.textAlign = placement.align;

    // 1. The band's own colour, over the frost. Drawn before the glow and the
    //    shadow so it sits under them, and deliberately outside the
    //    `textOpacity` group — that setting fades the lettering, not the box
    //    behind it. A translucent colour here is the tint on the glass, which
    //    is what makes a frosted caption readable rather than merely blurry.
    if (band != null && !glyphsOnly) {
      ctx.fillStyle = withAlpha(
        style.background.color,
        style.background.opacity,
      );
      ctx.beginPath();
      traceBand(ctx, band, style.background.radius);
      ctx.fill();
    }

    ctx.save();
    ctx.globalAlpha *= style.textOpacity / 100;

    // Cast once by the composite already. Repeating them here would darken
    // every place two glyphs' haloes meet, and the highlight would read as a
    // smudge rather than as a wash.
    const linePaint = glyphsOnly ? withoutCastShadowsOf(style) : style;

    // 2-5. Glow, drop shadow, outline stroke, fill — of the whole line, or of
    //      the part of it that has arrived.
    //
    //      `segments == null` is the path a clip with no runs takes, and it is
    //      the original one: one `strokeText` and one `fillText` for the line,
    //      at its alignment anchor, with the kerning the face asked for.
    if (wrapped.segments == null) {
      paintLettering(
        ctx,
        cut == null ? line : line.slice(0, cut.chars),
        drawX,
        textY,
        linePaint,
        fill,
      );
    } else {
      paintStyledLettering(
        ctx,
        cut == null
          ? wrapped.segments
          : sliceSegments(wrapped.segments, cut.chars),
        drawX,
        textY,
        linePaint,
        fill,
      );
    }

    // 6. The units still arriving: fading in, and moving if the reveal carries
    //    an animator. Without one there is at most one of them, which is the
    //    bound `TextReveal.fade` documents; `animate.window` is the only thing
    //    that lifts it, and it costs one clipped pass per unit in flight.
    //
    //    Drawn in the order the plan lists them, earliest first, so a later
    //    unit's larger scale overlaps its neighbour rather than being cut by
    //    it — which is the way the eye reads a stagger arriving.
    for (const head of cut?.heads ?? []) {
      if (wrapped.segments == null) {
        paintRevealHead(
          ctx,
          line,
          head,
          drawX,
          textY,
          lineWidth,
          lineAscent,
          lineDescent,
          linePaint,
          fill,
        );
      } else {
        paintStyledRevealHead(
          ctx,
          wrapped.segments,
          head,
          drawX,
          textY,
          lineWidth,
          lineAscent,
          lineDescent,
          linePaint,
          fill,
        );
      }
    }
    ctx.restore();
  }
  ctx.textAlign = textAlignOrigin;
  // A styled line left the last segment's face on the context. Putting the
  // element's own back means both paths hand the same state to whatever draws
  // next, which is what lets a caller measure after a draw without knowing
  // whether the clip carried runs.
  ctx.font = font;
}

/** The same style with the two passes the composite already made turned off. */
const shadowlessCache = new WeakMap<ResolvedTextStyle, ResolvedTextStyle>();
function withoutCastShadowsOf(style: ResolvedTextStyle): ResolvedTextStyle {
  const cached = shadowlessCache.get(style);
  if (cached != null) {
    return cached;
  }
  const next: ResolvedTextStyle = {
    ...style,
    glow: { ...style.glow, enable: false },
    shadow: { ...style.shadow, enable: false },
  };
  shadowlessCache.set(style, next);
  return next;
}

/**
 * Where a range of the stored string lands on the canvas, one rect per line.
 *
 * Reads the same layout the draw does, so the rects sit on the glyphs rather
 * than near them. `ctx` has to be the one that will draw the element, and is
 * left exactly as it was found.
 *
 * Answers nothing rather than something wrong in the one case it cannot map: a
 * clip with no runs whose case transform changed the string's length. The
 * offsets on its lines then index the transformed string and a run's do not,
 * and an approximate highlight on an unusual string is worse than none.
 */
export function selectionRectsOf(
  ctx: CanvasRenderingContext2D,
  textElement: TextElementType,
  from: number,
  to: number,
): HighlightRect[] {
  const body = textElement.text ?? "";
  const range = snapRange(body, from, to);
  if (range == null) {
    return [];
  }

  const fontOrigin = ctx.font;
  const alignOrigin = ctx.textAlign;
  const style = resolveTextStyle(textElement);
  const runs = runsOf(textElement);

  if (runs.length === 0 && displayTextOf(textElement).length !== body.length) {
    return [];
  }

  const { lines, font, baselines } = layoutFor(ctx, textElement);
  const base = elementRunStyle(textElement);
  const width = textElement.width;
  const align = textElement.options.align;

  const out: HighlightRect[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const segments: readonly LineSegment[] =
      line.segments ??
      [
        {
          at: line.at,
          sourceLength: line.line.length,
          text: line.line,
          font,
          style: base,
          colorOverride: null,
          width: line.width,
          dx: 0,
        },
      ];
    if (segments.length === 0) {
      continue;
    }

    const last = segments[segments.length - 1];
    const lineFrom = segments[0].at;
    const lineTo = last.at + last.sourceLength;
    const start = Math.max(range.from, lineFrom);
    const end = Math.min(range.to, lineTo);
    if (start >= end) {
      continue;
    }

    // The line's left edge under its alignment. `placeLines` derives the same
    // coordinate for the background band, from the same two numbers.
    let left: number;
    switch (align) {
      case "center":
        left = width / 2 - line.width / 2;
        break;
      case "right":
        left = width - line.width;
        break;
      default:
        left = 0;
    }

    const x0 = prefixWidthOfSource(ctx, segments, start);
    const x1 = prefixWidthOfSource(ctx, segments, end);
    out.push({
      x: left + x0,
      y: baselines[i] - line.ascent,
      w: x1 - x0,
      h: line.ascent + line.descent,
    });
  }

  ctx.font = fontOrigin;
  ctx.textAlign = alignOrigin;
  return out;
}

/**
 * A linear gradient spanning the whole wrapped block, at an arbitrary angle.
 *
 * 0° runs left to right and the angle turns clockwise, matching CSS
 * `linear-gradient`'s sense so that the panel's preview swatch and the canvas
 * agree. The endpoints are projected onto the block's bounding box so that the
 * full colour range is visible whatever the angle.
 */
function blockGradient(
  ctx: CanvasRenderingContext2D,
  fill: { from: string; to: string; angle: number },
  width: number,
  firstBaseline: number,
  advance: number,
  lineCount: number,
): CanvasGradient {
  const top = firstBaseline - advance;
  const blockHeight = Math.max(1, advance * lineCount);
  const cx = width / 2;
  const cy = top + blockHeight / 2;

  const radians = (fill.angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  // Half the box's extent along the gradient direction — the support of the
  // projection, so neither end colour is clipped off.
  const half = (Math.abs(dx) * width + Math.abs(dy) * blockHeight) / 2;

  const gradient = ctx.createLinearGradient(
    cx - dx * half,
    cy - dy * half,
    cx + dx * half,
    cy + dy * half,
  );
  gradient.addColorStop(0, fill.from);
  gradient.addColorStop(1, fill.to);
  return gradient;
}
