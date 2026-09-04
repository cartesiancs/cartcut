/**
 * Read-only commands: what the agent is allowed to know about the project.
 *
 * Nothing here mutates, so nothing here takes a checkpoint. Everything goes out
 * through `serialize.ts` — see that file for why a raw element can never be
 * returned directly.
 */

import { useTimelineStore } from "../../../states/timelineStore";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { projectStore } from "../../../states/projectStore";
import { assetStore } from "../../../states/assetStore";
import { clipsOnTrack, trackById } from "../../timeline/tracks";
import {
  isDynamicElement,
  spanEnd,
  spanStart,
  speedOf,
  timelineTimeAt,
} from "../../timeline/geometry";
import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../../@types/timeline";
import { lanesOf } from "../../animation/keyframes";
import { captionToTimeline } from "../../caption/timing";
import {
  clipDetail,
  clipRow,
  documentDuration,
  paginate,
  trackRow,
} from "../serialize";
import { registerCommands } from "../registry";

/** Default page size for `list_clips`, chosen to stay well under the warning. */
const DEFAULT_LIMIT = 100;


function doc() {
  return useTimelineStore.getState().getDocument();
}

/** Track name for an element, for rows that want "V1" rather than a uuid. */
function trackNameOf(elementId: string): string | undefined {
  const document = doc();
  const element = document.elements[elementId];
  if (element == null) {
    return undefined;
  }
  return trackById(document, element.trackId)?.name;
}

function requireElement(elementId: string): TimelineElement {
  const element = doc().elements[elementId];
  if (element == null) {
    throw new Error(
      `No clip with id "${elementId}". Use list_clips to see current ids.`,
    );
  }
  return element;
}

/** Half-open overlap: a clip touching the boundary is not inside the window. */
function overlapsWindow(
  element: TimelineElement,
  startMs?: number,
  endMs?: number,
): boolean {
  if (startMs == null && endMs == null) {
    return true;
  }
  const start = spanStart(element);
  const end = spanEnd(element);
  if (endMs != null && start >= endMs) {
    return false;
  }
  if (startMs != null && end <= startMs) {
    return false;
  }
  return true;
}

registerCommands({
  ping: () => ({ ok: true, app: "cartcut" }),

  get_project_overview: () => {
    const state = useTimelineStore.getState();
    const document = state.getDocument();
    const options = renderOptionStore.getState().options;

    const counts: Record<string, number> = {};
    for (const element of Object.values(document.elements)) {
      counts[element.filetype] = (counts[element.filetype] ?? 0) + 1;
    }

    return {
      resolution: {
        width: options.previewSize.w,
        height: options.previewSize.h,
      },
      fps: options.fps,
      backgroundColor: options.backgroundColor,
      // `options.duration` is the *export* length the user set; the timeline
      // may well run past it. Both matter, so both are reported.
      exportDurationMs: Math.round(options.duration * 1000),
      timelineDurationMs: documentDuration(document),
      playheadMs: Math.round(state.cursor),
      isPlaying: state.control.isPlay,
      projectFolder: projectStore.getState().projectFolder,
      assetFolder: assetStore.getState().nowDirectory,
      clipCount: Object.keys(document.elements).length,
      clipsByType: counts,
      tracks: [...document.tracks]
        .sort((a, b) => a.index - b.index)
        .map((track) =>
          trackRow(track, clipsOnTrack(document, track.id).length),
        ),
      undoDepth: state.history.historyNow + 1,
      redoDepth:
        state.history.timelineHistory.length - state.history.historyNow - 1,
    };
  },

  list_clips: (params: {
    trackId?: string;
    filetype?: string;
    startMs?: number;
    endMs?: number;
    limit?: number;
    offset?: number;
  }) => {
    const document = doc();
    const names = new Map(document.tracks.map((t) => [t.id, t.name]));

    const matching = Object.entries(document.elements)
      .filter(([, element]) => {
        if (params.trackId != null && element.trackId !== params.trackId) {
          return false;
        }
        if (params.filetype != null && element.filetype !== params.filetype) {
          return false;
        }
        return overlapsWindow(element, params.startMs, params.endMs);
      })
      // Reading order: by track from the top, then left to right.
      .sort(([, a], [, b]) => {
        const trackDelta =
          (trackById(document, a.trackId)?.index ?? 0) -
          (trackById(document, b.trackId)?.index ?? 0);
        return trackDelta !== 0 ? trackDelta : spanStart(a) - spanStart(b);
      });

    const page = paginate(
      matching,
      params.offset ?? 0,
      params.limit ?? DEFAULT_LIMIT,
    );

    return {
      clips: page.items.map(([id, element]) =>
        clipRow(id, element, names.get(element.trackId)),
      ),
      total: page.total,
      offset: page.offset,
      truncated: page.truncated,
    };
  },

  get_clip: (params: { elementId: string }) => {
    const element = requireElement(params.elementId);
    return clipDetail(params.elementId, element, trackNameOf(params.elementId));
  },

  /**
   * Step one of `get_transcript`: which file to transcribe.
   *
   * The tool cannot just take a path — the agent addresses clips by id, and
   * letting it name arbitrary files would hand it the filesystem.
   */
  get_transcript_source: (params: { elementId: string }) => {
    const element = requireElement(params.elementId);
    if (!isDynamicElement(element)) {
      throw new Error(
        `Clip "${params.elementId}" is a ${element.filetype} clip and has no audio to transcribe.`,
      );
    }
    if (element.filetype === "video" && element.isExistAudio === false) {
      throw new Error(`Clip "${params.elementId}" has no audio track.`);
    }
    return { localpath: element.localpath, filetype: element.filetype };
  },

  /**
   * Step two: put source-file timings onto the timeline.
   *
   * Done here rather than in main because `timelineTimeAt` is the only correct
   * answer and it lives in `geometry.ts`, which main cannot import. Entries
   * that fall outside the clip's source window are dropped rather than clamped:
   * a word the user trimmed away is not on the timeline, and offering it as if
   * it were is how an agent ends up cutting the wrong second.
   */
  map_transcript: (params: {
    elementId: string;
    items: Array<{
      text: string;
      startMs: number;
      endMs: number;
      [extra: string]: unknown;
    }>;
  }) => {
    const element = requireElement(params.elementId);
    if (!isDynamicElement(element)) {
      throw new Error(`Clip "${params.elementId}" has no source window.`);
    }

    const window = {
      start: element.trim?.startTime ?? 0,
      end: element.trim?.endTime ?? element.duration,
    };

    const mapped = (params.items ?? [])
      .filter((item) => item.endMs > window.start && item.startMs < window.end)
      .map((item) => {
        const timing = captionToTimeline(
          { startTime: item.startMs, duration: item.endMs - item.startMs },
          element,
        );
        // Spread first so anything the back end reported — confidence, a
        // speaker label, whatever a later one adds — survives the trip, and
        // only the two fields this function exists to change are overwritten.
        return {
          ...item,
          startMs: timing.startTime,
          endMs: timing.startTime + timing.duration,
        };
      });

    return {
      items: mapped,
      clipSpan: {
        startMs: Math.round(spanStart(element)),
        endMs: Math.round(spanEnd(element)),
      },
    };
  },

  /**
   * Put an audio analysis onto the timeline.
   *
   * The sibling of `map_transcript`, and here for the same reason: `analyze.ts`
   * measures the **source file**, and only `geometry.ts` knows what a source ms
   * is on the timeline. Doing the affine conversion in main instead would be a
   * second implementation of the one thing that must not drift.
   *
   * Tempo needs more than a time shift. A clip playing at 2x carries music that
   * is twice as fast on the timeline as it is in the file, so **bpm scales by
   * speed** — getting that wrong reports a rate that disagrees with the beats
   * beside it, which is how a caller ends up spacing cuts by arithmetic instead
   * of by the measured beat list.
   */
  map_analysis: (params: {
    elementId: string;
    silences?: Array<{ startMs: number; endMs: number }>;
    onsets?: number[];
    beats?: number[];
    tempo?: { bpm: number; confidence: number } | null;
  }) => {
    const element = requireElement(params.elementId);
    if (!isDynamicElement(element)) {
      throw new Error(`Clip "${params.elementId}" has no source window.`);
    }

    const window = {
      start: element.trim?.startTime ?? 0,
      end: element.trim?.endTime ?? element.duration,
    };
    const speed = speedOf(element);

    /** One source instant on the timeline, or null if trimmed away. */
    const instant = (sourceMs: number): number | null => {
      if (sourceMs < window.start || sourceMs >= window.end) {
        return null;
      }
      return Math.round(timelineTimeAt(element, sourceMs));
    };

    const silences = (params.silences ?? [])
      .filter((r) => r.endMs > window.start && r.startMs < window.end)
      .map((r) => {
        // Clamped to the window rather than dropped: a silence that runs off
        // the end of the trim is still silent for the part that plays.
        const from = Math.max(r.startMs, window.start);
        const to = Math.min(r.endMs, window.end);
        return {
          startMs: Math.round(timelineTimeAt(element, from)),
          endMs: Math.round(timelineTimeAt(element, to)),
        };
      });

    const onsets = (params.onsets ?? [])
      .map(instant)
      .filter((at): at is number => at != null);
    const beats = (params.beats ?? [])
      .map(instant)
      .filter((at): at is number => at != null);

    const tempo =
      params.tempo == null
        ? null
        : {
            bpm: Math.round(params.tempo.bpm * speed * 10) / 10,
            confidence: params.tempo.confidence,
          };

    return {
      silences,
      onsets,
      beats,
      tempo,
      clipSpan: {
        startMs: Math.round(spanStart(element)),
        endMs: Math.round(spanEnd(element)),
      },
    };
  },

  /**
   * The authored keyframes on one property, in absolute timeline ms.
   *
   * Never the baked samples: `animation[property].ax` holds up to
   * `MAX_BAKED_SAMPLES` (36,000) values per lane, and one lane is enough to
   * blow the 25k-token output cap on its own. `get_clip` already reports counts
   * and times; this is for when the curve itself has to be edited.
   */
  get_keyframes: (params: {
    elementId: string;
    property: AnimatableProperty;
    limit?: number;
    offset?: number;
  }) => {
    const element = requireElement(params.elementId);
    const available = animatableProperties(element);

    if (!available.includes(params.property)) {
      throw new Error(
        available.length === 0
          ? `A ${element.filetype} clip carries no animation.`
          : `A ${element.filetype} clip cannot animate "${params.property}". It supports: ${available.join(", ")}.`,
      );
    }

    const track = (element as any).animation?.[params.property] ?? {};
    const start = spanStart(element);

    // Times go back out absolute, matching every other tool. They are stored
    // relative to the clip's start; `commands/animation.ts` owns that seam.
    //
    // **The handles are rebased too.** They were not, and the anchor was — so a
    // clip starting at 5s reported a keyframe at 5200ms whose own control point
    // sat at 200ms, which reads as a handle before the clip begins. Two time
    // bases in one object is the kind of thing a reader trusts and should not.
    const rebase = (handle: unknown): number[] | undefined =>
      Array.isArray(handle) && handle.length >= 2
        ? [Math.round(start + handle[0]), handle[1]]
        : undefined;

    const lanes: Record<string, unknown> = {};
    for (const lane of lanesOf(params.property)) {
      const list = Array.isArray(track[lane]) ? track[lane] : [];
      const page = paginate(list, params.offset ?? 0, params.limit ?? 100);
      lanes[lane] = {
        count: page.total,
        truncated: page.truncated,
        keyframes: page.items.map((keyframe: any) => ({
          atMs: Math.round(start + (keyframe?.p?.[0] ?? 0)),
          value: keyframe?.p?.[1],
          type: keyframe?.type,
          cs: rebase(keyframe?.cs),
          ce: rebase(keyframe?.ce),
        })),
      };
    }

    return {
      elementId: params.elementId,
      property: params.property,
      active: track.isActivate === true,
      clipSpan: {
        startMs: Math.round(start),
        endMs: Math.round(spanEnd(element)),
      },
      lanes,
      ...(params.property === "scale"
        ? { note: "Scale is in tenths: 10 is unscaled, 12 is 120%." }
        : {}),
      // Worth saying because the neighbouring property is not in pixels and
      // the two are easy to reach for interchangeably: an agent that reads a
      // `size` lane of 1920 and writes 19 into it, as it would for `scale`,
      // has collapsed the clip rather than left it alone.
      ...(params.property === "size"
        ? {
            note:
              "Size is in pixels — the clip's own width (x) and height (y). " +
              "Unlike scale it replaces the box rather than multiplying it, and the two axes are independent.",
          }
        : {}),
    };
  },

  /**
   * What the user has selected.
   *
   * Selection lives in `selectionStore`; `targetId` is the canvas's accessor
   * onto it. Read through the component anyway, the same DOM reach
   * `select_clips` makes — it keeps both halves of the pair symmetrical, and it
   * answers "not mounted" rather than "nothing selected" when there is no
   * timeline at all.
   */
  get_selection: () => {
    const timelineCanvas: any = document.querySelector("element-timeline-canvas");
    if (timelineCanvas == null) {
      return { ok: false, reason: "The timeline canvas is not mounted." };
    }

    const document_ = doc();
    const ids: string[] = (timelineCanvas.targetId ?? []).filter(
      (id: string) => document_.elements[id] != null,
    );
    const names = new Map(document_.tracks.map((t) => [t.id, t.name]));

    return {
      ok: true,
      selected: ids,
      clips: ids.map((id) =>
        clipRow(id, document_.elements[id], names.get(document_.elements[id].trackId)),
      ),
    };
  },

  list_assets: async (params: { dir?: string }) => {
    const dir = params.dir ?? assetStore.getState().nowDirectory;
    if (!dir) {
      throw new Error(
        "No asset folder is open. Ask the user to pick one in the asset panel, or pass `dir`.",
      );
    }

    const entries = await window.electronAPI.req.filesystem.getDirectory(dir);
    const files: string[] = [];
    const folders: string[] = [];

    for (const [name, entry] of Object.entries<any>(entries ?? {})) {
      (entry?.isDirectory ? folders : files).push(name);
    }

    files.sort();
    folders.sort();

    return { dir, folders, files };
  },
});
