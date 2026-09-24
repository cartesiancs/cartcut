/**
 * A border and a drop shadow, across a selection.
 *
 * `update_clip` can already write every one of these fields, one clip at a
 * time — that is what the leaf paths in `writable.ts` are for. This exists
 * because the thing people actually do with a border is put the same one on
 * twelve cards, and twelve `update_clip` calls is twelve undo steps.
 *
 * The arguments are **flat** rather than two nested objects, for the reason
 * `set_shape` gives for `arcStart`/`arcSweep`: an agent changing a shadow's
 * blur should not have to restate its colour and offset. Anything left out is
 * left alone.
 *
 * The writing itself is `timeline/decorationOps.ts`, which the Border and
 * Shadow section of the option panel also calls. Sharing the ops rather than
 * the field is what stops the two from disagreeing about what a disabled
 * border keeps, the way `set_video_filters` shares `filterOps`.
 *
 * `enable` defaults to true when any field of that decoration is named. Asking
 * for a 4px border and being told it wrote a disabled one would be a trap, and
 * the explicit `false` is still there for switching one off.
 */

import type { StrokeAlignment } from "../../../@types/timeline";
import { shadowOf, strokeOf } from "../../renderer/decoration";
import {
  DECORATABLE_FILETYPES,
  isDecoratable,
  setClipShadowMany,
  setClipStrokeMany,
  type ShadowPatch,
  type StrokePatch,
} from "../../timeline/decorationOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

type DecorationArgs = {
  elementIds: string[];
  strokeEnable?: boolean;
  strokeWidth?: number;
  strokeColor?: string;
  strokeOpacity?: number;
  strokeAlign?: StrokeAlignment;
  shadowEnable?: boolean;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOpacity?: number;
};

/** Whether the caller named any field of one decoration. */
function anyNamed(args: DecorationArgs, prefix: "stroke" | "shadow"): boolean {
  return Object.keys(args).some(
    (key) => key.startsWith(prefix) && (args as any)[key] !== undefined,
  );
}

registerCommands({
  set_clip_decoration: (args: DecorationArgs) => {
    const doc = currentDoc();
    const ids = args.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_clip_decoration needs at least one id in `elementIds`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isDecoratable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${DECORATABLE_FILETYPES.join(", ")} clips carry a border and a shadow; ` +
          `got ${wrongType.map((element) => element.filetype).join(", ")}. ` +
          `A text clip has its own pair, which strokes the letters rather than the box: ` +
          `use update_clip with options.outline and options.shadow.`,
      );
    }

    const touchesStroke = anyNamed(args, "stroke");
    const touchesShadow = anyNamed(args, "shadow");
    if (!touchesStroke && !touchesShadow) {
      throw new Error(
        "set_clip_decoration needs at least one stroke* or shadow* field.",
      );
    }

    // Built as sparse patches and handed to the same ops the panel writes
    // through, so "what a border is" is decided in one place. A field left out
    // keeps whatever the clip has, which is what lets a caller change a blur
    // without restating the offset.
    const strokePatch: StrokePatch = {};
    if (touchesStroke) {
      strokePatch.enable = args.strokeEnable ?? true;
      if (args.strokeWidth !== undefined) strokePatch.width = args.strokeWidth;
      if (args.strokeColor !== undefined) strokePatch.color = args.strokeColor;
      if (args.strokeOpacity !== undefined) strokePatch.opacity = args.strokeOpacity;
      if (args.strokeAlign !== undefined) strokePatch.align = args.strokeAlign;
    }

    const shadowPatch: ShadowPatch = {};
    if (touchesShadow) {
      shadowPatch.enable = args.shadowEnable ?? true;
      if (args.shadowOffsetX !== undefined) shadowPatch.offsetX = args.shadowOffsetX;
      if (args.shadowOffsetY !== undefined) shadowPatch.offsetY = args.shadowOffsetY;
      if (args.shadowBlur !== undefined) shadowPatch.blur = args.shadowBlur;
      if (args.shadowColor !== undefined) shadowPatch.color = args.shadowColor;
      if (args.shadowOpacity !== undefined) shadowPatch.opacity = args.shadowOpacity;
    }

    const result = commit((d: TimelineDocument) => {
      let next = d;
      if (touchesStroke) {
        next = setClipStrokeMany(next, ids, strokePatch);
      }
      if (touchesShadow) {
        next = setClipShadowMany(next, ids, shadowPatch);
      }
      return next;
    }, "Those clips already carry that border and shadow.");

    const after = currentDoc();
    return {
      ...result,
      // Through the read guards, so the answer is what the renderer will
      // actually draw rather than what was stored: a border of zero width
      // reports as absent, which is what it looks like.
      decoration: ids.map((id) => ({
        elementId: id,
        stroke: strokeOf(after.elements[id]),
        shadow: shadowOf(after.elements[id]),
      })),
    };
  },
});
