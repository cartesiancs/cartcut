/**
 * Appearance edits that `update_clip` cannot express.
 *
 * Each of these could look like an `update_clip` patch and none of them can be
 * one:
 *
 *  - a font is three fields that have to agree, plus an `@font-face` the canvas
 *    needs or it draws in the fallback;
 *  - a filter's parameters are a positional `k=v:k=v` string;
 *  - a blend mode is a closed vocabulary that only some filetypes carry.
 *    `update_clip`'s whitelist is keyed by filetype with a shared `common`
 *    bucket, and blend fits neither: in `common` it would be writable on audio
 *    and on a group, both of which paint no layer, and spread across the five
 *    per-type lists it would report "that clip does not accept `blend`" for a
 *    clip whose real problem is that it is a group.
 *
 * `set_video_filters` shares its ops with the option panel rather than
 * reimplementing them: `setVideoFilter` and `setFilterEnabled` in
 * `features/timeline/filterOps.ts`. That matters because the encoding is the
 * part that is easy to get wrong — the parameter string is positional and its
 * keys differ per filter, so a switch that keeps the old string hands the next
 * shader values it will happily misread.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { setIn } from "../../../utils/immutable";
import { BLEND_MODES, type TimelineElement } from "../../../@types/timeline";
import { coerceBlend } from "../../renderer/blend";
import type { FilterInput } from "../../renderer/filter/params";
import {
  BLENDABLE_FILETYPES,
  isBlendable,
  setClipBlendMany,
} from "../../timeline/blendOps";
import {
  setFilterEnabled,
  setVideoFilter,
} from "../../timeline/filterOps";
import { ensureFontFace, parseFontPath } from "../../font/fontFaces";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

registerCommands({
  set_video_filters: (params: {
    elementIds: string[];
    filter: FilterInput | null;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_video_filters needs at least one id in `elementIds`.");
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => element.filetype !== "video");

    if (wrongType.length > 0) {
      throw new Error(
        `Only video clips carry filters; got ${wrongType
          .map((element) => element.filetype)
          .join(", ")}.`,
      );
    }

    // Setting a filter turns filtering on; clearing it turns it off. The two
    // fields are separate ops because the panel offers them as separate
    // controls, but a tool call that says "make this green screen" means both.
    const enable = params.filter != null;

    return commit(
      (d) =>
        ids.reduce(
          (doc, id) =>
            setFilterEnabled(setVideoFilter(doc, id, params.filter), id, enable),
          d,
        ),
      "Those clips already have that filter.",
    );
  },

  set_blend_mode: (params: { elementIds: string[]; blend: string }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_blend_mode needs at least one id in `elementIds`.");
    }

    // Validated here rather than in the op, which takes a `BlendMode`. This is
    // the boundary an unchecked string arrives at, and the only place that can
    // say what was wrong with it — a mode the renderer does not know is not an
    // error to `globalCompositeOperation`, it is silently ignored.
    const blend = coerceBlend(params.blend);
    if (blend == null) {
      throw new Error(
        `Unknown blend mode ${JSON.stringify(params.blend)}. ` +
          `Use one of: ${BLEND_MODES.join(", ")}.`,
      );
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => !isBlendable(element));

    if (wrongType.length > 0) {
      throw new Error(
        `Only ${BLENDABLE_FILETYPES.join(", ")} clips are composited as a layer ` +
          `and can carry a blend mode; got ${wrongType
            .map((element) => element.filetype)
            .join(", ")}.`,
      );
    }

    return commit(
      (d) => setClipBlendMany(d, ids, blend),
      "Those clips are already in that blend mode.",
    );
  },

  set_text_font: (params: { elementIds: string[]; fontPath: string }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_text_font needs at least one id in `elementIds`.");
    }
    if (typeof params.fontPath !== "string" || params.fontPath === "") {
      throw new Error(
        'set_text_font needs a `fontPath` from list_fonts, or "default".',
      );
    }

    const wrongType = ids
      .map((id) => requireElement(doc, id))
      .filter((element) => element.filetype !== "text");

    if (wrongType.length > 0) {
      throw new Error(
        `Only text clips have a font; got ${wrongType
          .map((element) => element.filetype)
          .join(", ")}.`,
      );
    }

    const font = parseFontPath(params.fontPath);

    // Injected before the commit so the very next repaint can draw with it.
    // A canvas asked for a family it does not know falls back silently, and
    // "the tool said ok but the text looks the same" is the worst outcome here.
    ensureFontFace(font);

    const result = commit(
      (d) => ({
        ...d,
        elements: ids.reduce((elements, id) => {
          let updated = elements[id];
          updated = setIn(updated, ["fontpath"], font.path);
          updated = setIn(updated, ["fontname"], font.name);
          updated = setIn(updated, ["fonttype"], font.type);
          return { ...elements, [id]: updated as TimelineElement };
        }, d.elements),
      }),
      "Those clips are already in that font.",
    );

    return { ...result, font };
  },
});
