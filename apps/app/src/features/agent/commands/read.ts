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
} from "../../timeline/geometry";
import type { TimelineElement } from "../../../@types/timeline";
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
    items: Array<{ text: string; startMs: number; endMs: number }>;
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
        return {
          text: item.text,
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
