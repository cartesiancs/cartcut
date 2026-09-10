/**
 * The typewriter, as a composition of things that already exist.
 *
 * This module holds no new state and no new concept. A typewriter *is* a reveal
 * with two keyframes on its progress — so this is `setClipTextReveal` followed
 * by `setTrackActive`, two `addKeyframe`s and one easing, and every one of
 * those declines by identity on its own terms. Nothing here can produce a
 * document the panel could not have produced by hand, which is the point: the
 * one-click button is a shortcut through the general feature rather than a
 * second implementation beside it.
 *
 * It is deliberately **not** an entry in `features/animation/presets.ts`. A
 * `PresetShape` is a table of `scale`/`opacity`/`rotation`/`position` stops and
 * `applyPreset` writes keyframes and nothing else; a typewriter also has to
 * write `element.reveal`, which would break that contract, drag
 * `presetPreview.previewSamples` (which reads its result back as a
 * `LocalSample`) into a property that is not part of the transform, and force a
 * matching edit to the hand-copied `PRESETS` in `mcp/tools/define.ts`.
 *
 * ## Two things that are easy to get wrong
 *
 * - **Near the end of the clip the move is compressed, not slid back.** Sliding
 *   the anchor would start the typing somewhere nobody asked for, which is the
 *   one thing an anchor is for. `applyPreset` makes the same choice.
 * - **The unit count is taken from the authored text, not the wrapped lines.**
 *   Wrapping needs a canvas and this module is pure. For `word` the two agree
 *   exactly; for `character` they differ by the spaces a line break swallows;
 *   for `line` they differ by however much the box wraps. That only affects
 *   `unitsPerSecond`, which is a speed the user asked for rather than a
 *   guarantee — and counting what the user actually typed is the more
 *   predictable of the two anyway, since it does not change when the box is
 *   resized.
 *
 * DOM-free and store-free.
 */

import type {
  RevealUnit,
  TextElementType,
  TimelineElement,
} from "../../@types/timeline";
import type { EasingName } from "../animation/easing";
import { projectEasing, resolveEasing } from "../animation/easing";
import { BAKE_HZ } from "../animation/keyframes";
import {
  addKeyframe,
  removeKeyframe,
  setHandles,
  setTrackActive,
} from "../animation/keyframeOps";
import { spanOf } from "../timeline/geometry";
import {
  isRevealable,
  revealRefOf,
  setClipTextReveal,
} from "../timeline/textRevealOps";
import type { TimelineDocument } from "../timeline/tracks";
import { splitParagraphs } from "./lines";
import { coerceRevealUnit, unitCount } from "./reveal";
import { displayTextOf } from "./style";

/**
 * Roughly 220 characters a minute — a brisk but readable typing speed, and the
 * rate most motion-graphics templates land on. Only ever a default: the panel
 * offers a duration, and this is what it starts from.
 */
export const DEFAULT_TYPEWRITER_UNITS_PER_SECOND = 18;

/** A move has to occupy some time, or its two keyframes collapse onto one. */
const MIN_TYPEWRITER_MS = 1;

/** Enough to clear any hand-drawn curve; a guard against a malformed lane. */
const MAX_CLEARED_KEYFRAMES = 512;

export type TypewriterOptions = {
  unit?: RevealUnit;
  /** How long the whole reveal takes. Wins over `unitsPerSecond`. */
  durationMs?: number;
  /** Speed instead of duration — the duration is derived from the text. */
  unitsPerSecond?: number;
  /** Element-local ms. `0` is the clip's own start. */
  startAtMs?: number;
  easing?: EasingName;
  bakeHz?: number;
};

/**
 * How many steps this clip's text takes to reveal, counted on what the author
 * typed rather than on what the box wraps it to. See the header.
 */
export function typewriterUnitCount(
  element: TimelineElement | null | undefined,
  unit: RevealUnit,
): number {
  if (element == null || element.filetype !== "text") {
    return 0;
  }
  let total = 0;
  for (const paragraph of splitParagraphs(
    displayTextOf(element as TextElementType),
  )) {
    total += unitCount(paragraph, unit);
  }
  return total;
}

/** Empty one track's authored lane, one keyframe at a time. */
function clearedTrack(
  doc: TimelineDocument,
  elementId: string,
  bakeHz: number,
): TimelineDocument {
  let next = doc;
  for (let guard = 0; guard < MAX_CLEARED_KEYFRAMES; guard += 1) {
    const list = (next.elements[elementId] as any)?.animation?.revealProgress
      ?.x;
    if (!Array.isArray(list) || list.length === 0) {
      return next;
    }
    const after = removeKeyframe(
      next,
      elementId,
      "revealProgress",
      "x",
      0,
      bakeHz,
    );
    // `removeKeyframe` declines by identity on an index it cannot use; without
    // this the loop would spin to its guard on a malformed lane.
    if (after === next) {
      return next;
    }
    next = after;
  }
  return next;
}

/**
 * Type a clip's text on, from `startAtMs`, over `durationMs`.
 *
 * Replaces whatever the progress track held: this is "make me a typewriter",
 * so a second click gives a clean one rather than two moves fighting. The
 * reveal's unit, and any fade, survive — those are cadence, not timing.
 *
 * Returns the document by identity when the element is missing or is not a text
 * clip.
 */
export function applyTypewriter(
  doc: TimelineDocument,
  elementId: string,
  options: TypewriterOptions = {},
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRevealable(element)) {
    return doc;
  }

  const existing = revealRefOf(doc, elementId);
  const unit = coerceRevealUnit(options.unit) ?? existing?.unit ?? "character";

  const span = spanOf(element).length;
  const anchor = Number.isFinite(options.startAtMs)
    ? Math.max(0, Math.min(options.startAtMs as number, Math.max(0, span - 1)))
    : 0;

  const requested = requestedLength(element, unit, options);
  const length = Math.max(
    MIN_TYPEWRITER_MS,
    Math.min(requested, span - anchor),
  );
  const bakeHz = options.bakeHz ?? BAKE_HZ;

  // The reveal first: `animatableProperties` gates `revealProgress` on the
  // field existing, so every keyframe op below would decline without it.
  let next = setClipTextReveal(doc, elementId, unit);
  next = clearedTrack(next, elementId, bakeHz);
  next = setTrackActive(
    next,
    elementId,
    "revealProgress",
    true,
    undefined,
    bakeHz,
  );
  next = addKeyframe(
    next,
    elementId,
    "revealProgress",
    "x",
    anchor,
    0,
    undefined,
    bakeHz,
  );
  next = addKeyframe(
    next,
    elementId,
    "revealProgress",
    "x",
    anchor + length,
    100,
    undefined,
    bakeHz,
  );

  // Linear unless asked otherwise, and that default matters: `addKeyframe`
  // gives every anchor a 100ms handle, so two keyframes with no easing written
  // over them describe an ease-in-out. Typing that starts slow, races and then
  // dawdles reads as a stutter rather than as a person at a keyboard.
  return withEasing(next, elementId, options.easing ?? "linear", bakeHz);
}

function requestedLength(
  element: TimelineElement,
  unit: RevealUnit,
  options: TypewriterOptions,
): number {
  const asked = options.durationMs;
  if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) {
    return asked;
  }
  const rate = options.unitsPerSecond;
  const perSecond =
    typeof rate === "number" && Number.isFinite(rate) && rate > 0
      ? rate
      : DEFAULT_TYPEWRITER_UNITS_PER_SECOND;
  const units = typewriterUnitCount(element, unit);
  return (Math.max(1, units) / perSecond) * 1000;
}

/**
 * Curve the one segment, once both of its anchors exist.
 *
 * The indices are found rather than assumed: the track was emptied above, so
 * they are 0 and 1 — but `addKeyframe` declines on a document it cannot resolve
 * and reading the list back is what makes that decline harmless here too.
 */
function withEasing(
  doc: TimelineDocument,
  elementId: string,
  easing: EasingName | undefined,
  bakeHz: number,
): TimelineDocument {
  const curve = easing == null ? null : resolveEasing(easing);
  if (curve == null) {
    return doc;
  }
  const list = (doc.elements[elementId] as any)?.animation?.revealProgress?.x;
  if (!Array.isArray(list) || list.length < 2) {
    return doc;
  }
  const { ce, cs } = projectEasing(
    curve,
    { atMs: list[0].p[0], value: list[0].p[1] },
    { atMs: list[1].p[0], value: list[1].p[1] },
  );
  let next = setHandles(
    doc,
    elementId,
    "revealProgress",
    "x",
    0,
    { ce },
    bakeHz,
  );
  next = setHandles(next, elementId, "revealProgress", "x", 1, { cs }, bakeHz);
  return next;
}
