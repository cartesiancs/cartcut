/**
 * A text preset, as the options `createTextElement` takes.
 *
 * The one place a preset becomes an element. The panel's click and the
 * panel's tile both come through here (the tile in `features/text/textTile.ts`),
 * so the picture on the tile and the clip the click adds cannot disagree:
 * there is no second reading of the preset to drift.
 *
 * Geometry is derived from the frame being edited rather than assuming 1080p,
 * the same derivation `features/agent/commands/text.ts#defaultLayout` uses for
 * captions, but centred vertically because these are titles, not subtitles.
 * Every length a preset states (stroke, shadow, glow, tracking, the band's
 * padding and radius) is authored against a 1080-pixel-high frame and scaled
 * by the frame's height here, so a look keeps its proportions at 720p and at
 * 4K the way the type size already did. A 1080p project gets the numbers as
 * written.
 *
 * Pure: no store, no DOM. The caller passes the frame.
 */

import type { TextElementOptions } from "../element/textElement";
import { defaultTextHeight } from "../text/metrics";
import { DEFAULT_BACKGROUND_PADDING } from "../text/style";
import type { PresetStyle, TextPreset } from "./textPresets";

/** The frame height a preset's lengths are written against. */
export const PRESET_REFERENCE_HEIGHT = 1080;

export type PresetFrame = { w: number; h: number };

/** What a preset adds when nothing says otherwise. */
export const PRESET_TEXT = "Title";

/** Two decimals: enough for a stroke, and 1080p's factor of 1 stays exact. */
function scaled(value: number, factor: number): number {
  return Math.round(value * factor * 100) / 100;
}

/**
 * Element-space geometry for a preset's text: a box across the whole frame,
 * centred vertically, at a size derived from the frame's height.
 */
export function presetLayout(
  style: Pick<PresetStyle, "sizeScale">,
  frame: PresetFrame,
): Pick<
  TextElementOptions,
  "fontsize" | "height" | "width" | "locationX" | "locationY"
> {
  const fontsize = Math.round((frame.h / 20) * (style.sizeScale ?? 1));
  const height = defaultTextHeight(fontsize);

  return {
    fontsize,
    height,
    width: frame.w,
    locationX: 0,
    locationY: Math.round(frame.h / 2 - height / 2),
  };
}

export function textOptionsFor(
  preset: TextPreset,
  frame: PresetFrame,
  text: string = PRESET_TEXT,
): TextElementOptions {
  const { style } = preset;
  const k = frame.h / PRESET_REFERENCE_HEIGHT;
  const background = style.background;

  return {
    ...presetLayout(style, frame),
    text,
    fontpath: preset.path,
    fontname: preset.family,
    fonttype: preset.type,
    textcolor: style.textcolor,
    letterSpacing: scaled(style.letterSpacing ?? 0, k),
    isBold: style.isBold ?? false,
    isItalic: style.isItalic ?? false,
    // Centred, not left: a preset's box spans the whole frame, so the element
    // default of `left` at x=0 puts a title hard against the edge with its
    // outline clipped off. The plain "Text" tile keeps the old behaviour;
    // these are titles.
    optionsAlign: style.align ?? "center",
    outline: style.outline
      ? {
          enable: true,
          size: scaled(style.outline.size, k),
          color: style.outline.color,
          opacity: style.outline.opacity,
        }
      : undefined,
    backgroundEnable: background != null,
    backgroundColor: background?.color ?? "#000000",
    backgroundOpacity: background?.opacity,
    // The default padding scales too, or a 4K box hugs its line half as
    // closely as the 1080p one. At 1080p this is the default, which
    // `createTextElement` does not write.
    backgroundPadding:
      background != null
        ? scaled(background.padding ?? DEFAULT_BACKGROUND_PADDING, k)
        : undefined,
    backgroundRadius:
      background?.radius != null ? scaled(background.radius, k) : undefined,
    shadow: style.shadow
      ? {
          enable: true,
          offsetX: scaled(style.shadow.offsetX, k),
          offsetY: scaled(style.shadow.offsetY, k),
          blur: scaled(style.shadow.blur, k),
          color: style.shadow.color,
          opacity: style.shadow.opacity,
        }
      : undefined,
    glow: style.glow
      ? {
          enable: true,
          size: scaled(style.glow.size, k),
          color: style.glow.color,
          opacity: style.glow.opacity,
        }
      : undefined,
    fill: style.gradient
      ? { type: "gradient" as const, ...style.gradient }
      : undefined,
    textTransform: style.textTransform,
    textOpacity: style.textOpacity,
  };
}
