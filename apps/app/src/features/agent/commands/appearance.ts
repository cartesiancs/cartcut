/**
 * Appearance edits with a coupled second field.
 *
 * Both of these could look like `update_clip` patches and neither can be one:
 *
 *  - a font is three fields that have to agree, plus an `@font-face` the canvas
 *    needs or it draws in the fallback;
 *  - a filter's parameters are a positional `k=v:k=v` string.
 *
 * They also fix a real bug on the way past. `optionVideo`'s filter handlers
 * mutate `element.filter.list[i]` **in place** — on the live store object, which
 * every undo entry shares — and then call `preview-canvas.setChangeFilter()`,
 * a method that does not exist on that component. So the UI's own filter
 * editing throws after corrupting history. These commands write immutably
 * through `withCheckpoint`, which makes the agent's path the correct one until
 * the panel is repointed at them.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { setIn } from "../../../utils/immutable";
import type { TimelineElement } from "../../../@types/timeline";
import { toFilter, type FilterInput } from "../../renderer/filter/params";
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

    // Built before the transform so a bad colour is a thrown error rather than
    // a half-applied edit: `toFilter` validates the hex.
    const next =
      params.filter == null
        ? { enable: false, list: [] }
        : { enable: true, list: [toFilter(params.filter)] };

    return commit(
      (d) => ({
        ...d,
        elements: ids.reduce(
          (elements, id) => ({
            ...elements,
            [id]: setIn(elements[id], ["filter"], next) as TimelineElement,
          }),
          d.elements,
        ),
      }),
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
