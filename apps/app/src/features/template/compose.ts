/**
 * Turning a placed template into the elements that will actually be drawn.
 *
 * A `template` element carries a `templateId` and the user's `fills` and
 * nothing else — see `@types/timeline.ts#TemplateElementType` for why it stores
 * a reference rather than a copy. This module is what stands between that
 * reference and a picture: given the registry's `TemplateData` and one placed
 * instance, it produces the flat `Timeline` that `renderTimelineAtTime` draws
 * into the instance's own layer.
 *
 * Three things it does are load-bearing.
 *
 * **Every key is namespaced** `outerId::innerKey`. `loadedAssetStore` caches
 * video and audio decoders by element id, so two copies of one template placed
 * at different times would otherwise share one decoder and seek each other
 * backwards. The prefix is also what lets `expandTemplates` hand the asset
 * layer a flat map it can treat as ordinary clips.
 *
 * **A fill moves the trim window and never the duration.** A slot's span is the
 * author's; the user chooses which part of their own footage lands in it. That
 * keeps `geometry.ts`'s `duration === trim.endTime - trim.startTime` satisfied
 * and makes it impossible for a replacement to change the template's timing —
 * which is the difference between a template and a project.
 *
 * **Nothing is mutated.** The registry hands one `TemplateData` to every
 * instance of that template, so writing through it would leak one user's
 * footage into another instance's copy. Every element a fill touches is rebuilt.
 *
 * Pure, DOM-free and store-free: it runs in the `node` suite, and the renderer
 * adds its own memo on top rather than this module keeping state.
 */

import type {
  TemplateElementType,
  TemplateFill,
  Timeline,
  TimelineElement,
} from "../../@types/timeline";
import mime from "../../functions/mime";
import type { TimelineTrack } from "../timeline/tracks";
import { emptyAnimation } from "../animation/keyframes";
import { trimEnd } from "../timeline/clipEdit";
import { renameElementRefs } from "../timeline/elementRefs";
import { spanOf } from "../timeline/geometry";
import { slotKindOf, type TemplateSlot } from "./slots";

/** One installed template, as the registry resolves it. */
export type TemplateData = {
  id: string;
  /** The display name, from `template.json` or the installed folder. */
  name: string;
  /** The size its document was composed at. The layer is allocated at this. */
  size: { w: number; h: number };
  durationMs: number;
  /** The document, with absolute paths — already through `relinkAssets`. */
  elements: Timeline;
  /**
   * The document's rows. Nothing draws from them; expanding a template into
   * an editable composition (`composition/fork.ts`) does. Optional so a
   * hand-built `TemplateData` in a suite need not invent any.
   */
  tracks?: TimelineTrack[];
  /** Derived once at load by `slotsOf`, so every read is a lookup. */
  slots: TemplateSlot[];
  /**
   * The frame rate the template was authored at, from its render options.
   * Absent when they name none. Read only by a link that opens a template as
   * the whole project (`templateLink.ts`), which matches the project to it.
   */
  fps?: number;
};

const SEPARATOR = "::";

export function namespacedKey(outerId: string, innerKey: string): string {
  return `${outerId}${SEPARATOR}${innerKey}`;
}

/** The inverse, for anything holding a composed id and needing its origin. */
export function innerKeyOf(
  key: string,
): { outerId: string; innerKey: string } | null {
  const at = key.indexOf(SEPARATOR);
  if (at <= 0) {
    return null;
  }
  return {
    outerId: key.slice(0, at),
    innerKey: key.slice(at + SEPARATOR.length),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Whether a fill is usable at all. It arrives from a saved project. */
function isUsable(fill: unknown): fill is TemplateFill {
  if (fill == null || typeof fill !== "object") {
    return false;
  }
  const kind = (fill as { kind?: unknown }).kind;
  if (kind === "text") {
    return typeof (fill as { text?: unknown }).text === "string";
  }
  if (kind !== "media") {
    return false;
  }
  const localpath = (fill as { localpath?: unknown }).localpath;
  return typeof localpath === "string" && localpath !== "";
}

/**
 * The fields only a video carries, dropped when a fill turns one into a still.
 *
 * Against `@types/timeline.ts#VideoElementType`: its own block, plus
 * `Leveled`'s `volumeDb`. Everything else a video has an image has too.
 */
const VIDEO_ONLY_FIELDS = [
  "reversed",
  "trim",
  "sourceDuration",
  "isExistAudio",
  "audioDetached",
  "codec",
  "speed",
  "speedCurve",
  "filter",
  "origin",
  "volumeDb",
] as const;

type PictureKind = "video" | "image" | "gif";

/**
 * What the fill's file is, by its extension, or `null` when that says nothing
 * a picture slot can use (the element keeps its own kind).
 *
 * `<option-template>` offers one picker for every media slot, so a photo can
 * land in a slot authored as a video. Kept as a video, that element named a
 * `.png` as its `<video>` source and drew nothing, and claimed the
 * placeholder's sound for a file that has none.
 */
function pictureKindOf(localpath: string): PictureKind | null {
  const type = mime.lookup(localpath)?.type;
  return type === "video" || type === "image" || type === "gif" ? type : null;
}

/** A video's source window over a fill, clamped as `filled` describes. */
function windowOver(
  span: number,
  fill: Extract<TemplateFill, { kind: "media" }>,
): { trim: { startTime: number; endTime: number }; sourceDuration: number } {
  const source = Number(fill.sourceDurationMs) || 0;
  const offset = clamp(Number(fill.offsetMs) || 0, 0, Math.max(0, source - span));
  return {
    trim: { startTime: offset, endTime: offset + span },
    sourceDuration: source,
  };
}

/**
 * One element with the user's replacement in it.
 *
 * The trim window is `[offset, offset + duration)` in the **source**, with the
 * offset clamped so it cannot start past the point where the slot's length
 * still fits. A source shorter than the slot pins the offset to zero and lets
 * the window overrun: the window has to span the slot for the duration
 * invariant to hold, and the picture simply runs out inside it, which is what
 * every editor does with a clip trimmed past its end.
 *
 * A fill whose file is a different kind of picture from the slot's element
 * changes the element's kind with it. Position, size, keyframes and the rest
 * of the author's work stay, because image and video share every one of
 * those fields; a still loses the video's source window, speed and sound, and
 * a video gains a window over the fill at 1x. Whether a filled video has
 * sound is the fill's `hasAudio`, read when it was chosen; a fill from before
 * that field keeps the placeholder's answer when the kinds match and says no
 * sound when they do not, so an export never asks FFmpeg for an audio stream
 * a still cannot have.
 */
function filled(element: TimelineElement, fill: TemplateFill): TimelineElement {
  if (fill.kind === "text") {
    return { ...element, text: fill.text } as TimelineElement;
  }

  const from = element.filetype;
  const to =
    from === "video" || from === "image" || from === "gif"
      ? (pictureKindOf(fill.localpath) ?? from)
      : from;
  const span = Number(element.duration) || 0;
  const next = {
    ...element,
    filetype: to,
    localpath: fill.localpath,
  } as Record<string, unknown>;

  if (from === "video" && to !== "video") {
    for (const field of VIDEO_ONLY_FIELDS) {
      delete next[field];
    }
    const animation = next.animation as Record<string, unknown> | undefined;
    if (animation != null && "volumeDb" in animation) {
      const { volumeDb: _sound, ...rest } = animation;
      next.animation = rest;
    }
  }

  if (to === "image" && next.animation == null) {
    next.animation = emptyAnimation("image");
  }

  if (to !== "video") {
    return next as TimelineElement;
  }

  Object.assign(next, windowOver(span, fill));
  if (from !== "video") {
    const width = Number((element as { width?: unknown }).width) || 0;
    const height = Number((element as { height?: unknown }).height) || 0;
    next.speed = 1;
    next.codec = { video: "default", audio: "default" };
    next.filter = { enable: false, list: [] };
    next.origin = { width, height };
    next.isExistAudio = fill.hasAudio === true;
  } else if (typeof fill.hasAudio === "boolean") {
    next.isExistAudio = fill.hasAudio;
  }
  return next as TimelineElement;
}

/** slotId -> the elements it fills, from the slot list the registry derived. */
function fillTargets(data: TemplateData): Map<string, TemplateSlot> {
  const byId = new Map<string, TemplateSlot>();
  for (const slot of data.slots) {
    byId.set(slot.slotId, slot);
  }
  return byId;
}

/**
 * The template's own elements with this instance's fills applied, under their
 * **original** keys, nested templates left out.
 *
 * The half of `composeTemplate` that is about content rather than naming.
 * Forking a placed template into the project (`composition/fork.ts`) needs
 * exactly this: what the instance shows, as an editable document with keys of
 * its own, which is why it is not namespaced here.
 *
 * Nesting is capped at one level, here and at export. A depth counter would
 * have to be threaded through a render path with no other reason to know
 * recursion exists.
 */
export function bakeFills(
  data: TemplateData,
  element: TemplateElementType,
): Timeline {
  const slots = fillTargets(data);

  // Which element gets which fill, resolved once rather than per element.
  const replacements = new Map<string, TemplateFill>();
  const fills = (element.fills ?? {}) as Record<string, unknown>;
  for (const slotId of Object.keys(fills)) {
    const fill = fills[slotId];
    const slot = slots.get(slotId);
    if (slot == null || !isUsable(fill)) {
      continue;
    }
    // A fill of the wrong kind is ignored rather than coerced: it can only come
    // from a hand-edited project, and the placeholder is the honest fallback.
    if (fill.kind !== slot.kind) {
      continue;
    }
    for (const key of slot.elementKeys) {
      replacements.set(key, fill);
    }
  }

  const out: Timeline = {};
  for (const innerKey of Object.keys(data.elements)) {
    const source = data.elements[innerKey];
    if (source == null || typeof source !== "object") {
      continue;
    }
    if (source.filetype === "template") {
      continue;
    }
    const fill = replacements.get(innerKey);
    out[innerKey] = fill != null ? filled(source, fill) : source;
  }
  return out;
}

/**
 * The elements one placed template draws, in the template's own time.
 *
 * Keys are namespaced against `outerId`, which is the element's id in the
 * **outer** document rather than its `key` field: the two are normally equal,
 * nothing guarantees it, and the asset store indexes by the map id.
 *
 * Every reference between them moves into the namespace too, through
 * `timeline/elementRefs.ts`: a parent, a property link's source and a
 * transition's two clips. One naming an element that is not here (a
 * hand-edited file, or a group that was itself a stripped template) is
 * dropped rather than left dangling, which is what `repairHierarchy` would do
 * to a parent anyway. A link left on its bare key found nothing in this map
 * and fell back to the static value, so a link authored inside a template
 * worked in the template's own project and silently stopped working once
 * placed.
 */
export function composeTemplate(
  data: TemplateData,
  outerId: string,
  element: TemplateElementType,
): Timeline {
  const baked = bakeFills(data, element);
  const rename = (innerKey: string) =>
    baked[innerKey] != null ? namespacedKey(outerId, innerKey) : null;

  const out: Timeline = {};
  for (const innerKey of Object.keys(baked)) {
    const id = namespacedKey(outerId, innerKey);
    out[id] = renameElementRefs(
      { ...baked[innerKey], key: id } as TimelineElement,
      rename,
    );
  }
  return out;
}

/**
 * Every element in the project, with each template's contents flattened in and
 * rebased onto the real timeline.
 *
 * **For the asset layer and the export's sound only.** The picture is drawn
 * from the nested composition, so handing this to the renderer would draw
 * every inner clip twice: once inside its template's layer and once loose on
 * the project. What it is for is everything that answers "which files does
 * this project need decoded, and when, and what does it sound like":
 * `loadEntireTimeline`, `loadAssetsNeededAtTime`, `syncPlayback`, `seek`,
 * `releaseUnusedVideos`, and the map the export hands FFmpeg for the audio mix
 * (`export/exportSession.ts`), which is what makes a template's music reach the
 * delivered file rather than only the preview.
 *
 * **An inner clip is cut at its template's bar.** A clip shorter than its
 * template's contents (a composition grown into a neighbour, an installed
 * template re-installed longer) shows nothing past its end, so nothing past
 * its end may be decoded or heard either: a clip that starts after the bar
 * ends is left out, and one running past it is trimmed back to it with the
 * same `clipEdit.ts#trimEnd` a drag of its right edge uses.
 *
 * Returns its input **by identity** when there is nothing to expand, so the
 * WeakMap caches downstream of it keep working on an ordinary project.
 */
export function expandTemplates(
  elements: Timeline,
  resolve: (templateId: string) => TemplateData | null,
): Timeline {
  const templates = Object.keys(elements).filter(
    (id) => elements[id]?.filetype === "template",
  );
  if (templates.length === 0) {
    return elements;
  }

  const out: Timeline = { ...elements };
  let added = false;

  for (const outerId of templates) {
    const element = elements[outerId] as TemplateElementType;
    const data = resolve(element.templateId);
    // A template that is not installed contributes nothing, and reports
    // nothing. The contract a missing LUT already has.
    if (data == null) {
      continue;
    }

    const composed = composeTemplate(data, outerId, element);
    const offset = Number(element.startTime) || 0;
    const length = Number(element.duration);
    const barEnd = length > 0 ? offset + length : Infinity;

    for (const id of Object.keys(composed)) {
      const inner = composed[id];
      const placed = {
        ...inner,
        startTime: (Number(inner.startTime) || 0) + offset,
      } as TimelineElement;
      const span = spanOf(placed);
      if (span.start >= barEnd) {
        continue;
      }
      out[id] = span.end > barEnd ? trimEnd(placed, barEnd - span.end) : placed;
      added = true;
    }
  }

  return added ? out : elements;
}

/** Whether this element's kind can take the fill offered for it. */
export function fillMatches(
  element: TimelineElement | undefined | null,
  fill: TemplateFill,
): boolean {
  return slotKindOf(element) === fill.kind;
}
