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
}: TextElementOptions): TextElementType {
  return {
    startTime: startTime,
    duration: duration,
    text: text,
    textcolor: textcolor,
    fontsize: fontsize,
    fontpath: "default",
    fontname: "notosanskr",
    fontweight: "medium",
    fonttype: "otf",
    letterSpacing: 0,
    options: {
      isBold: false,
      isItalic: false,
      align: optionsAlign,
      outline: {
        enable: false,
        size: 1,
        color: "#000000",
      },
    },
    background: {
      enable: backgroundEnable,
      color: "#000000",
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
