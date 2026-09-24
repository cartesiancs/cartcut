/**
 * Per-range text style, over the agent surface.
 *
 * The document side of this has existed since range styling shipped:
 * `text/runs.ts` resolves and validates, `timeline/textRunOps.ts` writes. What
 * was missing is a way to *name a range* from outside the editor, and that is
 * the whole of what this file adds.
 *
 * **Offsets are UTF-16 code units, and that is a trap rather than a choice.**
 * A run's `from`/`to` are measured the way `textarea.selectionStart` measures,
 * because that is where the panel's values come from. An agent counting those
 * by hand over a string with an emoji or a combining mark in it gets them
 * wrong, and the failure is silent — the range lands somewhere, just not where
 * it was meant to. So a range may also be given as `match`, a substring, and
 * the offsets are found here.
 *
 * `match` with no `occurrence` styles **every** occurrence. That is what a
 * find-and-replace does, it is what "make every mention of the product name
 * bold" means, and the alternative default — the first one only — is the one
 * that looks like it worked.
 *
 * A `match` that is not in the text is **refused**, not skipped. Skipping is
 * indistinguishable from success to the caller, and the usual cause is a
 * typo or a case difference the caller can fix once told.
 */

import type { TextRunStyle } from "../../../@types/timeline";
import { ensureFontFace, parseFontPath } from "../../font/fontFaces";
import { runsOf } from "../../text/runs";
import { withFittedTextHeights } from "../../element/textFit";
import {
  clearTextRangeStyle,
  clearTextRuns,
  setTextRangeStyle,
} from "../../timeline/textRunOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc } from "../context";
import { registerCommands } from "../registry";
import {
  requireTextElement,
  resolveRanges,
  type RangeSpec,
} from "./textRange";

/**
 * The flat tool arguments as a run style patch.
 *
 * `fontPath` is expanded into the three fields that have to travel together —
 * `fontname` is the CSS family and `fontpath` is what `registerDocumentFonts`
 * walks to inject the `@font-face`, so a run naming a family no element names
 * draws in the fallback the next time the project is opened. The same rule
 * `set_text_font` follows for the clip.
 *
 * Every other field is passed through untouched: `coerceRunStyle` runs inside
 * `editRunStyle` and drops anything it cannot read, which is the validation
 * this would otherwise duplicate and eventually disagree with.
 */
function patchFrom(params: Record<string, unknown>): TextRunStyle {
  const patch: TextRunStyle = {};

  for (const key of [
    "color",
    "fontsize",
    "fontweight",
    "bold",
    "italic",
    "outlineEnable",
    "outlineSize",
    "outlineColor",
  ] as const) {
    if (params[key] !== undefined) {
      (patch[key] as unknown) = params[key];
    }
  }

  if (typeof params.fontPath === "string" && params.fontPath !== "") {
    const font = parseFontPath(params.fontPath);
    // Injected before the commit so the very next repaint can draw with it. A
    // canvas asked for a family it does not know falls back silently, and "the
    // tool said ok but the text looks the same" is the worst outcome here.
    ensureFontFace(font);
    patch.fontname = font.name;
    patch.fontpath = font.path;
    patch.fonttype = font.type;
  }

  return patch;
}

registerCommands({
  set_text_range_style: (params: {
    elementId: string;
    ranges: RangeSpec[];
    [key: string]: unknown;
  }) => {
    const doc = currentDoc();
    const element = requireTextElement(doc, params.elementId);

    // Resolved before the commit so a bad `match` is an error rather than a
    // half-applied edit with an undo step already recorded — the rule
    // `add_keyframes` follows for a time outside the clip.
    const ranges = resolveRanges(element.text ?? "", params.ranges);

    const patch = patchFrom(params as Record<string, unknown>);
    if (Object.keys(patch).length === 0) {
      throw new Error(
        "set_text_range_style needs at least one style field: color, fontsize, " +
          "fontweight, bold, italic, fontPath, outlineEnable, outlineSize, outlineColor.",
      );
    }

    const result = commit((d: TimelineDocument) => {
      const styled = ranges.reduce(
        (next, range) =>
          setTextRangeStyle(next, params.elementId, range.from, range.to, patch),
        d,
      );
      if (styled === d) {
        return d;
      }
      // A run may ask for a larger size than the clip's, which makes its line
      // taller and the block with it. `affectsTextBlock` lists `runs` for this
      // reason; a range write is not a path write, so it folds the fit itself.
      return withFittedTextHeights(styled, [params.elementId]);
    }, "Those ranges already carry that style.");

    return {
      ...result,
      ranges: ranges.length,
      runCount: runsOf(currentDoc().elements[params.elementId] as any).length,
    };
  },

  clear_text_range_style: (params: {
    elementId: string;
    ranges?: RangeSpec[];
  }) => {
    const doc = currentDoc();
    const element = requireTextElement(doc, params.elementId);

    // No `ranges` means the whole clip, which is a different op rather than a
    // range covering everything: `clearTextRuns` deletes the key, and that is
    // what makes a clip styled and then unstyled save byte-identically to one
    // nobody ever styled.
    if (params.ranges == null || params.ranges.length === 0) {
      return commit(
        (d: TimelineDocument) => {
          const cleared = clearTextRuns(d, params.elementId);
          return cleared === d
            ? d
            : withFittedTextHeights(cleared, [params.elementId]);
        },
        "That clip has no per-range style.",
      );
    }

    const ranges = resolveRanges(element.text ?? "", params.ranges);

    return commit((d: TimelineDocument) => {
      const cleared = ranges.reduce(
        (next, range) =>
          clearTextRangeStyle(next, params.elementId, range.from, range.to),
        d,
      );
      return cleared === d
        ? d
        : withFittedTextHeights(cleared, [params.elementId]);
    }, "Those ranges carry no per-range style.");
  },
});

/** Exported for the suite; nothing else should need it. */
export const __testing = { patchFrom };
