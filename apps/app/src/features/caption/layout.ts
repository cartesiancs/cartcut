/**
 * Where a caption sits in the frame.
 *
 * Extracted because there were **three** copies of this arithmetic:
 * `agent/commands/text.ts#defaultLayout` for `add_subtitles`,
 * `ui/control/ControlText.ts#layoutFor` for titles (the vertically-centred
 * variant), and the auto-caption panel's own hardcoded version. The first of
 * those even claimed in its doc comment to be "the same placement the
 * auto-caption panel computes" — which was not true: the panel worked in a
 * literal 1080 while this derived from the project, so the two disagreed on
 * every project that was not 1080p.
 *
 * **The frame is a parameter, not a store read.** `renderOptionStore` would
 * drag zustand in, and `apps/automatic-caption/` resolves its packages from its
 * own `node_modules`; keeping this module dependency-free is what lets the
 * panel import it, and what lets it be tested under `environment: "node"` —
 * the same argument `locale.ts` makes for living here rather than in the panel.
 * `text/metrics.ts` is safe to reach for: its only import is `import type`, so
 * nothing of it survives to runtime.
 */

import { defaultTextHeight } from "../text/metrics";

/** The project's frame, in pixels. `renderOptionStore.options.previewSize`. */
export type CaptionFrame = { w: number; h: number };

/**
 * Where the caption block sits vertically.
 *
 * Not to be confused with `optionsAlign` / `options.align`, which is the
 * *horizontal* alignment of the text inside its own box. Two different axes,
 * and the auto-caption panel used to call both of them "align".
 */
export type CaptionPlacement = "lowerThird" | "center";

/** Anything the caller wants to pin. Everything absent is derived from `frame`. */
export type CaptionStyleOverrides = {
  fontsize?: number;
  height?: number;
  width?: number;
  locationX?: number;
  locationY?: number;
};

export type CaptionLayout = {
  fontsize: number;
  height: number;
  width: number;
  locationX: number;
  locationY: number;
};

/** A `CaptionLayout` plus the fixed look. Assignable to `TextElementOptions`. */
export type CaptionStyle = CaptionLayout & {
  textcolor: string;
  optionsAlign: "center";
  backgroundEnable: true;
};

/**
 * A caption box for this frame.
 *
 * Everything is a fraction of the frame's **height**, including the font size,
 * so a caption keeps its proportions on a vertical project instead of being
 * sized for a landscape one and running off the bottom. `width` is the full
 * frame because the box is the wrapping width and the text is centred within
 * it — a narrower box would re-wrap rather than re-centre.
 */
export function captionLayout(
  frame: CaptionFrame,
  placement: CaptionPlacement = "lowerThird",
  style: CaptionStyleOverrides = {},
): CaptionLayout {
  const h = Number.isFinite(frame.h) && frame.h > 0 ? frame.h : 1080;
  const w = Number.isFinite(frame.w) && frame.w > 0 ? frame.w : 1920;

  const fontsize = style.fontsize ?? Math.round(h / 20);
  const height = style.height ?? defaultTextHeight(fontsize);

  return {
    fontsize,
    height,
    width: style.width ?? w,
    locationX: style.locationX ?? 0,
    locationY: style.locationY ?? defaultY(h, fontsize, height, placement),
  };
}

/**
 * Everything that makes a caption a caption, except its words.
 *
 * The box from `captionLayout` plus the four constants the auto-caption panel
 * has always applied: white, centred, with a background band. It is what both
 * halves of the panel are built on — the preview draws
 * `createTextElement(captionStyle(...) + text)`, and the emitted row is the same
 * object with the caption's own `text`/`startTime`/`duration` spread over it —
 * so the preview and the placed clip cannot differ in anything that reaches the
 * picture.
 *
 * **It takes no line index, and that is the point.** The panel's version read
 * `lines[index].text` and was called with the index of the *filtered*
 * `captionsFrom` output, so on any transcript where the user had emptied a line
 * the two lists disagreed from that line on. It was harmless only because the
 * caption's own `text` was spread afterwards and overwrote the wrong one — a
 * load-bearing spread order, and a trap waiting for the first per-line style
 * property anyone adds. Taking the index away is a subtraction, not a fix:
 * nothing downstream was reading the field it produced.
 */
export function captionStyle(
  frame: CaptionFrame,
  placement: CaptionPlacement = "lowerThird",
  style: CaptionStyleOverrides = {},
): CaptionStyle {
  return {
    ...captionLayout(frame, placement, style),
    textcolor: "#ffffff",
    optionsAlign: "center",
    backgroundEnable: true,
  };
}

function defaultY(
  h: number,
  fontsize: number,
  height: number,
  placement: CaptionPlacement,
): number {
  if (placement === "center") {
    // The box's own height, not the font size: `renderText` puts the first
    // baseline a font size below the element's top edge, so centring on the
    // font size alone would sit the block low by its descent.
    return Math.round(h / 2 - height / 2);
  }
  return h - Math.round(h / 10) - fontsize;
}
