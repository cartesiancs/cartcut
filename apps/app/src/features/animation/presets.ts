/**
 * The common animation moves, correctly built.
 *
 * Lifted out of `optionVideo.handleClickAddAnimatePreset` so the agent and the
 * panel's own Fade In / Zoom In buttons produce the same thing. The shape of
 * the composition matters more than the numbers: `setTrackActive` then the
 * keyframes, folded into one transform, so the whole preset is one undo step.
 * Three separate writes is what it used to be, and undoing a preset was
 * impossible.
 *
 * Units differ per property and are easy to get wrong, which is most of the
 * reason to have presets at all:
 *
 *  - `opacity` is 0-100.
 *  - `scale` is **tenths** — 10 is unscaled, 12 is 120%. `transform.ts` divides
 *    the track value by 10.
 *  - `rotation` is degrees.
 *
 * ## Why there are more than four now
 *
 * The table used to hold `fade_in`, `fade_out`, `zoom_in`, `zoom_out` and
 * nothing else, each a straight line between two values with the default soft
 * handles. That is a library of drifts: every move started and ended at zero
 * velocity, so nothing ever *landed*. The additions carry real curves —
 * `snap` for a punch, `overshoot` for a move that passes its target — because
 * an easing is the difference between a move that reads as deliberate and one
 * that reads as a slow pulse.
 *
 * The original four are untouched, values and curves both. They are what the
 * two toolbar buttons do, and changing what a button does is not a thing to
 * slip into a library expansion.
 */

import type { AnimatableProperty } from "../../@types/timeline";
import { animatableProperties } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import { spanLength } from "../timeline/geometry";
import { addKeyframe, setHandles, setTrackActive } from "./keyframeOps";
import { BAKE_HZ } from "./keyframes";
import { projectEasing, resolveEasing, type EasingName } from "./easing";

export type PresetName =
  | "fade_in"
  | "fade_out"
  | "zoom_in"
  | "zoom_out"
  | "punch_in"
  | "drift"
  | "overshoot_in"
  | "pop"
  | "slam"
  | "shake"
  | "rotate_settle";

/** Unscaled, in the tenths the scale track stores. */
const SCALE_NEUTRAL = 10;
const SCALE_ZOOMED = 12;

/**
 * A point on a preset's curve.
 *
 * `at` is a fraction of the preset's own duration, not a time, so one table
 * describes a move at any length the caller asks for. `easing` shapes the
 * segment *leaving* this stop, the same reading `add_keyframes` uses.
 */
type Stop = { at: number; value: number; easing?: EasingName };

/** A position stop, in pixels **offset from where the clip already sits**. */
type Move = { at: number; x: number; y: number; easing?: EasingName };

type PresetShape = {
  /** Used when the caller does not give one. */
  defaultMs: number;
  /** Anchored to the clip's end rather than its start. */
  fromEnd?: boolean;
  /**
   * Whether `focus` means anything here.
   *
   * Only for presets that change scale and nothing else positional: focus works
   * by counter-animating position, so a preset that already moves the clip has
   * nowhere to put it.
   */
  focusable?: boolean;
  scale?: Stop[];
  opacity?: Stop[];
  /** Degrees **offset from the clip's own rotation**. */
  rotation?: Stop[];
  position?: Move[];
};

/**
 * The library.
 *
 * Durations are the interesting numbers. A punch is under a fifth of a second
 * because anything slower stops being a punch; a drift is four seconds because
 * a Ken Burns that finishes quickly is a zoom. The curve matters as much: the
 * same 10→11.5 over the same 180ms with the default handles is a nudge.
 */
const PRESETS: Record<PresetName, PresetShape> = {
  // ---- the original four, unchanged in value and curve ----
  fade_in: { defaultMs: 250, opacity: [{ at: 0, value: 0 }, { at: 1, value: 100 }] },
  fade_out: {
    defaultMs: 250,
    fromEnd: true,
    opacity: [{ at: 0, value: 100 }, { at: 1, value: 0 }],
  },
  zoom_in: {
    defaultMs: 250,
    focusable: true,
    scale: [{ at: 0, value: SCALE_NEUTRAL }, { at: 1, value: SCALE_ZOOMED }],
  },
  zoom_out: {
    defaultMs: 250,
    focusable: true,
    scale: [{ at: 0, value: SCALE_ZOOMED }, { at: 1, value: SCALE_NEUTRAL }],
  },

  // ---- moves that land ----

  /** A hard push in. Most of the distance is covered immediately. */
  punch_in: {
    defaultMs: 180,
    focusable: true,
    scale: [
      { at: 0, value: SCALE_NEUTRAL, easing: "snap" },
      { at: 1, value: 11.5 },
    ],
  },

  /**
   * A Ken Burns. Constant rate on purpose — an eased drift appears to breathe,
   * because it accelerates and decelerates over a span long enough to see.
   */
  drift: {
    defaultMs: 4_000,
    focusable: true,
    scale: [
      { at: 0, value: SCALE_NEUTRAL, easing: "linear" },
      { at: 1, value: 10.8 },
    ],
  },

  /** Goes past its target and settles back. One segment; the curve does it. */
  overshoot_in: {
    defaultMs: 420,
    focusable: true,
    scale: [
      { at: 0, value: SCALE_NEUTRAL, easing: "overshoot" },
      { at: 1, value: SCALE_ZOOMED },
    ],
  },

  /** An element arriving with life: up past full size, then settling. */
  pop: {
    defaultMs: 320,
    scale: [
      { at: 0, value: 6, easing: "snap" },
      { at: 0.55, value: 11, easing: "ease_out" },
      { at: 1, value: SCALE_NEUTRAL },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.4, value: 100 },
    ],
  },

  /** Arrives oversized and lands hard. The title-card move. */
  slam: {
    defaultMs: 220,
    scale: [
      { at: 0, value: 16, easing: "snap" },
      { at: 1, value: SCALE_NEUTRAL },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.25, value: 100 },
    ],
  },

  /**
   * A rattle. Alternating sign with decaying amplitude, which is what makes it
   * read as an impact rather than a wobble, and `linear` throughout because a
   * shake that eases into each extreme is a wobble again.
   */
  shake: {
    defaultMs: 300,
    position: [
      { at: 0, x: 0, y: 0, easing: "linear" },
      { at: 0.2, x: -14, y: 0, easing: "linear" },
      { at: 0.4, x: 11, y: 0, easing: "linear" },
      { at: 0.6, x: -7, y: 0, easing: "linear" },
      { at: 0.8, x: 4, y: 0, easing: "linear" },
      { at: 1, x: 0, y: 0 },
    ],
  },

  /** Comes in off-angle and rocks past level before settling. */
  rotate_settle: {
    defaultMs: 380,
    rotation: [
      { at: 0, value: -7, easing: "overshoot" },
      { at: 1, value: 0 },
    ],
  },
};

export function presetNames(): PresetName[] {
  return Object.keys(PRESETS) as PresetName[];
}

/** Which properties a preset drives, for error messages and validation. */
export function presetProperties(preset: PresetName): AnimatableProperty[] {
  const shape = PRESETS[preset];
  if (shape == null) {
    return [];
  }
  const out: AnimatableProperty[] = [];
  if (shape.scale) out.push("scale");
  if (shape.opacity) out.push("opacity");
  if (shape.rotation) out.push("rotation");
  if (shape.position) out.push("position");
  return out;
}

/**
 * The single property a preset drives, or null when it drives several.
 *
 * Kept because callers and tests written against the four-preset table ask this
 * question; `presetProperties` is the one to use for anything new.
 */
export function presetProperty(preset: PresetName): AnimatableProperty | null {
  const properties = presetProperties(preset);
  return properties.length === 1 ? properties[0] : null;
}

/** Whether `focus` does anything for this preset. */
export function presetIsFocusable(preset: PresetName): boolean {
  return PRESETS[preset]?.focusable === true;
}

/**
 * The length this preset is meant to run for.
 *
 * They differ by more than an order of magnitude — a punch is 180ms and a drift
 * is four seconds — so there is no shared default that is right for both, and a
 * caller who omits the duration wants the one the move was designed around.
 */
export function presetDefaultMs(preset: PresetName): number {
  return PRESETS[preset]?.defaultMs ?? 250;
}

/** A point to zoom towards, in the element's own box: 0-100 per axis. */
export type Focus = { x: number; y: number };

/**
 * How far to shift the clip so `focus` stays put while it scales.
 *
 * `localMatrixOf` composes `T(x, y) · T(c) · R · S · T(-c)`, so with no
 * rotation a point `p` in the element's box lands at `x + c + s·(p - c)`. The
 * centre is a fixed point of that — which is exactly the problem: a zoom always
 * converges on the middle, so "punch in on the face" needs the clip pushed the
 * other way as it grows.
 *
 * Holding `p = F` still means `x_s = x_1 + (1 - s)·(F - c)`, and that is this
 * function. At `focus = {50, 50}` the term vanishes, so the centre costs
 * nothing and needs no special case.
 *
 * Rotation is not accounted for. A rotated clip's focus would need the offset
 * turned through the same angle, and a preset that both rotates and zooms
 * toward a point is not one of these.
 */
export function focusOffset(
  focus: Focus,
  scale: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const s = scale / 10;
  // `+ 0` normalises the negative zero a centred focus produces. It is the same
  // number, and it would be invisible in JSON — but it survives into stored
  // keyframe values, where an equality check later fails for a reason nobody
  // can see in the file.
  return {
    x: (1 - s) * width * (focus.x / 100 - 0.5) + 0,
    y: (1 - s) * height * (focus.y / 100 - 0.5) + 0,
  };
}

/** Where a stop falls, in element-local ms. */
function timeOf(stop: { at: number }, startAt: number, length: number): number {
  return startAt + stop.at * length;
}

/**
 * Write one property's stops, with their easings, onto the document.
 *
 * Handles are set in a second pass over the same stops for the reason
 * `commands/animation.ts` does it: a curve belongs to the segment, so both of
 * its anchors have to exist before it can be projected.
 */
function writeTrack(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lanes: Array<{ lane: "x" | "y"; values: number[] }>,
  times: number[],
  easings: Array<EasingName | undefined>,
  bakeHz: number,
): TimelineDocument {
  let next = setTrackActive(doc, elementId, property, true, undefined, bakeHz);

  for (const { lane, values } of lanes) {
    for (let i = 0; i < times.length; i++) {
      next = addKeyframe(
        next,
        elementId,
        property,
        lane,
        times[i],
        values[i],
        undefined,
        bakeHz,
      );
    }
  }

  for (const { lane, values } of lanes) {
    for (let i = 0; i < times.length - 1; i++) {
      const curve = easings[i] == null ? null : resolveEasing(easings[i]);
      if (curve == null) {
        continue;
      }
      const list = (next.elements[elementId] as any)?.animation?.[property]?.[
        lane
      ];
      if (!Array.isArray(list)) {
        continue;
      }
      const from = list.findIndex(
        (k: any) => Math.abs((k?.p?.[0] ?? 0) - times[i]) <= 1,
      );
      const to = list.findIndex(
        (k: any) => Math.abs((k?.p?.[0] ?? 0) - times[i + 1]) <= 1,
      );
      if (from < 0 || to !== from + 1) {
        continue;
      }

      const { ce, cs } = projectEasing(
        curve,
        { atMs: list[from].p[0], value: list[from].p[1] },
        { atMs: list[to].p[0], value: list[to].p[1] },
      );
      next = setHandles(next, elementId, property, lane, from, { ce }, bakeHz);
      next = setHandles(next, elementId, property, lane, to, { cs }, bakeHz);
    }
  }

  return next;
}

/**
 * Apply a preset to one element.
 *
 * Returns the document unchanged, by identity, when the element is missing or
 * cannot animate what the preset drives — a GIF and an audio clip carry no
 * `animation` block at all, and a shape carries only `opacity`.
 *
 * Keyframe times are element-local, which is the convention `keyframeOps` works
 * in: `0` is the clip's own start.
 */
export function applyPreset(
  doc: TimelineDocument,
  elementId: string,
  preset: PresetName,
  durationMs: number,
  bakeHz: number = BAKE_HZ,
  options: { focus?: Focus } = {},
): TimelineDocument {
  const shape = PRESETS[preset];
  const element = doc.elements[elementId] as any;

  if (shape == null || element == null) {
    return doc;
  }

  const available = animatableProperties(element);
  const needed = presetProperties(preset);
  // Every property or none. A `pop` that got its scale and not its opacity
  // would be a different move, silently.
  if (!needed.every((property) => available.includes(property))) {
    return doc;
  }

  const span = spanLength(element);
  // A preset longer than the clip is clamped rather than refused: "fade this
  // in" on a 200ms clip is a coherent request, and the default should not turn
  // it into an error.
  const length = Math.max(1, Math.min(durationMs, span));
  const startAt = shape.fromEnd ? Math.max(0, span - length) : 0;

  let next = doc;

  if (shape.opacity) {
    next = writeTrack(
      next,
      elementId,
      "opacity",
      [{ lane: "x", values: shape.opacity.map((s) => s.value) }],
      shape.opacity.map((s) => timeOf(s, startAt, length)),
      shape.opacity.map((s) => s.easing),
      bakeHz,
    );
  }

  if (shape.rotation) {
    const base = element.rotation ?? 0;
    next = writeTrack(
      next,
      elementId,
      "rotation",
      [{ lane: "x", values: shape.rotation.map((s) => base + s.value) }],
      shape.rotation.map((s) => timeOf(s, startAt, length)),
      shape.rotation.map((s) => s.easing),
      bakeHz,
    );
  }

  if (shape.scale) {
    next = writeTrack(
      next,
      elementId,
      "scale",
      [{ lane: "x", values: shape.scale.map((s) => s.value) }],
      shape.scale.map((s) => timeOf(s, startAt, length)),
      shape.scale.map((s) => s.easing),
      bakeHz,
    );

    // Focus is a position track derived from the scale one, sharing its times
    // and its easings so the two stay in step. Without that the counter-move
    // would lag the zoom and the focus point would wander.
    if (options.focus != null && shape.focusable === true) {
      const width = element.width ?? 0;
      const height = element.height ?? 0;
      const baseX = element.location?.x ?? 0;
      const baseY = element.location?.y ?? 0;

      const offsets = shape.scale.map((s) =>
        focusOffset(options.focus as Focus, s.value, width, height),
      );

      next = writeTrack(
        next,
        elementId,
        "position",
        [
          { lane: "x", values: offsets.map((o) => baseX + o.x) },
          { lane: "y", values: offsets.map((o) => baseY + o.y) },
        ],
        shape.scale.map((s) => timeOf(s, startAt, length)),
        shape.scale.map((s) => s.easing),
        bakeHz,
      );
    }
  }

  if (shape.position) {
    const baseX = element.location?.x ?? 0;
    const baseY = element.location?.y ?? 0;
    next = writeTrack(
      next,
      elementId,
      "position",
      [
        { lane: "x", values: shape.position.map((s) => baseX + s.x) },
        { lane: "y", values: shape.position.map((s) => baseY + s.y) },
      ],
      shape.position.map((s) => timeOf(s, startAt, length)),
      shape.position.map((s) => s.easing),
      bakeHz,
    );
  }

  return next;
}
