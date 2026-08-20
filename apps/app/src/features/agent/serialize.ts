/**
 * Projections of the timeline that are safe to hand an agent.
 *
 * Claude Code truncates MCP tool output at 25,000 tokens and warns at 10,000.
 * A `TimelineElement` cannot be sent as-is and stay under that: `animation`
 * carries baked sample arrays of up to `MAX_BAKED_SAMPLES` (36,000) *per lane*,
 * `blob` is an object URL of no use to anything outside this renderer, and a
 * shape's `shape` field is an unbounded point list. One animated clip is enough
 * to blow the budget on its own.
 *
 * So every field here is opted **in**. A whitelist fails closed: a field added
 * to `TimelineElement` later is absent from the agent's view until someone
 * decides it belongs, which is the right default. A blacklist would fail open
 * and quietly start leaking whatever gets added next — `serialize.test.ts`
 * pins that property rather than trusting the reviewer to notice.
 */

import type {
  TimelineElement,
  AnimatableProperty,
} from "../../@types/timeline";
import { canAnimate, animatableProperties } from "../../@types/timeline";
import {
  isDynamicElement,
  spanEnd,
  spanLength,
  sourceDurationOf,
  speedOf,
} from "../timeline/geometry";
import type { TimelineDocument, TimelineTrack } from "../timeline/tracks";

/** Longest text echoed back in a list row. Full text comes from `get_clip`. */
export const TEXT_PREVIEW_CHARS = 80;

/** Times are integer milliseconds everywhere in the agent surface. */
function ms(value: number): number {
  return Math.round(value);
}

function basename(filepath: string | undefined): string {
  if (!filepath) {
    return "";
  }
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1] || filepath;
}

function truncate(text: string, limit: number): string {
  if (typeof text !== "string") {
    return "";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export type ClipRow = Record<string, unknown> & {
  id: string;
  type: string;
  start: number;
  dur: number;
  end: number;
};

/**
 * One clip as a compact row.
 *
 * `id` is passed in rather than read from `element.key`, and that is not
 * defensiveness: `key` is only populated by the preview and asset layers, so
 * the elements `addText` and `addImage` create carry no `key` at all. The
 * `Timeline` map key is the id every op takes, so it is the one an agent must
 * be given.
 *
 * `dur` is the span on the *timeline*, not `element.duration` — the two differ
 * whenever `speed !== 1`, and the timeline figure is the one an agent reasoning
 * about "what is on screen at 4s" needs. `sourceDur`/`trim` carry the source
 * side for the cases that genuinely need it.
 */
export function clipRow(
  id: string,
  element: TimelineElement,
  trackName?: string,
): ClipRow {
  const row: ClipRow = {
    id,
    type: element.filetype,
    start: ms(element.startTime),
    dur: ms(spanLength(element)),
    end: ms(spanEnd(element)),
  };

  if (trackName != null) {
    row.track = trackName;
  }
  row.trackId = element.trackId;

  if (isDynamicElement(element)) {
    row.src = basename(element.localpath);
    row.trim = {
      start: ms(element.trim?.startTime ?? 0),
      end: ms(element.trim?.endTime ?? element.duration),
    };
    row.sourceDur = ms(sourceDurationOf(element));
    const speed = speedOf(element);
    if (speed !== 1) {
      row.speed = speed;
    }
  }

  switch (element.filetype) {
    case "text": {
      row.text = truncate(element.text, TEXT_PREVIEW_CHARS);
      row.fontsize = element.fontsize;
      row.color = element.textcolor;
      break;
    }
    case "video": {
      const filters = element.filter?.enable
        ? (element.filter.list ?? []).map((f) => f.name)
        : [];
      if (filters.length > 0) {
        row.filters = filters;
      }
      break;
    }
    case "image":
    case "gif": {
      row.src = basename(element.localpath);
      break;
    }
    default:
      break;
  }

  const animated = animatedProperties(element);
  if (animated.length > 0) {
    row.animated = animated;
  }

  return row;
}

/** Which properties actually have an active keyframe track. */
function animatedProperties(element: TimelineElement): AnimatableProperty[] {
  if (!canAnimate(element)) {
    return [];
  }
  const animation = (element as any).animation;
  if (animation == null) {
    return [];
  }
  return animatableProperties(element).filter(
    (property) => animation[property]?.isActivate === true,
  );
}

/**
 * A single clip in full — minus the parts that cannot be sent.
 *
 * `animation` becomes a shape summary: which lanes are live, how many
 * keyframes, and at what times. That is enough for an agent to decide whether
 * to touch the animation without shipping 36,000 baked samples to find out.
 */
export function clipDetail(
  id: string,
  element: TimelineElement,
  trackName?: string,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    ...clipRow(id, element, trackName),
    localpath: element.localpath,
    priority: element.priority,
  };

  if (element.filetype === "text") {
    detail.text = element.text;
    detail.fontname = element.fontname;
    detail.fontweight = element.fontweight;
    detail.letterSpacing = element.letterSpacing;
    detail.align = element.options?.align;
    detail.outline = element.options?.outline;
    detail.background = element.background;
  }

  if (element.filetype !== "audio") {
    detail.location = {
      x: ms((element as any).location?.x ?? 0),
      y: ms((element as any).location?.y ?? 0),
    };
    detail.width = (element as any).width;
    detail.height = (element as any).height;
    detail.opacity = (element as any).opacity;
    detail.rotation = (element as any).rotation;
  }

  if (element.filetype === "video") {
    detail.filters = element.filter?.list ?? [];
    detail.filtersEnabled = element.filter?.enable === true;
    detail.hasAudio = element.isExistAudio;
    detail.origin = element.origin;
  }

  const animation = (element as any).animation;
  if (canAnimate(element) && animation != null) {
    detail.animation = animatableProperties(element).map((property) => {
      const track = animation[property] ?? {};
      const lanes: Record<string, unknown> = {};
      for (const lane of ["x", "y"] as const) {
        const list = track[lane];
        if (!Array.isArray(list)) {
          continue;
        }
        lanes[lane] = {
          count: list.length,
          times: list.map((keyframe: any) => ms(keyframe?.p?.[0] ?? 0)),
        };
      }
      return { property, active: track.isActivate === true, lanes };
    });
  }

  return detail;
}

export function trackRow(
  track: TimelineTrack,
  clipCount: number,
): Record<string, unknown> {
  return {
    id: track.id,
    name: track.name,
    kind: track.kind,
    index: track.index,
    clips: clipCount,
  };
}

/** Total timeline length: the furthest clip end, in ms. */
export function documentDuration(doc: TimelineDocument): number {
  let end = 0;
  for (const element of Object.values(doc.elements)) {
    end = Math.max(end, spanEnd(element));
  }
  return ms(end);
}

export type Page<T> = {
  items: T[];
  total: number;
  offset: number;
  truncated: boolean;
};

/**
 * Slice a list and say so when something was left out.
 *
 * A silently truncated list reads as "that is everything", and an agent that
 * believes it has seen every clip will confidently edit around the ones it
 * cannot see. `truncated` plus `total` is what lets it page instead.
 */
export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const start = Math.max(0, Math.floor(offset));
  const slice = items.slice(start, start + Math.max(0, Math.floor(limit)));
  return {
    items: slice,
    total: items.length,
    offset: start,
    truncated: start + slice.length < items.length,
  };
}
