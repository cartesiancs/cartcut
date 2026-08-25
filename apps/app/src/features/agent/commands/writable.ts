/**
 * What `update_clip` is allowed to write, and what it deliberately is not.
 *
 * Whitelisted rather than filtered, and opted in per element type. The fields
 * kept out are not an oversight — each one is either coupled to a second field
 * that has to change with it, or has a consequence beyond the element:
 *
 *  - `startTime` / `duration` / `trim` are bound by the invariants in
 *    `features/timeline/geometry.ts`. `trim_clip` and `move_clips` own timing.
 *  - `speed` divides the timeline span, so writing it resizes the clip and can
 *    overlap its neighbour. `set_clip_speed` checks for that; a blind patch
 *    could not.
 *  - `fontname` / `fontpath` / `fonttype` must agree with each other, and the
 *    family needs an `@font-face` injected or the canvas silently draws in the
 *    fallback. `set_text_font` writes all three and injects the face.
 *  - `filter.list` entries carry a positional `k=v:k=v` string.
 *    `set_video_filters` formats it.
 *  - `trackId` bypasses the collision check that makes `moveClips` atomic.
 *  - `parentId` without a reframe teleports the clip; `set_clip_parent` does
 *    the arithmetic.
 *  - a shape's `shape` point list is unbounded.
 *
 * `update_clip`'s error message lists the writable paths for the clip at hand,
 * so an agent that guesses wrong is told what it may write instead of being
 * left to guess again.
 */

import type { TimelineElement } from "../../../@types/timeline";

/** Property paths `update_clip` will write, by element type. */
export const WRITABLE: Record<string, string[][]> = {
  common: [
    ["location", "x"],
    ["location", "y"],
    ["width"],
    ["height"],
    ["opacity"],
    ["rotation"],
  ],
  text: [
    ["text"],
    ["textcolor"],
    ["fontsize"],
    ["letterSpacing"],
    ["options", "align"],
    ["options", "isBold"],
    ["options", "isItalic"],
    ["options", "outline", "enable"],
    ["options", "outline", "size"],
    ["options", "outline", "color"],
    ["options", "outline", "opacity"],
    ["options", "textTransform"],
    ["options", "shadow", "enable"],
    ["options", "shadow", "offsetX"],
    ["options", "shadow", "offsetY"],
    ["options", "shadow", "blur"],
    ["options", "shadow", "color"],
    ["options", "shadow", "opacity"],
    ["options", "glow", "enable"],
    ["options", "glow", "size"],
    ["options", "glow", "color"],
    ["options", "glow", "opacity"],
    ["background", "enable"],
    ["background", "color"],
    ["background", "opacity"],
    ["background", "padding"],
    ["background", "radius"],
    ["textOpacity"],
    // Leaves, not the whole object: `flatten` recurses into nested patches, so
    // a `["fill"]` entry would never match anything it produces. A patch that
    // sets only `fill.type` is safe because `resolveTextStyle#resolveFill`
    // supplies default stops for a gradient missing its colours.
    ["fill", "type"],
    ["fill", "from"],
    ["fill", "to"],
    ["fill", "angle"],
  ],
  shape: [["option", "fillColor"]],
  video: [["filter", "enable"], ["volumeDb"]],
  audio: [["volumeDb"]],
  group: [["name"]],
};

/**
 * Bounds for the values that have them.
 *
 * Without this, `flatten` + `setIn` writes whatever arrives: `opacity: 500` or
 * `rotation: "45deg"` produces an element the compositor cannot draw, and the
 * failure surfaces much later as a blank frame rather than as a rejected tool
 * call. Paths absent here take any finite value.
 */
export const RANGES: Record<string, { min?: number; max?: number }> = {
  opacity: { min: 0, max: 100 },
  "options.outline.size": { min: 0, max: 100 },
  "options.outline.opacity": { min: 0, max: 100 },
  "options.shadow.offsetX": { min: -1000, max: 1000 },
  "options.shadow.offsetY": { min: -1000, max: 1000 },
  // Canvas throws on a negative `shadowBlur`, so this bound is not cosmetic.
  "options.shadow.blur": { min: 0, max: 500 },
  "options.shadow.opacity": { min: 0, max: 100 },
  "options.glow.size": { min: 0, max: 500 },
  "options.glow.opacity": { min: 0, max: 100 },
  "background.opacity": { min: 0, max: 100 },
  "background.padding": { min: 0, max: 500 },
  "background.radius": { min: 0, max: 500 },
  textOpacity: { min: 0, max: 100 },
  "fill.angle": { min: 0, max: 360 },
  fontsize: { min: 1, max: 2000 },
  width: { min: 0 },
  height: { min: 0 },
  // Attenuation only. The ceiling is 0 dB because the preview caps at unity
  // gain, so a boost would export louder than it played — see
  // `features/timeline/audio.ts`. Rejected rather than clamped: an agent that
  // is told the bound learns something, where a mouse drag cannot be told
  // anything and so is clamped in `setVolumeDb` instead.
  volumeDb: { min: -60, max: 0 },
};

/** Values that must be one of a fixed set. */
export const ENUMS: Record<string, readonly string[]> = {
  "options.align": ["left", "center", "right"],
  "options.textTransform": ["none", "uppercase", "lowercase"],
  "fill.type": ["solid", "gradient"],
};

export function writablePaths(element: TimelineElement): string[][] {
  // Audio has no picture, so the shared transform block does not apply to it —
  // its own entry is the whole of what it can be patched with.
  const common = element.filetype === "audio" ? [] : WRITABLE.common;
  return [...common, ...(WRITABLE[element.filetype] ?? [])];
}

/** `{a: {b: 1}}` -> `[[["a","b"], 1]]`, so a nested patch becomes path writes. */
export function flatten(
  patch: Record<string, any>,
  prefix: string[] = [],
): Array<[string[], unknown]> {
  const out: Array<[string[], unknown]> = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key];
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value, path));
    } else {
      out.push([path, value]);
    }
  }
  return out;
}

/**
 * Why this write cannot be made, or `null` if it can.
 *
 * Returns a sentence rather than a boolean because the whole value of a
 * whitelist to an agent is being told what it may write instead.
 */
export function rejectionFor(
  name: string,
  value: unknown,
): string | null {
  const choices = ENUMS[name];
  if (choices != null) {
    return choices.includes(value as string)
      ? null
      : `${name} must be one of ${choices.join(", ")} (got ${JSON.stringify(value)}).`;
  }

  const range = RANGES[name];
  if (range == null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${name} must be a finite number (got ${JSON.stringify(value)}).`;
  }
  if (range.min != null && value < range.min) {
    return `${name} must be at least ${range.min} (got ${value}).`;
  }
  if (range.max != null && value > range.max) {
    return `${name} must be at most ${range.max} (got ${value}).`;
  }
  return null;
}
