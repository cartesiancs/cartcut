/**
 * Showing a text clip's lettering a piece at a time.
 *
 * The typewriter is one setting of this, not a feature of its own: a reveal is
 * a single continuous scalar — *how much is shown* — plus a `unit` saying what
 * that scalar counts. Typing a title is two keyframes on the scalar with
 * `unit: "character"`; a line-by-line lyric card is the same two keyframes with
 * `unit: "line"`; holding, reversing or stuttering is whatever curve the user
 * draws, and none of it is special-cased anywhere.
 *
 * Three rules hold the module together.
 *
 * - **The scalar stays continuous; the rounding happens here.** The animation
 *   system has no stepped keyframe type and should not grow one — a progress
 *   that could not be eased would make every preset and every handle
 *   meaningless. So the curve keeps its shape and only what reaches the glyphs
 *   is quantised, which is the rule `transform.ts#MIN_SAMPLED_SCALE` and
 *   `mask/sample.ts`'s feather floor already state.
 * - **The answer is always a character offset**, whatever the unit. The
 *   renderer knows how to slice a string and nothing else; `character`, `word`
 *   and `line` differ only in where a cut is *allowed* to fall. Adding a fourth
 *   unit is a change to this file alone.
 * - **A cut never lands inside a grapheme.** `line.split("")` halves an emoji
 *   and separates a combining mark from its base, and both look like a font
 *   bug rather than a reveal. `Intl.Segmenter` decides, which is also the only
 *   way `word` can mean anything in Japanese or Chinese, where there are no
 *   spaces to split on.
 *
 * DOM-free and store-free, like `style.ts`, `lines.ts` and `metrics.ts`: it
 * runs under `environment: "node"`.
 */

import type {
  RevealUnit,
  TextReveal,
  TimelineElement,
} from "../../@types/timeline";
import { REVEAL_UNITS } from "../../@types/timeline";
import { sampleTrack } from "../animation/keyframes";

/** `O(1)` membership, built once. */
const KNOWN_UNITS = new Set<string>(REVEAL_UNITS);

/**
 * Fully shown.
 *
 * The inert value on purpose: switching a reveal on and touching nothing else
 * must leave the frame exactly as it was, so that the feature announces itself
 * with a panel rather than by making the user's text disappear.
 */
export const DEFAULT_REVEAL_PROGRESS = 100;

/** A hard cut. Also the value that *deletes* the field. */
export const DEFAULT_REVEAL_FADE = 0;

/**
 * The part of one unit that is on screen but not yet at full strength.
 *
 * `from`/`to` are character offsets into the line, so the renderer can clip to
 * exactly that unit's advance without measuring anything else.
 */
export type RevealHead = { from: number; to: number; alpha: number };

/**
 * What to draw of one wrapped line.
 *
 * `chars` is a character offset: `line.slice(0, chars)` is drawn whole. `head`,
 * when present, names the one unit that is currently fading in.
 */
export type LineReveal = { chars: number; head: RevealHead | null };

/** A fresh reveal for a unit, allocated every call. */
export function defaultReveal(unit: RevealUnit): TextReveal {
  return { unit, progress: DEFAULT_REVEAL_PROGRESS };
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 0-100, defaulted rather than refused.
 *
 * Exported because the sampler needs it too: an overshooting curve is
 * *supposed* to leave the range between its keyframes, and a progress of 130
 * would index past the last unit. Falling back to "fully shown" rather than to
 * "hidden" is deliberate — a broken curve should never eat the text.
 */
export function clampRevealProgress(value: unknown): number {
  const n = finiteNumber(value);
  return n == null ? DEFAULT_REVEAL_PROGRESS : Math.min(100, Math.max(0, n));
}

function clampFade(value: unknown): number {
  const n = finiteNumber(value);
  return n == null ? DEFAULT_REVEAL_FADE : Math.min(1, Math.max(0, n));
}

/**
 * The read guard. Runs inside the paint loop, once per text clip per frame, and
 * must never throw.
 *
 * The one deliberate asymmetry with `coerceReveal`: this defaults a missing or
 * unreadable number, that one refuses it.
 */
export function revealOf(
  element: TimelineElement | undefined | null,
): TextReveal | null {
  const raw = (element as { reveal?: unknown } | undefined | null)?.reveal;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { unit, progress, fade } = raw as Record<string, unknown>;
  if (typeof unit !== "string" || !KNOWN_UNITS.has(unit)) {
    return null;
  }
  const next: TextReveal = {
    unit: unit as RevealUnit,
    progress: clampRevealProgress(progress),
  };
  const softness = clampFade(fade);
  if (softness > 0) {
    next.fade = softness;
  }
  return next;
}

/** Exact match only. Anything else is a write the caller should report. */
export function coerceRevealUnit(value: unknown): RevealUnit | null {
  return typeof value === "string" && KNOWN_UNITS.has(value)
    ? (value as RevealUnit)
    : null;
}

/** `undefined` passes — the field is optional; anything unreadable fails. */
function writtenNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * The write validator. Runs once, where a value arrives from the panel or from
 * an agent, and returns `null` for anything it does not recognise so the caller
 * can decline rather than store a reveal nothing can read.
 */
export function coerceReveal(value: unknown): TextReveal | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { unit, progress, fade } = value as Record<string, unknown>;
  const known = coerceRevealUnit(unit);
  if (known == null) {
    return null;
  }
  if (!writtenNumber(progress) || !writtenNumber(fade)) {
    return null;
  }
  const next: TextReveal = {
    unit: known,
    progress:
      progress === undefined
        ? DEFAULT_REVEAL_PROGRESS
        : Math.min(100, Math.max(0, progress as number)),
  };
  const softness =
    fade === undefined
      ? DEFAULT_REVEAL_FADE
      : Math.min(1, Math.max(0, fade as number));
  // A hard cut deletes the key rather than storing a zero, the same
  // default-is-absence rule `blend`, `lineHeight` and the mask's `invert` keep.
  if (softness > 0) {
    next.fade = softness;
  }
  return next;
}

/**
 * Whether two reveals say the same thing.
 *
 * The option panel rebuilds the whole object on every change, so `!==` would
 * report a change on a click that set the unit a clip already had, and
 * `withCheckpoint` would spend an undo step on nothing.
 */
export function sameReveal(
  a: TextReveal | null | undefined,
  b: TextReveal | null | undefined,
): boolean {
  if (a == null || b == null) {
    return (a ?? null) === (b ?? null);
  }
  return (
    a.unit === b.unit &&
    a.progress === b.progress &&
    (a.fade ?? DEFAULT_REVEAL_FADE) === (b.fade ?? DEFAULT_REVEAL_FADE)
  );
}

/**
 * `Intl.Segmenter`, reached without depending on the `lib` setting.
 *
 * Declared rather than taken from the TypeScript lib because this module is
 * type-checked by both `tsc` and webpack against different `lib` lists, and a
 * missing `Intl.Segmenter` declaration would fail one of them.
 */
type Segment = { segment: string; index: number; isWordLike?: boolean };
type SegmenterLike = { segment(input: string): Iterable<Segment> };

/**
 * Pinned to one locale rather than the host's.
 *
 * Word breaking is locale-tailored, so the default locale would segment the
 * same sentence differently on a Korean machine and on CI — a reveal that
 * paused in different places depending on who rendered it. `"en"` selects the
 * root rules, which is what script-based breaking (Han, Hiragana, Hangul) falls
 * back to anyway.
 */
const SEGMENTER_LOCALE = "en";

const segmenters = new Map<string, SegmenterLike | null>();

/** Construction is expensive, so one per granularity for the process. */
function segmenterFor(granularity: string): SegmenterLike | null {
  const cached = segmenters.get(granularity);
  if (cached !== undefined) {
    return cached;
  }
  let made: SegmenterLike | null = null;
  try {
    const ctor = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    if (typeof ctor === "function") {
      made = new (
        ctor as new (
          locale: string,
          options: { granularity: string },
        ) => SegmenterLike
      )(SEGMENTER_LOCALE, { granularity });
    }
  } catch {
    made = null;
  }
  segmenters.set(granularity, made);
  return made;
}

function graphemeEnds(line: string): number[] {
  const out: number[] = [];
  const segmenter = segmenterFor("grapheme");
  if (segmenter != null) {
    for (const piece of segmenter.segment(line)) {
      out.push(piece.index + piece.segment.length);
    }
    return out;
  }
  // Code points, not code units: this fallback still separates a combining mark
  // from its base, but it never halves a surrogate pair — which is the failure
  // that produces a replacement glyph rather than a slightly early cut.
  let at = 0;
  for (const codePoint of line) {
    at += codePoint.length;
    out.push(at);
  }
  return out;
}

function wordStarts(line: string): number[] {
  const out: number[] = [];
  const segmenter = segmenterFor("word");
  if (segmenter != null) {
    for (const piece of segmenter.segment(line)) {
      if (piece.isWordLike === true) {
        out.push(piece.index);
      }
    }
    return out;
  }
  const runs = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = runs.exec(line)) !== null) {
    out.push(match.index);
  }
  return out;
}

function computeBoundaries(line: string, unit: RevealUnit): number[] {
  if (unit === "line") {
    // A line is one unit whether or not it has anything in it: a blank line
    // between paragraphs is a beat, and skipping it would make the pause
    // vanish exactly where the author put one.
    return [line.length];
  }
  if (line === "") {
    return [];
  }
  if (unit === "character") {
    return graphemeEnds(line);
  }
  const starts = wordStarts(line);
  if (starts.length === 0) {
    // Punctuation or whitespace only — one unit, so a line of "..." still takes
    // its turn instead of appearing for free.
    return [line.length];
  }
  // A word owns everything up to where the *next* word begins, so its trailing
  // space arrives with it and a cut never sits in the gap. Anything before the
  // first word — an opening quote, an em dash — rides along with it.
  const out: number[] = [];
  for (let i = 1; i < starts.length; i += 1) {
    out.push(starts[i]);
  }
  out.push(line.length);
  return out;
}

const BOUNDARY_CACHE_LIMIT = 512;
const boundaryCache = new Map<string, number[]>();

/**
 * The character offsets a cut may fall on, one per unit, ascending, ending at
 * the length of the line.
 *
 * **The returned array is shared and must not be mutated.** Segmenting runs
 * once per line per unit and is then cached, the same bargain
 * `renderer/text.ts#cachedWrappedLines` makes — a caption re-drawn sixty times
 * a second would otherwise re-segment its every line every frame.
 */
export function unitBoundaries(line: string, unit: RevealUnit): number[] {
  const key = `${unit}:${line}`;
  const hit = boundaryCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const made = computeBoundaries(line, unit);
  if (boundaryCache.size >= BOUNDARY_CACHE_LIMIT) {
    const oldest = boundaryCache.keys().next();
    if (!oldest.done) {
      boundaryCache.delete(oldest.value);
    }
  }
  boundaryCache.set(key, made);
  return made;
}

/** How many steps this line takes to reveal. */
export function unitCount(line: string, unit: RevealUnit): number {
  return unitBoundaries(line, unit).length;
}

/** How many steps a whole wrapped block takes. */
export function totalUnits(lines: string[], unit: RevealUnit): number {
  let total = 0;
  for (const line of lines) {
    total += unitCount(line, unit);
  }
  return total;
}

/**
 * What to draw of each line at a given progress.
 *
 * `lines` is the **wrapped** block — a reveal is applied after layout, never
 * before it, or the text would re-wrap as it appeared.
 *
 * Progress is counted over the block as a whole rather than per line, so a
 * two-line title types at one speed throughout instead of racing through a
 * short second line.
 */
export function revealPlan(
  lines: string[],
  unit: RevealUnit,
  progress: number,
  fade: number = DEFAULT_REVEAL_FADE,
): LineReveal[] {
  const total = totalUnits(lines, unit);
  if (total === 0) {
    // Nothing to count — an empty text element. Showing it whole costs nothing
    // and avoids dividing by zero to decide that.
    return lines.map((line) => ({ chars: line.length, head: null }));
  }

  const revealed = (clampRevealProgress(progress) / 100) * total;
  const softness = clampFade(fade);

  const out: LineReveal[] = [];
  let consumed = 0;
  for (const line of lines) {
    const bounds = unitBoundaries(line, unit);
    const count = bounds.length;

    if (revealed >= consumed + count) {
      out.push({ chars: line.length, head: null });
    } else if (revealed <= consumed) {
      out.push({ chars: 0, head: null });
    } else {
      const local = revealed - consumed;
      const whole = Math.floor(local);
      const settled = whole === 0 ? 0 : bounds[whole - 1];
      let chars = settled;
      let head: RevealHead | null = null;

      const fraction = local - whole;
      if (softness > 0 && fraction > 0 && whole < count) {
        const alpha = fraction / softness;
        if (alpha >= 1) {
          // Past its fade already: no reason to pay for a second pass.
          chars = bounds[whole];
        } else {
          head = { from: settled, to: bounds[whole], alpha };
        }
      }
      out.push({ chars, head });
    }

    consumed += count;
  }
  return out;
}

/** The track under `property`, but only while it is switched on. */
function activeTrack(element: TimelineElement, property: string): any {
  const track = (element as any)?.animation?.[property];
  return track != null && track.isActivate === true ? track : null;
}

/**
 * The reveal's progress at a cursor, animation resolved.
 *
 * Deliberately not a field on `transform.ts#LocalSample`: that struct is what
 * `sampledBoxOf` answers from, and the selection outline, the eight grips, the
 * hit test and the mask's element-space mapping all read it. A reveal moves no
 * box, so putting it there would make five unrelated consumers carry it. The
 * mask's five keep their own sampler for the same reason.
 */
export function sampledRevealProgress(
  element: TimelineElement,
  reveal: TextReveal,
  cursor: number,
): number {
  return clampRevealProgress(
    sampleTrack(
      activeTrack(element, "revealProgress"),
      (element as any).startTime,
      cursor,
      reveal.progress,
    ),
  );
}
