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
  /** Derived once at load by `slotsOf`, so every read is a lookup. */
  slots: TemplateSlot[];
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
 * One element with the user's replacement in it.
 *
 * The trim window is `[offset, offset + duration)` in the **source**, with the
 * offset clamped so it cannot start past the point where the slot's length
 * still fits. A source shorter than the slot pins the offset to zero and lets
 * the window overrun — the window has to span the slot for the duration
 * invariant to hold, and the picture simply runs out inside it, which is what
 * every editor does with a clip trimmed past its end.
 */
function filled(element: TimelineElement, fill: TemplateFill): TimelineElement {
  if (fill.kind === "text") {
    return { ...element, text: fill.text } as TimelineElement;
  }

  const next = { ...element, localpath: fill.localpath } as TimelineElement & {
    trim?: { startTime: number; endTime: number };
    sourceDuration?: number;
  };

  // Only a clip with a source window has an in-point to choose. An image and a
  // GIF have none, and inventing a `trim` on them would put a field on an
  // element type that has no reader for it.
  if (
    (element as { trim?: unknown }).trim == null ||
    typeof (element as { trim?: unknown }).trim !== "object"
  ) {
    return next as TimelineElement;
  }

  const span = Number(element.duration) || 0;
  const source = Number(fill.sourceDurationMs) || 0;
  const offset = clamp(Number(fill.offsetMs) || 0, 0, Math.max(0, source - span));

  next.trim = { startTime: offset, endTime: offset + span };
  next.sourceDuration = source;
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
 * The elements one placed template draws, in the template's own time.
 *
 * Keys are namespaced against `outerId`, which is the element's id in the
 * **outer** document rather than its `key` field — the two are normally equal
 * and nothing guarantees it, and the asset store indexes by the map id.
 */
export function composeTemplate(
  data: TemplateData,
  outerId: string,
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
    // Nesting is capped at one level, here and at export. A depth counter would
    // have to be threaded through a render path with no other reason to know
    // recursion exists.
    if (source.filetype === "template") {
      continue;
    }

    const id = namespacedKey(outerId, innerKey);
    const fill = replacements.get(innerKey);
    const base = fill != null ? filled(source, fill) : source;

    const next = { ...base, key: id } as TimelineElement;

    // A parent inside the template moves into the namespace with its child. One
    // naming an element that is not here — a hand-edited file, or a group that
    // was itself a stripped template — is dropped rather than left dangling,
    // which is what `repairHierarchy` would do to it anyway.
    const parentId = (source as { parentId?: unknown }).parentId;
    if (typeof parentId === "string" && parentId !== "") {
      if (data.elements[parentId] != null) {
        (next as { parentId?: string }).parentId = namespacedKey(
          outerId,
          parentId,
        );
      } else {
        delete (next as { parentId?: string }).parentId;
      }
    }

    out[id] = next;
  }

  return out;
}

/**
 * Every element in the project, with each template's contents flattened in and
 * rebased onto the real timeline.
 *
 * **For the asset layer and the export's audio planner only.** The picture is
 * drawn from the nested composition, so handing this to the renderer would draw
 * every inner clip twice — once inside its template's layer and once loose on
 * the project. What it is for is everything that answers "which files does this
 * project need decoded, and when": `loadEntireTimeline`,
 * `loadAssetsNeededAtTime`, `syncPlayback`, `seek`, `releaseUnusedVideos`, and
 * `ffmpegArgs`'s audio half, which is what makes a template's music reach the
 * delivered file rather than only the preview.
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

    for (const id of Object.keys(composed)) {
      const inner = composed[id];
      out[id] = {
        ...inner,
        startTime: (Number(inner.startTime) || 0) + offset,
      } as TimelineElement;
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
