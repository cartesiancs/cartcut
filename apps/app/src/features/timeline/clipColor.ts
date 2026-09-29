/**
 * The colour a clip's bar is painted in on the timeline.
 *
 * Every clip carries `timelineOptions.color`, stamped once when it is created.
 * Almost none of those values were ever chosen by anybody: they are the
 * creation sites' defaults, and they are muddy mid-tones that sit badly next
 * to the option panel. So the painter reads the stored value through this
 * function, which swaps a known default for the current palette and leaves
 * anything else alone. A colour the user did choose (a group or null created
 * with `color` over MCP) still paints as chosen.
 *
 * Read-side only. The stored value is never rewritten, so a project saves
 * byte-identically whether or not it has been opened since the palette moved,
 * and moving it again needs nothing but this file.
 */

import type { TimelineElement } from "../../@types/timeline";

type ClipKind = TimelineElement["filetype"];

/**
 * Tailwind's 600 step, and 500 for the neutral.
 *
 * 600 rather than 500 because the label is white and drawn without a halo on a
 * flat bar: at 500, orange and cyan fall under 3:1 against white. Group (and
 * so null, which is a group) is the one neutral, because it carries no media
 * and should read as structure next to the clips that do.
 */
export const CLIP_PALETTE: Readonly<Record<ClipKind, string>> = {
  video: "#2563eb",
  audio: "#059669",
  image: "#c026d3",
  gif: "#c026d3",
  text: "#ea580c",
  shape: "#db2777",
  effect: "#7c3aed",
  template: "#0891b2",
  group: "#71717a",
  // Never painted as a bar (a transition is drawn as a badge on its cut), but
  // the record is total so a new filetype cannot be added without a colour.
  transition: "#52525b",
};

/** What a clip with no usable type or colour is painted in. */
export const CLIP_FALLBACK = "#52525b";

/**
 * Every value a creation site has ever stamped as a default.
 *
 * Matched regardless of which type stamped it: several are shared between
 * types, and a default is a default whichever clip it landed on. Most of these
 * live in file-private constants, hence the copies:
 *
 *   rgb(71, 59, 179)    video       element/mediaElement.ts
 *   rgb(133, 179, 59)   audio       element/mediaElement.ts, timeline/audio.ts
 *   rgb(134, 41, 143)   image, gif  element/mediaElement.ts, timeline/rasterize.ts
 *   rgb(59, 143, 179)   text, shape element/textElement.ts, element/shapeElement.ts
 *   rgb(120, 170, 140)  effect      element/effectElement.ts
 *   rgb(120, 110, 190)  group, null timeline/groupOps.ts, element/nullElement.ts
 *   #6a5acd             template    timeline/templateOps.ts
 *   #4a4b57             the painter's own fallback before this file
 */
const LEGACY_DEFAULTS = new Set(
  [
    "rgb(71, 59, 179)",
    "rgb(133, 179, 59)",
    "rgb(134, 41, 143)",
    "rgb(59, 143, 179)",
    "rgb(120, 170, 140)",
    "rgb(120, 110, 190)",
    "#6a5acd",
    "#4a4b57",
  ].map(canonical),
);

/** `rgb(71,59,179)` and `RGB(71, 59, 179)` are the same stored default. */
function canonical(color: string): string {
  return color.replace(/\s+/g, "").toLowerCase();
}

/** Whether `color` is a creation default rather than somebody's choice. */
export function isDefaultClipColor(color: string): boolean {
  return LEGACY_DEFAULTS.has(canonical(color));
}

/** The fill for `element`'s bar. Never throws; runs on every paint. */
export function clipColorOf(element: TimelineElement): string {
  const stored = element.timelineOptions?.color;
  if (typeof stored === "string" && stored.trim() !== "" && !isDefaultClipColor(stored)) {
    return stored;
  }
  return CLIP_PALETTE[element.filetype] ?? CLIP_FALLBACK;
}
