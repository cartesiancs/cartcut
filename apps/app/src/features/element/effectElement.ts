/**
 * The shape of an effect element, in one place.
 *
 * Construction is split from commitment, as it is in `textElement.ts` and
 * `shapeElement.ts`: a caller that wants to place several in one undo step
 * cannot use a function that checkpoints on its way out.
 *
 * An effect has no `width`, `height`, `location` or `rotation` — it covers the
 * project frame exactly, always — so this factory is much shorter than the
 * others. What it does carry is a `presetId` and the parameter values that
 * preset declared. See `@types/timeline.ts#EffectElementType`.
 */

import { emptyAnimation } from "../animation/keyframes";
import type { EffectElementType, FxParams } from "../../@types/timeline";

/** How long an effect lands as when the user drops one with no length in mind. */
export const DEFAULT_EFFECT_MS = 3000;

/** Full strength. `intensity` is 0-100, like `opacity`. */
export const DEFAULT_INTENSITY = 100;

export type EffectElementOptions = {
  presetId: string;
  params?: FxParams;
  startTime?: number;
  duration?: number;
  intensity?: number;
  /** Overlay presets only; shader presets combine in GLSL and ignore it. */
  blend?: GlobalCompositeOperation;
};

export function createEffectElement({
  presetId,
  params = {},
  startTime = 0,
  duration = DEFAULT_EFFECT_MS,
  intensity = DEFAULT_INTENSITY,
  blend,
}: EffectElementOptions): EffectElementType {
  return {
    // Both are supplied by `placeNewElement`, which picks the track and derives
    // the paint rank from it. For an effect that rank is not cosmetic: it is
    // what decides which layers the effect applies to.
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration,
    // `TimelinePlaced` requires it and the timeline bar reads the colour, but
    // an effect draws nothing at a position — this is not a location on canvas.
    location: { x: 0, y: 0 },
    timelineOptions: { color: "rgb(120, 170, 140)" },
    filetype: "effect",
    localpath: "EFFECT",
    presetId,
    params,
    intensity,
    ...(blend != null ? { blend } : {}),
    animation: emptyAnimation("effect"),
  } as EffectElementType;
}
