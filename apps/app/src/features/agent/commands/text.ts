/**
 * Text and subtitle commands.
 *
 * `add_subtitles` is the reason this file is separate from `edit.ts`: it is a
 * batch by design, not by convenience. A transcript arrives as tens of lines,
 * and placing them one at a time would cost tens of round trips, tens of undo
 * steps, and — because each would be committed against a document the previous
 * one already changed — tens of chances for the track chooser to scatter them.
 * Placed together in one transform they land on a single text track, because
 * `placeNewElement` reuses a track whenever the moment on it is free and
 * captions never overlap each other.
 */

import { v4 as uuidv4 } from "uuid";
import { useTimelineStore } from "../../../states/timelineStore";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { placeNewElement } from "../../timeline/placement";
import { createTextElement } from "../../element/textElement";
import { captionToTimeline } from "../../caption/timing";
import { ensureUndoBaseline } from "../checkpoint";
import { currentDoc } from "../context";
import { registerCommands } from "../registry";
import { clipRow } from "../serialize";

type SubtitleStyle = {
  fontsize?: number;
  textcolor?: string;
  align?: "left" | "center" | "right";
  background?: boolean;
  locationX?: number;
  locationY?: number;
  width?: number;
  height?: number;
};

/**
 * Where a caption sits when the caller does not say.
 *
 * Lower third, full width, centred — the same placement the auto-caption panel
 * computes, derived from the project's own resolution rather than assuming
 * 1080p, so a vertical project does not put its subtitles off-screen.
 */
function defaultLayout(style: SubtitleStyle) {
  const { w, h } = renderOptionStore.getState().options.previewSize;
  const fontsize = style.fontsize ?? Math.round(h / 20);
  const height = style.height ?? Math.round(fontsize * 1.3);
  const bottomPadding = Math.round(h / 10);

  return {
    fontsize,
    height,
    width: style.width ?? w,
    locationX: style.locationX ?? 0,
    locationY: style.locationY ?? h - bottomPadding - fontsize,
  };
}

registerCommands({
  add_subtitles: (params: {
    items: Array<{ text: string; startMs: number; durationMs: number }>;
    style?: SubtitleStyle;
    sourceElementId?: string;
  }) => {
    const items = params.items ?? [];
    if (items.length === 0) {
      throw new Error("add_subtitles needs at least one entry in `items`.");
    }

    const style = params.style ?? {};
    const layout = defaultLayout(style);
    const doc = currentDoc();

    // With a source clip named, the incoming times are source-file times and
    // have to be mapped through that clip's trim and speed. Without one they
    // are already timeline times.
    const source =
      params.sourceElementId != null
        ? doc.elements[params.sourceElementId]
        : undefined;

    if (params.sourceElementId != null && source == null) {
      throw new Error(
        `No clip with id "${params.sourceElementId}" to map subtitle times against.`,
      );
    }

    ensureUndoBaseline();

    const store = useTimelineStore.getState();
    const createdIds: string[] = [];

    store.withCheckpoint((d) => {
      let next = d;

      for (const item of items) {
        const timing = captionToTimeline(
          { startTime: item.startMs, duration: item.durationMs },
          source,
        );

        const elementId = uuidv4();
        const element = createTextElement({
          ...layout,
          text: item.text,
          textcolor: style.textcolor ?? "#ffffff",
          optionsAlign: style.align ?? "center",
          backgroundEnable: style.background === true,
          startTime: timing.startTime,
          duration: timing.duration,
        });

        next = placeNewElement(
          next,
          elementId,
          element,
          timing.startTime,
          uuidv4(),
        );
        createdIds.push(elementId);
      }

      return next;
    });

    const after = useTimelineStore.getState().getDocument();
    const names = new Map(after.tracks.map((t) => [t.id, t.name]));
    const landed = createdIds.filter((id) => after.elements[id] != null);

    return {
      ok: landed.length > 0,
      created: landed,
      // Which tracks they ended up on is the thing worth checking: all on one
      // is the expected result, and anything else means captions overlapped.
      tracks: [
        ...new Set(landed.map((id) => names.get(after.elements[id].trackId))),
      ],
      clips: landed
        .slice(0, 5)
        .map((id) =>
          clipRow(id, after.elements[id], names.get(after.elements[id].trackId)),
        ),
      note:
        landed.length > 5
          ? `${landed.length} subtitles added; showing the first 5.`
          : undefined,
    };
  },

  add_text: (params: {
    text: string;
    startMs: number;
    durationMs: number;
    style?: SubtitleStyle;
  }) => {
    if (!params.text) {
      throw new Error("add_text needs `text`.");
    }

    const style = params.style ?? {};
    const layout = defaultLayout(style);
    const elementId = uuidv4();

    const element = createTextElement({
      ...layout,
      text: params.text,
      textcolor: style.textcolor ?? "#ffffff",
      optionsAlign: style.align ?? "center",
      backgroundEnable: style.background === true,
      startTime: params.startMs,
      duration: params.durationMs,
    });

    ensureUndoBaseline();
    useTimelineStore
      .getState()
      .withCheckpoint((d) =>
        placeNewElement(d, elementId, element, params.startMs, uuidv4()),
      );

    const after = useTimelineStore.getState().getDocument();
    const created = after.elements[elementId];
    if (created == null) {
      return { ok: false, reason: "The element could not be placed." };
    }

    const names = new Map(after.tracks.map((t) => [t.id, t.name]));
    return {
      ok: true,
      created: [elementId],
      clips: [clipRow(elementId, created, names.get(created.trackId))],
    };
  },
});
