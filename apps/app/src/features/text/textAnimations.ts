/**
 * Animated text: the Text panel's "Animated" section.
 *
 * Each entry is a look (one of the text presets, by id) and a way for that
 * text to arrive, built from what a text clip can already do: the reveal
 * (`text/reveal.ts`), which steps through the text a character or a word at a
 * time and moves each unit in from a starting pose, and optionally one of the
 * nineteen whole-clip moves (`animation/presets.ts`). Nothing here is a new
 * kind of animation. A clip made from a tile is an ordinary text clip with a
 * reveal and a keyframed progress, editable in the inspector like any other,
 * and drawn by the renderer the preview, the export and the tile all share.
 *
 * Offsets and blur are written in ems and multiplied by the clip's font size
 * when applied, so a move travels the same distance relative to the letters at
 * 720p, at 4K and on the tile.
 *
 * Every animator sets `settle`, so the last letters finish their move instead
 * of jumping to rest when the progress reaches 100 (see `RevealAnimate`).
 *
 * Pure: no store, no DOM.
 */

import type { RevealUnit, TextElementType } from "../../@types/timeline";
import type { EasingName } from "../animation/easing";
import {
  applyPreset,
  presetDefaultMs,
  writeTrack,
  type PresetName,
} from "../animation/presets";
import { spanOf } from "../timeline/geometry";
import {
  isRevealable,
  setClipTextReveal,
  setClipTextRevealFields,
  type RevealFieldPatch,
} from "../timeline/textRevealOps";
import type { TimelineDocument } from "../timeline/tracks";

/** How long a clip made from an animated tile lasts. */
export const ANIMATED_TEXT_MS = 3000;

/** Where the resting tile stops, as a fraction of the arrival, unless set. */
export const DEFAULT_REST_AT = 0.6;

export type TextAnimation = {
  id: string;
  /** English, like every label in the Text panel. */
  name: string;
  unit: Extract<RevealUnit, "character" | "word">;
  /** How long the text takes to arrive, from the clip's start. */
  inMs: number;
  /**
   * How long it takes to leave, ending on the clip's last frame. The exit is
   * the arrival played backwards: the last unit leaves first, the way it came.
   */
  outMs?: number;
  /**
   * A soft arrival with no animator: how much of one unit's turn it fades
   * over, at most one unit in flight. `0` is a hard cut, typing.
   */
  fade?: number;
  /** Each unit's starting pose. Absent opacity means it starts transparent. */
  animate?: {
    window: number;
    scale?: number;
    offsetXEm?: number;
    offsetYEm?: number;
    rotation?: number;
    blurEm?: number;
    easing: EasingName;
  };
  /** A whole-clip move laid over the reveal. */
  move?: PresetName;
  /** The preset the text wears, by id: `"<family>/<key>"`. */
  look: string;
  /** Where the resting tile stops, as a fraction of `inMs`. */
  restAt?: number;
};

export const TEXT_ANIMATIONS: readonly TextAnimation[] = [
  {
    id: "letter-fade",
    name: "Letter Fade",
    unit: "character",
    inMs: 900,
    fade: 1,
    look: "GreatVibes-Regular/elegant",
  },
  {
    id: "letter-rise",
    name: "Letter Rise",
    unit: "character",
    inMs: 800,
    animate: { window: 5, offsetYEm: 0.6, easing: "ease_out" },
    look: "Raleway-SemiBold/cinema",
  },
  {
    id: "letter-drop",
    name: "Letter Drop",
    unit: "character",
    inMs: 700,
    animate: { window: 4, offsetYEm: -0.9, easing: "overshoot" },
    look: "Bangers-Regular/comic",
  },
  {
    id: "letter-bounce",
    name: "Letter Bounce",
    unit: "character",
    inMs: 700,
    animate: { window: 4, scale: 0, easing: "overshoot" },
    look: "Shrikhand-Regular/candy",
  },
  {
    id: "blur-in",
    name: "Blur In",
    unit: "character",
    inMs: 1000,
    animate: { window: 8, blurEm: 0.35, scale: 115, easing: "ease_out" },
    look: "PlayfairDisplay-Bold/gold",
  },
  {
    id: "letter-spin",
    name: "Letter Spin",
    unit: "character",
    inMs: 800,
    animate: { window: 4, rotation: -180, scale: 30, easing: "ease_out" },
    look: "BebasNeue-Regular/sunset",
    // Earlier, half the letters are mid-turn and the tile reads as a jumble.
    restAt: 0.85,
  },
  {
    id: "letter-zoom",
    name: "Letter Zoom",
    unit: "character",
    inMs: 700,
    animate: { window: 5, scale: 300, easing: "ease_out" },
    look: "Shrikhand-Regular/seventies",
  },
  {
    id: "swing",
    name: "Swing",
    unit: "character",
    inMs: 800,
    animate: { window: 4, rotation: 40, offsetYEm: 0.4, easing: "overshoot" },
    look: "Pacifico-Regular/diner",
  },
  {
    id: "letter-slide",
    name: "Letter Slide",
    unit: "character",
    inMs: 700,
    animate: { window: 6, offsetXEm: 1.2, easing: "ease_out" },
    look: "Oswald-Bold/cyanEdge",
  },
  {
    id: "type-on",
    name: "Type On",
    unit: "character",
    inMs: 600,
    fade: 0,
    look: "RobotoMono-Bold/terminal",
  },
  {
    id: "word-rise",
    name: "Word Rise",
    unit: "word",
    inMs: 700,
    animate: { window: 2, offsetYEm: 0.6, easing: "ease_out" },
    look: "OpenSans-SemiBold/caption",
  },
  {
    id: "word-stamp",
    name: "Word Stamp",
    unit: "word",
    inMs: 600,
    animate: { window: 1, scale: 180, easing: "snap" },
    look: "Anton-Regular/blockShadow",
  },
  {
    id: "word-focus",
    name: "Word Focus",
    unit: "word",
    inMs: 900,
    animate: { window: 2, blurEm: 0.4, easing: "ease_out" },
    look: "Inter-Bold/glass",
  },
  {
    id: "slow-reveal",
    name: "Slow Reveal",
    unit: "character",
    inMs: 1400,
    animate: { window: 8, blurEm: 0.15, easing: "ease_out" },
    move: "drift",
    look: "BlackOpsOne-Regular/chrome",
  },
  {
    id: "rise-and-sink",
    name: "Rise and Sink",
    unit: "character",
    inMs: 700,
    outMs: 600,
    animate: { window: 5, offsetYEm: 0.6, easing: "ease_out" },
    look: "Poppins-SemiBold/pill",
  },
  {
    id: "words-in-out",
    name: "Words In Out",
    unit: "word",
    inMs: 700,
    outMs: 600,
    fade: 1,
    look: "Nunito-Bold/whisper",
  },
];

export function textAnimationById(id: string): TextAnimation | null {
  return TEXT_ANIMATIONS.find((animation) => animation.id === id) ?? null;
}

/**
 * The text a tile shows and a click adds. A word reveal needs more than one
 * word, or there is nothing to stagger.
 */
export function sampleTextFor(animation: Pick<TextAnimation, "unit">): string {
  return animation.unit === "word" ? "Your Title" : "Title";
}

/**
 * The reveal's progress keyframes for a clip `spanMs` long, as `writeTrack`
 * takes them.
 *
 * The arrival runs from 0 to `inMs`, clamped into the clip. An exit ends on the
 * last frame drawn (`spanMs - frameMs`) rather than on the clip's end: a clip
 * occupies `[start, end)`, so a 0 at the end itself is never shown and the
 * last frame would still hold part of the text.
 */
export function progressStops(
  animation: Pick<TextAnimation, "inMs" | "outMs">,
  spanMs: number,
  frameMs: number,
): { times: number[]; values: number[] } {
  const span = Math.max(1, spanMs);
  if (animation.outMs == null) {
    return {
      times: [0, Math.max(1, Math.min(Math.round(animation.inMs), span))],
      values: [0, 100],
    };
  }

  const last = Math.max(2, Math.floor(span - Math.max(0, frameMs)));
  const inEnd = Math.max(1, Math.min(Math.round(animation.inMs), Math.floor(last / 2)));
  const outStart = Math.max(inEnd, Math.round(last - animation.outMs));
  if (outStart <= inEnd) {
    return { times: [0, inEnd, last], values: [0, 100, 0] };
  }
  return { times: [0, inEnd, outStart, last], values: [0, 100, 100, 0] };
}

/** Ems to element pixels, to the hundredth. */
function em(value: number | undefined, fontsize: number): number | undefined {
  return value == null ? undefined : Math.round(value * fontsize * 100) / 100;
}

/** The animator `setClipTextRevealFields` stores, in this clip's pixels. */
export function animatorFor(
  animation: Pick<TextAnimation, "animate">,
  fontsize: number,
): Record<string, unknown> | null {
  const a = animation.animate;
  if (a == null) {
    return null;
  }
  const out: Record<string, unknown> = {
    window: a.window,
    easing: a.easing,
    settle: true,
  };
  const fields: Array<[string, number | undefined]> = [
    ["scale", a.scale],
    ["offsetX", em(a.offsetXEm, fontsize)],
    ["offsetY", em(a.offsetYEm, fontsize)],
    ["rotation", a.rotation],
    ["blur", em(a.blurEm, fontsize)],
  ];
  for (const [key, value] of fields) {
    if (value != null) {
      out[key] = value;
    }
  }
  return out;
}

export type ApplyTextAnimationOptions = {
  /** The project's bake rate, as every keyframe op takes it. */
  bakeHz: number;
  /** One frame at the project's rate, for where an exit has to end. */
  frameMs: number;
};

/**
 * Animate a text clip's arrival, and its exit if the animation has one.
 *
 * For a clip that was just made: the progress track is written, not cleared
 * first, so a clip that already carried a curve would end up with both.
 *
 * Returns the document by identity for anything that is not a text clip,
 * checked before any step so the whole-clip move cannot land on a clip the
 * reveal refused.
 */
export function applyTextAnimation(
  doc: TimelineDocument,
  elementId: string,
  animation: TextAnimation,
  { bakeHz, frameMs }: ApplyTextAnimationOptions,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRevealable(element)) {
    return doc;
  }
  const text = element as TextElementType;

  let next = setClipTextReveal(doc, elementId, animation.unit);

  const patch: RevealFieldPatch = {};
  if (animation.fade != null) {
    patch.fade = animation.fade;
  }
  const animate = animatorFor(animation, text.fontsize);
  if (animate != null) {
    patch.animate = animate;
  }
  if (patch.fade != null || patch.animate != null) {
    next = setClipTextRevealFields(next, elementId, patch);
  }

  const { times, values } = progressStops(
    animation,
    spanOf(text).length,
    frameMs,
  );
  // Linear on every segment: the animator eases each unit, and the progress
  // under it has to move at one speed or the units bunch up at both ends.
  next = writeTrack(
    next,
    elementId,
    "revealProgress",
    [{ lane: "x", values }],
    times,
    times.slice(1).map(() => "linear" as const),
    bakeHz,
  );

  if (animation.move != null) {
    next = applyPreset(
      next,
      elementId,
      animation.move,
      presetDefaultMs(animation.move),
      bakeHz,
    );
  }

  return next;
}
