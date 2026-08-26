/**
 * Appearance edits with a coupled second field.
 *
 * Both of these could look like `update_clip` patches and neither can be one:
 *
 *  - a font is three fields that have to agree, plus an `@font-face` the canvas
 *    needs or it draws in the fallback;
 *  - a filter's parameters are a positional `k=v:k=v` string.
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
import type { TimelineElement } from "../../../@types/timeline";
import type { FilterInput } from "../../renderer/filter/params";
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
