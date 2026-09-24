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
  RevealAnimate,
  RevealUnit,
  TextReveal,
  TimelineElement,
} from "../../@types/timeline";
import { REVEAL_UNITS } from "../../@types/timeline";
import { easeAt, resolveEasing } from "../animation/easing";
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
 * The part of one unit that is on screen but not yet settled.
 *
 * `from`/`to` are character offsets into the line, so the renderer can clip to
 * exactly that unit's advance without measuring anything else.
 *
 * `t` runs 0 at the instant the unit arrives to 1 when it has settled, eased
 * already. Without an animator it is unused and always 1; with one it is what
 * every movement is interpolated over.
 */
export type RevealHead = {
  from: number;
  to: number;
  alpha: number;
  t: number;
  /** The movement to apply, resolved. `null` when the reveal has no animator. */
  move: RevealMove | null;
};

/**
 * Where a unit is on its way in, in the element's own space.
 *
 * Absolute values rather than fractions, so the renderer applies them without
 * knowing what they were interpolated from. `scale` is a multiplier, 1 settled.
 */
export type RevealMove = {
  scale: number;
  offsetX: number;
  offsetY: number;
  rotationDeg: number;
  blur: number;
};

/**
 * What to draw of one wrapped line.
 *
 * `chars` is a character offset: `line.slice(0, chars)` is drawn whole and
 * without movement. `heads` names the units still arriving, earliest first —
 * at most one without an animator, and up to `window` of them with one.
 */
export type LineReveal = { chars: number; heads: RevealHead[] };

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

/** The most units that may be in flight at once. See `RevealAnimate.window`. */
export const MAX_REVEAL_WINDOW = 8;

/** Inert defaults: an animator with nothing set changes no pixel. */
const ANIMATE_DEFAULTS = {
  scale: 100,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  blur: 0,
  opacity: 0,
} as const;

function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = finiteNumber(value);
  return n == null ? null : Math.min(max, Math.max(min, n));
}

/**
 * The animator on a reveal, normalised, or `null`.
 *
 * Runs inside the paint loop and must never throw. An animator whose every
 * field is inert answers `null` rather than a no-op object: that is what keeps
 * a clip with `{ animate: {} }` on the same drawing path as one with none.
 */
export function animateOf(raw: unknown): Required<Omit<RevealAnimate, "easing">> & {
  easing: string | null;
} | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;

  const next = {
    window: clampNumber(source.window, 0, MAX_REVEAL_WINDOW) ?? 0,
    scale: clampNumber(source.scale, 0, 1000) ?? ANIMATE_DEFAULTS.scale,
    offsetX: clampNumber(source.offsetX, -10_000, 10_000) ?? ANIMATE_DEFAULTS.offsetX,
    offsetY: clampNumber(source.offsetY, -10_000, 10_000) ?? ANIMATE_DEFAULTS.offsetY,
    rotation: clampNumber(source.rotation, -3600, 3600) ?? ANIMATE_DEFAULTS.rotation,
    blur: clampNumber(source.blur, 0, 500) ?? ANIMATE_DEFAULTS.blur,
    opacity: clampNumber(source.opacity, 0, 100) ?? ANIMATE_DEFAULTS.opacity,
    easing: typeof source.easing === "string" ? source.easing : null,
  };

  const moves =
    next.scale !== ANIMATE_DEFAULTS.scale ||
    next.offsetX !== ANIMATE_DEFAULTS.offsetX ||
    next.offsetY !== ANIMATE_DEFAULTS.offsetY ||
    next.rotation !== ANIMATE_DEFAULTS.rotation ||
    next.blur !== ANIMATE_DEFAULTS.blur ||
    next.opacity !== ANIMATE_DEFAULTS.opacity;

  return moves ? next : null;
}

/**
 * The write validator, the strict twin of `animateOf`.
 *
 * Every field is optional and one it cannot read is dropped rather than
 * defaulted, the rule `coerceRunStyle` follows: an absent key already means the
 * inert value, so a junk `scale` leaves the unit at full size instead of
 * refusing the whole write. `null` when nothing survived.
 */
export function coerceRevealAnimate(value: unknown): RevealAnimate | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const next: RevealAnimate = {};

  const put = (key: keyof RevealAnimate, min: number, max: number) => {
    if (!(key in source)) {
      return;
    }
    const read = clampNumber(source[key], min, max);
    if (read != null) {
      (next[key] as unknown) = read;
    }
  };

  put("window", 0, MAX_REVEAL_WINDOW);
  put("scale", 0, 1000);
  put("offsetX", -10_000, 10_000);
  put("offsetY", -10_000, 10_000);
  put("rotation", -3600, 3600);
  put("blur", 0, 500);
  put("opacity", 0, 100);

  if (typeof source.easing === "string" && resolveEasing(source.easing) != null) {
    next.easing = source.easing;
  }

  // An animator that would move nothing is not an animator. Answering `null`
  // deletes the key rather than storing an empty object, the
  // default-is-absence rule the rest of this file keeps.
  return animateOf(next) == null ? null : next;
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
  const { unit, progress, fade, animate } = raw as Record<string, unknown>;
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
  const moving = coerceRevealAnimate(animate);
  if (moving != null) {
    next.animate = moving;
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
  const { unit, progress, fade, animate } = value as Record<string, unknown>;
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
  const moving = coerceRevealAnimate(animate);
  if (moving != null) {
    next.animate = moving;
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
    (a.fade ?? DEFAULT_REVEAL_FADE) === (b.fade ?? DEFAULT_REVEAL_FADE) &&
    // Compared through the normaliser rather than field by field, so two
    // animators that differ only in which inert fields they spell out are one
    // animator — which is what the panel produces when it rebuilds the object
    // on every change.
    JSON.stringify(animateOf(a.animate) ?? null) ===
      JSON.stringify(animateOf(b.animate) ?? null)
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
  animate: RevealAnimate | null = null,
): LineReveal[] {
  const total = totalUnits(lines, unit);
  if (total === 0) {
    // Nothing to count — an empty text element. Showing it whole costs nothing
    // and avoids dividing by zero to decide that.
    return lines.map((line) => ({ chars: line.length, heads: [] }));
  }

  const revealed = (clampRevealProgress(progress) / 100) * total;
  const softness = clampFade(fade);
  const moving = animateOf(animate);

  // How far past a unit's arrival it goes on moving, in units.
  //
  // Without an animator this is `fade`, and exactly one unit can be in flight
  // because `fade` is bounded at 1 — which is the path every reveal written
  // before the animator takes, unchanged. With one, `window` says, defaulting
  // to `fade` when there is one so the two never contradict each other.
  const span = moving == null ? softness : moving.window > 0 ? moving.window : softness > 0 ? softness : 1;

  const curve = moving?.easing == null ? null : resolveEasing(moving.easing);

  const out: LineReveal[] = [];
  let consumed = 0;
  for (const line of lines) {
    const bounds = unitBoundaries(line, unit);
    const count = bounds.length;

    // How far into this line the reveal has travelled, in units. Unit `i` takes
    // its turn over `local ∈ [i, i + 1)`.
    const local = revealed - consumed;
    consumed += count;

    if (local <= 0) {
      out.push({ chars: 0, heads: [] });
      continue;
    }
    if (local >= count) {
      out.push({ chars: line.length, heads: [] });
      continue;
    }

    if (span <= 0) {
      /*
       * A hard cut with no animator: a unit appears only once its turn is
       * *over*, so `floor(local)` units are shown and nothing is in flight.
       *
       * This is discontinuous against the branch below as `span → 0⁺`, where a
       * unit becomes whole at `local = i` instead. That is the behaviour this
       * module has always had and it is the right one to keep: `fade: 0` means
       * "no transition", and a transition of zero length that nonetheless
       * showed the unit a whole turn early would type one character ahead of
       * where the curve says.
       */
      const whole = Math.floor(local);
      out.push({ chars: whole === 0 ? 0 : bounds[whole - 1], heads: [] });
      continue;
    }

    // Unit `i` has settled once `local - i >= span`.
    const settledUnits = Math.min(
      count,
      Math.max(0, Math.floor(local - span + 1e-9) + 1),
    );
    const chars = settledUnits === 0 ? 0 : bounds[settledUnits - 1];

    const heads: RevealHead[] = [];
    for (let index = settledUnits; index < count; index += 1) {
      const past = local - index;
      if (past <= 0) {
        // Not arrived, and neither has anything after it.
        break;
      }

      const linear = Math.min(1, past / span);
      const t = curve == null ? linear : easeAt(curve, linear);

      heads.push({
        from: index === 0 ? 0 : bounds[index - 1],
        to: bounds[index],
        alpha: alphaFor(moving, softness, past, t),
        t,
        move: moving == null ? null : moveAt(moving, t),
      });
    }

    out.push({ chars, heads });
  }
  return out;
}

/**
 * How strongly one arriving unit is drawn.
 *
 * Without an animator this is the original rule exactly: `fade` is the fraction
 * of a unit's turn spent fading, so alpha is `past / fade`. With one, the unit
 * travels from `animate.opacity` to full over the window, eased along with
 * everything else — which is what makes "appear and settle" one movement
 * rather than a fade racing a scale.
 */
function alphaFor(
  moving: ReturnType<typeof animateOf>,
  softness: number,
  past: number,
  t: number,
): number {
  if (moving == null) {
    return softness > 0 ? Math.min(1, past / softness) : 1;
  }
  const from = moving.opacity / 100;
  return Math.min(1, Math.max(0, from + (1 - from) * t));
}

/** Where a unit is at `t`, interpolating from its starting state to settled. */
function moveAt(
  moving: NonNullable<ReturnType<typeof animateOf>>,
  t: number,
): RevealMove {
  const remaining = 1 - t;
  return {
    // Percentages in, a multiplier out: the renderer scales by this directly.
    scale: 1 + (moving.scale / 100 - 1) * remaining,
    offsetX: moving.offsetX * remaining,
    offsetY: moving.offsetY * remaining,
    rotationDeg: moving.rotation * remaining,
    // Floored because an overshooting easing can take `remaining` past 1 or
    // below 0, and the canvas throws on a negative blur radius.
    blur: Math.max(0, moving.blur * remaining),
  };
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
