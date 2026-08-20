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
import { setIn } from "../../../utils/immutable";
import type { TimelineDocument } from "../../timeline/tracks";
import type { TimelineElement } from "../../../@types/timeline";
import { createTextElement } from "../../element/textElement";
import { captionToTimeline } from "../../caption/timing";
import { ensureUndoBaseline } from "../checkpoint";
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

function currentDoc(): TimelineDocument {
  return useTimelineStore.getState().getDocument();
}

/** Property paths `update_clip` will write, by element type. */
const WRITABLE: Record<string, string[][]> = {
  common: [
    ["location", "x"],
    ["location", "y"],
    ["width"],
    ["height"],
    ["opacity"],
    ["rotation"],
  ],
  text: [
    ["text"],
    ["textcolor"],
    ["fontsize"],
    ["letterSpacing"],
    ["options", "align"],
    ["options", "isBold"],
    ["options", "isItalic"],
    ["options", "outline", "enable"],
    ["options", "outline", "size"],
    ["options", "outline", "color"],
    ["background", "enable"],
    ["background", "color"],
  ],
};

function writablePaths(element: TimelineElement): string[][] {
  const common = element.filetype === "audio" ? [] : WRITABLE.common;
  return [...common, ...(WRITABLE[element.filetype] ?? [])];
}

/** `{a: {b: 1}}` -> `[[["a","b"], 1]]`, so a nested patch becomes path writes. */
function flatten(
  patch: Record<string, any>,
  prefix: string[] = [],
): Array<[string[], unknown]> {
  const out: Array<[string[], unknown]> = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key];
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value, path));
    } else {
      out.push([path, value]);
    }
  }
  return out;
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

  update_clip: (params: { elementId: string; patch: Record<string, any> }) => {
    const doc = currentDoc();
    const element = doc.elements[params.elementId];
    if (element == null) {
      throw new Error(
        `No clip with id "${params.elementId}". Use list_clips to see current ids.`,
      );
    }

    const allowed = writablePaths(element);
    const writes = flatten(params.patch ?? {});
    if (writes.length === 0) {
      throw new Error("update_clip needs a non-empty `patch`.");
    }

    // Whitelisted rather than filtered: `startTime`, `duration` and `trim` are
    // coupled by invariants that `geometry.ts` enforces and a blind write would
    // break, so timing changes belong to trim_clip and move_clips, not here.
    const rejected = writes
      .map(([path]) => path.join("."))
      .filter(
        (name) => !allowed.some((path) => path.join(".") === name),
      );

    if (rejected.length > 0) {
      throw new Error(
        `update_clip cannot write ${rejected.join(", ")} on a ${element.filetype} clip. ` +
          `Writable: ${allowed.map((p) => p.join(".")).join(", ")}. ` +
          `Use trim_clip or move_clips to change timing.`,
      );
    }

    ensureUndoBaseline();
    useTimelineStore.getState().withCheckpoint((d) => {
      let updated: TimelineElement = d.elements[params.elementId];
      for (const [path, value] of writes) {
        updated = setIn(updated, path, value);
      }
      return {
        ...d,
        elements: { ...d.elements, [params.elementId]: updated },
      };
    });

    const after = useTimelineStore.getState().getDocument();
    const names = new Map(after.tracks.map((t) => [t.id, t.name]));
    const current = after.elements[params.elementId];

    return {
      ok: true,
      changed: writes.map(([path]) => path.join(".")),
      clip: clipRow(params.elementId, current, names.get(current.trackId)),
    };
  },
});
