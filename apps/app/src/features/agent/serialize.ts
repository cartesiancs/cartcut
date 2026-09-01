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
import { isAudibleElement, volumeDbOf } from "../timeline/audio";
import {
  isDynamicElement,
  spanEnd,
  spanLength,
  sourceDurationOf,
  speedOf,
} from "../timeline/geometry";
import { describeFilter } from "../renderer/filter/params";
import { blendOf, DEFAULT_BLEND } from "../renderer/blend";
import { DEFAULT_LUT_INTENSITY, lutOf } from "../renderer/lut";
import { isBlendable } from "../timeline/blendOps";
import { isGradable } from "../timeline/lutOps";
import { maskOf } from "../mask/maskShape";
import { isMaskable } from "../timeline/maskOps";
import type { TimelineDocument, TimelineTrack } from "../timeline/tracks";
import { resolveTextStyle } from "../text/style";

/** Longest text echoed back in a list row. Full text comes from `get_clip`. */
export const TEXT_PREVIEW_CHARS = 80;

/**
 * Most keyframe times `get_clip` will list for one lane.
 *
 * This used to be unbounded, and was safe only by accident: the sole producer
 * was a mouse gesture, so a lane held a handful of points. `add_keyframes` can
 * author one per frame, and a three-minute clip at 60fps is 10,800 of them —
 * enough to blow the 25k-token cap through a single `get_clip`. `count` stays
 * exact so the truncation is visible rather than silent, and `get_keyframes`
 * pages properly when the curve itself is what matters.
 */
export const MAX_KEYFRAME_TIMES = 100;

/**
 * Most group children `get_clip` will name.
 *
 * A group's membership is worth reporting — it is otherwise only discoverable
 * by scanning every clip's `parentId` — but a group over a hundred clips is a
 * list, not a fact.
 */
export const MAX_GROUP_CHILDREN = 50;

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

  // Only when set. Group membership is otherwise invisible in a list, which
  // makes `set_clip_parent` and `ungroup` guesswork.
  if (element.parentId != null) {
    row.parentId = element.parentId;
  }

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
    // Same rule as `speed`: reported only when it is not the default, so a
    // list stays compact under the tool-output cap while a project someone has
    // mixed is still visible at a glance.
    const volumeDb = volumeDbOf(element);
    if (volumeDb !== 0) {
      row.volumeDb = volumeDb;
    }
  }

  // Same rule as `speed` and `volumeDb`: only when it is not the default. A
  // blended clip is unusual and worth seeing in a list — every clip announcing
  // "source-over" would be noise against the tool-output cap.
  const blend = blendOf(element);
  if (blend !== DEFAULT_BLEND) {
    row.blend = blend;
  }

  // Two scalars, and only when there is a grade at all. The table itself is
  // emphatically not reported: a 17³ LUT is 4,913 nodes, and an agent listing
  // fifty clips would blow the 25k output cap on data it cannot use anyway —
  // it addresses a filter by id, exactly as it addresses a preset.
  const lut = lutOf(element);
  if (lut != null) {
    row.lut = lut.presetId;
    if (lut.intensity !== DEFAULT_LUT_INTENSITY) {
      row.lutIntensity = lut.intensity;
    }
  }

  // The shape name alone, and only when there is a mask. A masked clip is
  // unusual enough to be worth a word in a list — it explains why a clip an
  // agent can see in the document is not all there in the picture — and the
  // shape is the only part of it that reads at a glance. The placement is in
  // the detail view; the drawn path is in neither, for the reason the LUT table
  // is in neither.
  const mask = maskOf(element);
  if (mask != null) {
    row.mask = mask.shape;
  }

  switch (element.filetype) {
    case "text": {
      row.text = truncate(element.text, TEXT_PREVIEW_CHARS);
      row.fontsize = element.fontsize;
      row.color = element.textcolor;
      break;
    }
    // A transition and an effect have no appearance of their own to describe —
    // they are operations on frames other clips drew. The preset is the whole
    // identity, and a transition's is only meaningful alongside the two clips
    // it mixes. Before this they came back as `{type, start, dur, end}` and
    // nothing else, which reads as a clip with no content rather than as a
    // cross-dissolve. `get_fx` has the parameters.
    case "transition": {
      row.presetId = (element as any).presetId;
      row.fromId = (element as any).fromId;
      row.toId = (element as any).toId;
      break;
    }
    case "effect": {
      row.presetId = (element as any).presetId;
      row.intensity = (element as any).intensity;
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
    case "shape": {
      row.fillColor = element.option?.fillColor;
      break;
    }
    case "group": {
      row.name = element.name;
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
    detail.isBold = element.options?.isBold;
    detail.isItalic = element.options?.isItalic;
    detail.outline = element.options?.outline;
    detail.background = element.background;
    // The effect blocks are reported through the resolver rather than raw, so
    // the agent sees the same defaults the renderer will use instead of a
    // string of `undefined`s on any clip predating text effects. Every field
    // is a scalar, so this cannot threaten the tool-output size cap.
    const style = resolveTextStyle(element);
    detail.shadow = style.shadow;
    detail.glow = style.glow;
    detail.fill = style.fill;
    detail.textOpacity = style.textOpacity;
    detail.textTransform = style.textTransform;
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

  // Unlike `clipRow`, reported whatever its value — and through the resolver,
  // so a clip written before the field existed reports its effective
  // "source-over" rather than nothing at all. `clipRow` reports it only when
  // set, which leaves an agent reading a detail view unable to tell "stacks
  // normally" from "this kind of clip has no blend mode". The guard answers
  // that second case: audio and groups paint no layer, so for them the field is
  // absent rather than "source-over".
  if (isBlendable(element)) {
    detail.blend = blendOf(element);
  }

  // Reported whatever its value on the types that can carry one, and absent on
  // the types that cannot — the same distinction `blend` makes just above, and
  // for the same reason: an agent reading a detail view must be able to tell
  // "ungraded" from "this kind of clip has no filter".
  if (isGradable(element)) {
    const lut = lutOf(element);
    detail.lut = lut == null ? null : lut.presetId;
    detail.lutIntensity = lut == null ? null : lut.intensity;
  }

  // Reported whatever its value on the types that can carry one, and absent on
  // the types that cannot — the same distinction `blend` and `lut` make above.
  //
  // The drawn path is **never** sent, and `serialize.test.ts` pins its absence
  // for the same reason it pins `shape`'s point list: it is unbounded authored
  // data an agent cannot act on, and `set_mask` deliberately cannot supply one.
  // Its node count is reported instead, which is the one fact about it that
  // changes what an agent should do — a `pen` mask with fewer than three nodes
  // renders as no mask at all.
  if (isMaskable(element)) {
    const detailMask = maskOf(element);
    if (detailMask == null) {
      detail.mask = null;
    } else {
      detail.mask = {
        shape: detailMask.shape,
        x: detailMask.location.x,
        y: detailMask.location.y,
        width: detailMask.size.width,
        height: detailMask.size.height,
        rotation: detailMask.rotation,
        feather: detailMask.feather,
        roundness: detailMask.roundness,
        invert: detailMask.invert === true,
        ...(detailMask.shape === "pen"
          ? { pathNodeCount: detailMask.path?.length ?? 0 }
          : {}),
      };
    }
  }

  if (element.filetype === "shape") {
    detail.fillColor = element.option?.fillColor;
    detail.oWidth = element.oWidth;
    detail.oHeight = element.oHeight;
    // The point list itself is never sent — `previewCanvas.addShapePoint` grows
    // it without bound, and `serialize.test.ts` pins its absence.
    detail.shapePointCount = Array.isArray(element.shape) ? element.shape.length : 0;
  }

  if (element.filetype === "group") {
    detail.name = element.name;
  }

  if (element.filetype === "audio") {
    // `clipRow` reports speed only when it is not 1, so an agent reading a
    // detail view cannot tell "normal speed" from "not applicable".
    detail.speed = speedOf(element);
    // Through the resolver, so a clip from a project written before the field
    // existed reports its effective 0 dB rather than nothing at all.
    detail.volumeDb = volumeDbOf(element);
  }

  if (element.filetype === "video") {
    // Structured, not the raw `k=v:k=v` strings: an agent that has to parse
    // "r=0:g=255:b=0:f=0.4" to change the threshold will re-emit it wrong.
    detail.filters = (element.filter?.list ?? []).map(describeFilter);
    detail.filtersEnabled = element.filter?.enable === true;
    detail.speed = speedOf(element);
    detail.codec = element.codec;
    // What the clip *sounds like now*, not what its file holds: a detached
    // clip is silent here, and its sound is reported by the audio element that
    // took it. Reporting the raw `isExistAudio` would have the agent counting
    // the same audio twice.
    detail.hasAudio = isAudibleElement(element);
    detail.volumeDb = volumeDbOf(element);
    if (element.audioDetached === true) {
      detail.audioDetached = true;
    }
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
        // `count` stays exact while `times` is capped: a truncated list that
        // did not say so would read as "that is every keyframe", and an agent
        // editing around the ones it cannot see is the same failure
        // `paginate`'s `truncated` flag exists to prevent.
        lanes[lane] = {
          count: list.length,
          times: list
            .slice(0, MAX_KEYFRAME_TIMES)
            .map((keyframe: any) => ms(keyframe?.p?.[0] ?? 0)),
          ...(list.length > MAX_KEYFRAME_TIMES
            ? { truncated: true, note: "Use get_keyframes to page through them." }
            : {}),
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
