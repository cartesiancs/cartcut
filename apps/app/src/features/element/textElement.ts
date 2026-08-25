/**
 * The shape of a text element, in one place.
 *
 * `ElementControl.addText` used to be the only way to make one, and it both
 * built the element and committed it — one `withCheckpoint` per call. That is
 * right for a user clicking "add text" and wrong for a transcript: forty
 * caption lines became forty undo steps, so undoing "add subtitles" meant
 * pressing Cmd+Z forty times.
 *
 * Splitting construction from commitment lets a batch caller place all forty in
 * a single transform, while `addText` keeps its existing one-shot behaviour by
 * calling this and committing immediately.
 */

import { emptyAnimation } from "../animation/keyframes";
import type { TextElementType } from "../../@types/timeline";

export type TextElementOptions = {
  text?: string;
  textcolor?: string;
  fontsize?: number;
  optionsAlign?: "left" | "center" | "right";
  backgroundEnable?: boolean;
  locationX?: number;
  locationY?: number;
  height?: number;
  width?: number;
  startTime?: number;
  duration?: number;

  /**
   * The font, as the three fields that have to agree — see
   * `features/font/fontFaces.ts`. A caller passing these is also responsible
   * for having called `ensureFontFace`, or the element draws in the fallback in
   * both the preview and the export.
   */
  fontpath?: string;
  fontname?: string;
  fonttype?: string;

  letterSpacing?: number;
  isBold?: boolean;
  isItalic?: boolean;
  /** `enable` defaults to false, so passing a size alone does not turn it on. */
  outline?: { enable?: boolean; size?: number; color?: string };
  backgroundColor?: string;
};

export function createTextElement({
  text = "TITLE",
  textcolor = "#ffffff",
  fontsize = 52,
  optionsAlign = "left",
  backgroundEnable = false,
  locationX = 0,
  locationY = 0,
  height = 66,
  width = 500,
  startTime = 0,
  duration = 1000,
  fontpath = "default",
  fontname = "notosanskr",
  fonttype = "otf",
  letterSpacing = 0,
  isBold = false,
  isItalic = false,
  outline,
  backgroundColor = "#000000",
}: TextElementOptions): TextElementType {
  return {
    startTime: startTime,
    duration: duration,
    text: text,
    textcolor: textcolor,
    fontsize: fontsize,
    fontpath: fontpath,
    fontname: fontname,
    fontweight: "medium",
    fonttype: fonttype,
    letterSpacing: letterSpacing,
    options: {
      isBold: isBold,
      isItalic: isItalic,
      align: optionsAlign,
      outline: {
        enable: outline?.enable ?? false,
        size: outline?.size ?? 1,
        color: outline?.color ?? "#000000",
      },
    },
    background: {
      enable: backgroundEnable,
      color: backgroundColor,
    },
    location: { x: locationX, y: locationY },
    rotation: 0,
    localpath: "/TEXTELEMENT",
    filetype: "text",
    height: height,
    width: width,
    widthInner: 200,
    opacity: 100,
    animation: emptyAnimation("text"),
    timelineOptions: {
      color: "rgb(59, 143, 179)",
    },
  } as TextElementType;
}
