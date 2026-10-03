/**
 * The Animator card's rules, kept out of the Lit class so a node suite can hold
 * them.
 *
 * The card is the panel half of `set_text_reveal`'s `animate*` arguments: what a
 * unit does on its way in (`TextReveal.animate`). Everything here is about the
 * boxes: what they show for a clip, and what one edit writes. The write itself
 * is `textRevealOps.ts#setClipTextRevealFields`, the same op the agent command
 * folds its arguments into, so the two surfaces cannot store different things.
 *
 * ## A box set back to its inert value deletes the key
 *
 * `setClipTextRevealFields` merges a patch over the stored animator, and
 * `coerceRevealAnimate` drops a key it cannot read. So a patch carrying the key
 * as `undefined` removes it, and that is what a box at its inert value sends.
 * Storing `scale: 100` beside a real offset would move nothing and would make a
 * clip whose user dragged the scale out and back save differently from one they
 * never touched.
 *
 * `window` is the exception: it has no inert value, because absent means
 * "derived from the softness", and a number the user typed means that number.
 */

import type { RevealAnimate, TextReveal } from "../../@types/timeline";
import {
  easingNames,
  resolveEasing,
  type EasingName,
} from "../animation/easing";
import {
  REVEAL_ANIMATE_DEFAULTS,
  REVEAL_ANIMATE_RANGES,
  animatorSpan,
} from "../text/reveal";

/** The animator fields that move something, each one number. */
export type AnimatorMoveKey = keyof typeof REVEAL_ANIMATE_DEFAULTS;

/** What the card's boxes show. Every field filled in, never absent. */
export type AnimatorValues = Record<AnimatorMoveKey, number> & {
  /** Units in flight at once, as the renderer will use it. */
  window: number;
  easing: EasingName;
};

/** How one box scrubs. The bounds are the op's own clamp. */
export type AnimatorBox = {
  min: number;
  max: number;
  step: number;
  /** Value units per pixel of drag, as `number-input` takes it. */
  sensitivity: number;
};

function box(
  key: keyof typeof REVEAL_ANIMATE_RANGES,
  step: number,
  sensitivity: number,
): AnimatorBox {
  const [min, max] = REVEAL_ANIMATE_RANGES[key];
  return { min, max, step, sensitivity };
}

/**
 * Each box's range and feel.
 *
 * The window's floor is 0.1 rather than the op's 0, because a stored 0 means
 * "not set" and would snap the box back to the derived value under the drag.
 */
export const ANIMATOR_BOXES: Record<AnimatorMoveKey | "window", AnimatorBox> = {
  scale: box("scale", 1, 1),
  offsetX: box("offsetX", 1, 1),
  offsetY: box("offsetY", 1, 1),
  rotation: box("rotation", 1, 0.5),
  blur: box("blur", 0.5, 0.2),
  opacity: box("opacity", 1, 1),
  window: { ...box("window", 0.1, 0.02), min: 0.1 },
};

/** Words for the easing names. Typed as a full record so a new curve must be named. */
const EASING_LABEL: Record<EasingName, string> = {
  linear: "Linear",
  ease_in: "Ease in",
  ease_out: "Ease out",
  ease_in_out: "Ease in-out",
  snap: "Snap",
  overshoot: "Overshoot",
  anticipate: "Anticipate",
};

/** The Easing dropdown's entries, in `easing.ts`'s own order. */
export function animatorEasingOptions(): Array<{
  value: EasingName;
  label: string;
}> {
  return easingNames().map((value) => ({ value, label: EASING_LABEL[value] }));
}

/**
 * The values the boxes show for a reveal, defaults filled in.
 *
 * `reveal` is `revealOf`'s answer, so its animator is already validated. The
 * window is the *effective* one (`animatorSpan`), because the 0 that means "not
 * set" is not a number anyone would recognise on screen.
 */
export function animatorValuesOf(reveal: TextReveal | null): AnimatorValues {
  const animate: RevealAnimate = reveal?.animate ?? {};
  const easing =
    typeof animate.easing === "string" && resolveEasing(animate.easing) != null
      ? (animate.easing as EasingName)
      : "linear";

  return {
    scale: animate.scale ?? REVEAL_ANIMATE_DEFAULTS.scale,
    offsetX: animate.offsetX ?? REVEAL_ANIMATE_DEFAULTS.offsetX,
    offsetY: animate.offsetY ?? REVEAL_ANIMATE_DEFAULTS.offsetY,
    rotation: animate.rotation ?? REVEAL_ANIMATE_DEFAULTS.rotation,
    blur: animate.blur ?? REVEAL_ANIMATE_DEFAULTS.blur,
    opacity: animate.opacity ?? REVEAL_ANIMATE_DEFAULTS.opacity,
    window: animatorSpan(animate.window ?? 0, reveal?.fade ?? 0),
    easing,
  };
}

/** Whether the clip's reveal carries a movement that is actually stored. */
export function hasAnimator(reveal: TextReveal | null): boolean {
  return reveal?.animate != null;
}

/**
 * The `animate` patch one movement box writes.
 *
 * The inert value is sent as `undefined`, which deletes the key; see the
 * header.
 */
export function animatorMovePatch(
  key: AnimatorMoveKey,
  value: number,
): Record<string, unknown> {
  return {
    [key]: value === REVEAL_ANIMATE_DEFAULTS[key] ? undefined : value,
  };
}

/** The `animate` patch the Overlap box writes: always the number given. */
export function animatorWindowPatch(value: number): Record<string, unknown> {
  return { window: value };
}

/** The `animate` patch the Easing dropdown writes. Linear is the default. */
export function animatorEasingPatch(name: string): Record<string, unknown> {
  return { easing: name === "linear" ? undefined : name };
}
