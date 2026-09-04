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

import type { AnimatableProperty, TimelineElement } from "../../@types/timeline";
import { animatableProperties } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import { spanLength, spanOf } from "../timeline/geometry";
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
  | "rotate_settle"
  | "slide_in_up"
  | "slide_in_down"
  | "slide_in_left"
  | "slide_in_right"
  | "slide_out_up"
  | "slide_out_down"
  | "slide_out_left"
  | "slide_out_right";

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

/**
 * A position stop, **offset from where the clip already sits**.
 *
 * In pixels, unless the shape says `positionUnit: "box"`.
 */
type Move = { at: number; x: number; y: number; easing?: EasingName };

/**
 * Smallest slide a box-relative preset may travel, in pixels.
 *
 * A text clip whose height has not been fitted yet, or a shape authored at
 * zero, would otherwise animate from its own position to its own position:
 * keyframes written, nothing visibly moving, and no way to tell from the
 * timeline that the preset landed at all.
 */
export const MIN_SLIDE_PX = 40;

type PresetShape = {
  /** Used when the caller does not give one. */
  defaultMs: number;
  /** Anchored to the clip's end rather than its start. */
  fromEnd?: boolean;
  /**
   * How `position` stops are read. `"px"` when absent.
   *
   * `"box"` multiplies `x` by the element's width and `y` by its height, so one
   * unit is one of the clip's own box lengths. A slide written in pixels is a
   * different move in a 4K project than in a 1080p one, and a different move
   * under a one-line caption than under a full-bleed title — the distance that
   * reads as "in from off the edge" is a property of the thing being moved.
   *
   * `shake` stays in pixels: a rattle of fourteen pixels is a rattle whatever
   * it is rattling, and scaling it by the clip's size would make a title-card
   * shake like an earthquake and a caption not at all.
   */
  positionUnit?: "px" | "box";
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

  // ---- the directional slides ----
  //
  // Eight presets that are one preset with a sign and an axis, written out
  // rather than generated because `PresetName` is a closed union the MCP
  // schema copies by hand — a generated table would name them somewhere a
  // reader cannot grep for.
  //
  // Canvas x grows rightward and y grows downward, so a move *up* ends lower
  // in value than it started. `slide_in_up` therefore begins one box-height
  // **below** its resting place, at `y: 1`.
  //
  // **They fade as well as move.** A slide with no fade brings a fully opaque
  // title in from off the edge of the frame, or cuts one off mid-flight —
  // which is why Premiere's and Final Cut's own slides pair the two. The fade
  // covers only part of the move (0.6 in, 0.4 out) so the travel is still
  // visible at both ends rather than happening entirely under a dissolve.
  //
  // `in` eases out — it arrives and settles. `out` eases in — it leaves and
  // accelerates away. Reversing those makes both read as a drift.

  slide_in_up: {
    defaultMs: 420,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: 1, easing: "ease_out" },
      { at: 1, x: 0, y: 0 },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.6, value: 100 },
    ],
  },

  slide_in_down: {
    defaultMs: 420,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: -1, easing: "ease_out" },
      { at: 1, x: 0, y: 0 },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.6, value: 100 },
    ],
  },

  slide_in_left: {
    defaultMs: 420,
    positionUnit: "box",
    position: [
      { at: 0, x: 1, y: 0, easing: "ease_out" },
      { at: 1, x: 0, y: 0 },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.6, value: 100 },
    ],
  },

  slide_in_right: {
    defaultMs: 420,
    positionUnit: "box",
    position: [
      { at: 0, x: -1, y: 0, easing: "ease_out" },
      { at: 1, x: 0, y: 0 },
    ],
    opacity: [
      { at: 0, value: 0, easing: "ease_out" },
      { at: 0.6, value: 100 },
    ],
  },

  slide_out_up: {
    defaultMs: 420,
    fromEnd: true,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: 0, easing: "ease_in" },
      { at: 1, x: 0, y: -1 },
    ],
    opacity: [
      { at: 0.4, value: 100, easing: "ease_in" },
      { at: 1, value: 0 },
    ],
  },

  slide_out_down: {
    defaultMs: 420,
    fromEnd: true,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: 0, easing: "ease_in" },
      { at: 1, x: 0, y: 1 },
    ],
    opacity: [
      { at: 0.4, value: 100, easing: "ease_in" },
      { at: 1, value: 0 },
    ],
  },

  slide_out_left: {
    defaultMs: 420,
    fromEnd: true,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: 0, easing: "ease_in" },
      { at: 1, x: -1, y: 0 },
    ],
    opacity: [
      { at: 0.4, value: 100, easing: "ease_in" },
      { at: 1, value: 0 },
    ],
  },

  slide_out_right: {
    defaultMs: 420,
    fromEnd: true,
    positionUnit: "box",
    position: [
      { at: 0, x: 0, y: 0, easing: "ease_in" },
      { at: 1, x: 1, y: 0 },
    ],
    opacity: [
      { at: 0.4, value: 100, easing: "ease_in" },
      { at: 1, value: 0 },
    ],
  },
};

/**
 * What a person reads on the tile.
 *
 * The ids are systematic so they sort and group; these are what the panel
 * shows. English, and staying English, for the reason `fxPresetBrowser` and
 * `ControlText` both give: a preset library reads worse half-localised than it
 * does consistently in one language.
 */
const LABELS: Record<PresetName, string> = {
  fade_in: "Fade In",
  fade_out: "Fade Out",
  zoom_in: "Zoom In",
  zoom_out: "Zoom Out",
  punch_in: "Punch In",
  drift: "Drift",
  overshoot_in: "Overshoot",
  pop: "Pop",
  slam: "Slam",
  shake: "Shake",
  rotate_settle: "Rotate In",
  slide_in_up: "Move Up",
  slide_in_down: "Move Down",
  slide_in_left: "Move Left",
  slide_in_right: "Move Right",
  slide_out_up: "Exit Up",
  slide_out_down: "Exit Down",
  slide_out_left: "Exit Left",
  slide_out_right: "Exit Right",
};

/**
 * Which third of the panel a preset belongs to.
 *
 * `in` and `out` are the ones with somewhere to be — they are built to sit at
 * one end of a clip, and `fromEnd` is the same fact stated for the unanchored
 * path. `emphasis` is everything that happens in the middle and returns to
 * where it started.
 */
export type PresetGroup = "in" | "out" | "emphasis";

const GROUPS: Record<PresetName, PresetGroup> = {
  fade_in: "in",
  zoom_in: "in",
  punch_in: "in",
  overshoot_in: "in",
  pop: "in",
  slam: "in",
  rotate_settle: "in",
  slide_in_up: "in",
  slide_in_down: "in",
  slide_in_left: "in",
  slide_in_right: "in",

  fade_out: "out",
  zoom_out: "out",
  slide_out_up: "out",
  slide_out_down: "out",
  slide_out_left: "out",
  slide_out_right: "out",

  drift: "emphasis",
  shake: "emphasis",
};

export function presetLabel(preset: PresetName): string {
  return LABELS[preset] ?? preset;
}

export function presetGroup(preset: PresetName): PresetGroup {
  return GROUPS[preset] ?? "emphasis";
}

/**
 * Where the playhead falls inside a clip, in the element-local ms
 * `applyPreset`'s `startAtMs` wants — or `undefined` when it falls outside.
 *
 * `undefined` means "do not anchor", and the preset lands where it was designed
 * to: the clip's start, or its end for a `fromEnd` one. That is deliberately
 * not a refusal. A tile that does nothing because the playhead happens to be
 * parked elsewhere is the worst outcome a preset grid can have, and this is the
 * same call `fxPresetBrowser` makes when a click has no obvious target.
 *
 * The span is half-open, `[start, end)`, which is the convention `spanOf` and
 * every consumer of it already use: the instant a clip ends is the instant the
 * next one begins, and both cannot own it.
 */
export function playheadAnchor(
  element: TimelineElement | null | undefined,
  cursor: number,
): number | undefined {
  if (element == null || !Number.isFinite(cursor)) {
    return undefined;
  }
  const span = spanOf(element);
  if (cursor < span.start || cursor >= span.end) {
    return undefined;
  }
  return cursor - span.start;
}

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
 * in: `0` is the clip's own start. `options.startAtMs` is in that same space —
 * the caller converts from the playhead with `playheadAnchor`, never by handing
 * an absolute timeline time here.
 */
export function applyPreset(
  doc: TimelineDocument,
  elementId: string,
  preset: PresetName,
  durationMs: number,
  bakeHz: number = BAKE_HZ,
  options: { focus?: Focus; startAtMs?: number } = {},
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
  const requested = Math.max(1, Math.min(durationMs, span));

  /*
   * Where the move begins, in element-local ms.
   *
   * Anchored, the caller wins: `startAtMs` outranks `fromEnd`, because the
   * anchor is the playhead and the playhead is a thing the user pointed at.
   * A `fade_out` dropped at 1s runs 1s -> 1.25s, not at the clip's tail.
   *
   * Near the end of the clip the preset is **compressed** rather than pulled
   * back. Sliding the anchor to make room would start the move somewhere the
   * user did not click, which is the one thing an anchor is for; a fade that is
   * shorter than asked is still a fade beginning where they asked. The clamp
   * leaves one millisecond so a preset always has a segment to ease across.
   */
  const anchored = options.startAtMs != null;
  const startAt = anchored
    ? Math.max(0, Math.min(options.startAtMs as number, Math.max(0, span - 1)))
    : shape.fromEnd
      ? Math.max(0, span - requested)
      : 0;
  const length = anchored
    ? Math.max(1, Math.min(requested, span - startAt))
    : requested;

  // One box length per unit for a `"box"` preset, floored so a clip with no
  // height still travels. `1` for the pixel presets, which multiplies out.
  const boxUnit =
    shape.positionUnit === "box"
      ? {
          x: Math.max(element.width ?? 0, MIN_SLIDE_PX),
          y: Math.max(element.height ?? 0, MIN_SLIDE_PX),
        }
      : { x: 1, y: 1 };

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
        { lane: "x", values: shape.position.map((s) => baseX + s.x * boxUnit.x) },
        { lane: "y", values: shape.position.map((s) => baseY + s.y * boxUnit.y) },
      ],
      shape.position.map((s) => timeOf(s, startAt, length)),
      shape.position.map((s) => s.easing),
      bakeHz,
    );
  }

  return next;
}
