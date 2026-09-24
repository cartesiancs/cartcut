/**
 * Measuring text without drawing it and looking.
 *
 * This exists because of one confusion that costs an edit several round trips:
 * **`fontsize` is the em size, and it is not the height of the letters.** It
 * reaches `ctx.font` verbatim — nothing in the picture path scales it — and
 * what a ruler finds on a screenshot is the *ink*, which for a Latin face is
 * about three quarters of that. 57px of type measures roughly 43px of capital.
 *
 * A second factor compounds it, and the two are easy to mistake for each other
 * because the number is nearly the same: the preview draws through
 * `previewCanvas`'s `g.scale * dpr`, and a 1920-wide frame fitted into a
 * ~1450px panel is a scale of about 0.75 as well. So a pixel counted on a
 * screenshot of the preview is neither the em nor reliably the ink.
 *
 * Hence `unit: "project pixels"` in every answer, and `emSize` reported beside
 * `capHeight` rather than one or the other. Everything here is measured in the
 * project's own coordinates, which is what the exported file is in.
 */

import type { TextElementType } from "../../../@types/timeline";
import { probeContext } from "../../element/textFit";
import { measureTextDetail, selectionRectsOf } from "../../renderer/text";
import { currentDoc } from "../context";
import { registerCommands } from "../registry";
import { requireTextElement, resolveRanges, type RangeSpec } from "./textRange";

/**
 * A text element to measure, from an existing clip, from arguments, or both.
 *
 * Overriding a clip's fields is the useful shape rather than an indulgence:
 * "what would this title be at 80px" is one call, and answering it by writing
 * the size, measuring and writing it back would cost two undo steps for a
 * question.
 *
 * The fields not named here are taken from the clip when there is one, so a
 * measurement of an existing clip accounts for its runs, its case transform
 * and its leading without the caller restating any of them.
 */
type StyleArgs = {
  text?: string;
  fontsize?: number;
  fontname?: string;
  fontweight?: number;
  bold?: boolean;
  italic?: boolean;
  letterSpacing?: number;
  lineHeight?: number;
  width?: number;
};

/** What `layoutFor` reads, with defaults for the fields nothing supplied. */
function syntheticElement(args: StyleArgs): TextElementType {
  return {
    filetype: "text",
    text: args.text ?? "",
    fontsize: args.fontsize ?? 52,
    fontname: args.fontname ?? "notosanskr",
    fontweight: args.fontweight ?? 400,
    fontpath: "default",
    fonttype: "otf",
    letterSpacing: args.letterSpacing ?? 0,
    width: args.width ?? 1920,
    options: {
      isBold: args.bold === true,
      isItalic: args.italic === true,
      align: "left",
      outline: { enable: false, size: 1, color: "#000000" },
      lineHeight: args.lineHeight,
    },
  } as unknown as TextElementType;
}

/** The clip, with any overriding argument written over it. */
function overridden(
  element: TextElementType,
  args: StyleArgs,
): TextElementType {
  const next: any = { ...element, options: { ...element.options } };

  if (args.text !== undefined) {
    // The runs are dropped with the text they were measured against: a run
    // list that has not followed an edit points at the wrong characters, and
    // `setTextWithRuns` is the only thing that knows how to move one. A
    // hypothetical string measured with the old clip's runs would be wrong in
    // a way nothing here could report.
    next.text = args.text;
    delete next.runs;
  }
  if (args.fontsize !== undefined) next.fontsize = args.fontsize;
  if (args.fontname !== undefined) next.fontname = args.fontname;
  if (args.fontweight !== undefined) next.fontweight = args.fontweight;
  if (args.letterSpacing !== undefined) next.letterSpacing = args.letterSpacing;
  if (args.width !== undefined) next.width = args.width;
  if (args.bold !== undefined) next.options.isBold = args.bold;
  if (args.italic !== undefined) next.options.isItalic = args.italic;
  if (args.lineHeight !== undefined) next.options.lineHeight = args.lineHeight;

  return next as TextElementType;
}

registerCommands({
  measure_text: (
    params: StyleArgs & { elementId?: string; ranges?: RangeSpec[] },
  ) => {
    const ctx = probeContext();
    if (ctx == null) {
      throw new Error(
        "Text cannot be measured without a canvas. This is the editor running " +
          "without a window, which should not happen from a tool call.",
      );
    }

    const element =
      params.elementId == null
        ? syntheticElement(params)
        : overridden(requireTextElement(currentDoc(), params.elementId), params);

    if ((element.text ?? "") === "") {
      throw new Error(
        "measure_text needs some text: pass `text`, or an `elementId` of a " +
          "clip that has some.",
      );
    }

    const metrics = measureTextDetail(ctx, element);

    // Named ranges are measured against the same element, so a rect and the
    // block it sits in can never disagree about the wrap.
    const ranges =
      params.ranges == null || params.ranges.length === 0
        ? null
        : resolveRanges(element.text ?? "", params.ranges);

    return {
      // Said out loud because the whole point of the tool is that a pixel
      // counted on a screenshot is a different pixel. See the module header.
      unit: "project pixels",
      ...metrics,
      ...(ranges == null
        ? {}
        : {
            ranges: ranges.map((range) => ({
              from: range.from,
              to: range.to,
              text: (element.text ?? "").slice(range.from, range.to),
              rects: selectionRectsOf(ctx, element, range.from, range.to),
            })),
          }),
    };
  },
});

/** Exported for the suite; nothing else should need them. */
export const __testing = { syntheticElement, overridden };
