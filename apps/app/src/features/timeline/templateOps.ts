/**
 * Document-level edits for templates, on both sides of the feature.
 *
 * Two audiences share this module because they share its rules. A template's
 * **user** places one and fills its slots; a template's **author** marks the
 * clips that will become those slots. Both are ordinary pure ops, and both hold
 * the three contracts the rest of `features/timeline/` holds:
 *
 *  1. **Not every element can carry the field.** Only a `template` has fills,
 *     and only video, image, gif and text can be marked replaceable — see
 *     `features/template/slots.ts` for why those four.
 *  2. **Clearing deletes the key** rather than storing a null, so a project
 *     nobody has marked up saves byte-identically to one written before the
 *     feature and `SCHEMA_VERSION` did not move.
 *  3. **Declining returns the document by identity**, which `withCheckpoint`
 *     reads as "nothing happened" and records no undo step.
 *
 * `isDurationLocked` is the one export the rest of the codebase leans on. A
 * template's length belongs to its author, so every op that would change it
 * declines on one, and `layout.ts#hitTest` reads the same predicate so the trim
 * handles are never drawn in the first place — the house rule that an
 * affordance which can only decline should not be offered. Writing that
 * condition once is what keeps split, trim, speed, merge, detach-audio and
 * rasterize from drifting apart.
 */

import type {
  TemplateElementType,
  TemplateFill,
  TimelineElement,
} from "../../@types/timeline";
import { emptyAnimation } from "../animation/keyframes";
import { isReplaceableFiletype } from "../template/slots";
import { isDurationLocked } from "./geometry";
import { placeNewElement } from "./placement";
import type { TimelineDocument } from "./tracks";

/** The sentinel a template carries where other elements name a file. */
export const TEMPLATE_SENTINEL = "TEMPLATE";

const DEFAULT_COLOR = "#6a5acd";

/**
 * The predicate every locked operation declines on.
 *
 * Re-exported rather than restated: it is defined in `geometry.ts`, which owns
 * the trim/duration/speed invariants and which `clipEdit.ts` can read without
 * importing this module — this one reaches `placement.ts` and would close a
 * cycle. Two definitions of it is exactly the drift `isSpeedAdjustable`'s
 * header warns about.
 */
export { isDurationLocked };

/** Whether this clip may be marked as a template slot. */
export function isReplaceable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && isReplaceableFiletype(element.filetype);
}

/** The mark on a clip, or `null`. The context menu's read model. */
export function replaceableOf(
  doc: TimelineDocument,
  elementId: string,
): { slotId: string; label?: string } | null {
  const raw = (doc.elements[elementId] as { replaceable?: unknown } | undefined)
    ?.replaceable;
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const slotId = (raw as { slotId?: unknown }).slotId;
  return typeof slotId === "string" && slotId !== ""
    ? (raw as { slotId: string; label?: string })
    : null;
}

export type CreateTemplateOptions = {
  templateId: string;
  name: string;
  durationMs: number;
  /** The size the template's own document was composed at. */
  size: { w: number; h: number };
  /** The project frame, so the template lands scaled to fit inside it. */
  frame: { w: number; h: number };
  startTime?: number;
  color?: string;
};

/**
 * Build a template element, unplaced.
 *
 * A factory rather than a document op, the shape `element/nullElement.ts`
 * settled on and for its reason: the browser panel, a drop and any later MCP
 * tool must produce the *same* element, and a factory is the only arrangement
 * that guarantees it. `trackId` and `priority` are left blank for
 * `placeNewElement` to fill.
 *
 * It lands **contained** in the project frame and centred, preserving aspect —
 * what an imported still does. Filling the frame instead would crop a portrait
 * template to nothing on a landscape project, and stretching it would be the
 * one thing no editor does.
 */
export function createTemplateElement(
  options: CreateTemplateOptions,
): TemplateElementType {
  const frameW = Math.max(1, Number(options.frame.w) || 0);
  const frameH = Math.max(1, Number(options.frame.h) || 0);
  const nativeW = Number(options.size.w) || 0;
  const nativeH = Number(options.size.h) || 0;

  // A template claiming no size is a broken manifest, not a reason to refuse:
  // it takes the frame, which is what a full-bleed template wanted anyway.
  const fit =
    nativeW > 0 && nativeH > 0
      ? Math.min(frameW / nativeW, frameH / nativeH)
      : 0;
  const width = fit > 0 ? nativeW * fit : frameW;
  const height = fit > 0 ? nativeH * fit : frameH;

  return {
    filetype: "template",
    key: "",
    templateId: options.templateId,
    name: options.name,
    fills: {},
    // Not a file. `assetsFile.ts` lists this among its sentinels so no relinker
    // goes looking for it, and the media a template needs is named from inside
    // its own installed `template.ngt`.
    localpath: TEMPLATE_SENTINEL,
    trackId: "",
    priority: 0,
    blob: "",
    startTime: Math.max(0, Number(options.startTime) || 0),
    duration: Math.max(0, Number(options.durationMs) || 0),
    location: { x: (frameW - width) / 2, y: (frameH - height) / 2 },
    width,
    height,
    ratio: height === 0 ? 1 : width / height,
    opacity: 100,
    rotation: 0,
    animation: emptyAnimation("template"),
    timelineOptions: { color: options.color ?? DEFAULT_COLOR },
  } as TemplateElementType;
}

/**
 * Put a template on the timeline.
 *
 * `defaultTrackKindFor` falls through to `"video"` for anything it does not
 * name, which is the track kind a template belongs on — so this is
 * `placeNewElement` and nothing else, and a template reuses a free video row
 * before a new one is added, exactly as an image does.
 */
export function addTemplate(
  doc: TimelineDocument,
  elementId: string,
  element: TemplateElementType,
  startMs: number,
  newTrackId: string,
  preferredTrackId?: string,
): TimelineDocument {
  return placeNewElement(
    doc,
    elementId,
    { ...element, key: elementId },
    startMs,
    newTrackId,
    preferredTrackId,
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Whether a fill is worth storing. It reaches the saved project. */
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

function sameFill(a: TemplateFill | undefined, b: TemplateFill | null): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "text" && b.kind === "text") {
    return a.text === b.text;
  }
  return (
    a.kind === "media" &&
    b.kind === "media" &&
    a.localpath === b.localpath &&
    a.offsetMs === b.offsetMs &&
    a.sourceDurationMs === b.sourceDurationMs
  );
}

function withFills(
  doc: TimelineDocument,
  elementId: string,
  fills: Record<string, TemplateFill>,
): TimelineDocument {
  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: { ...doc.elements[elementId], fills } as TimelineElement,
    },
  };
}

/**
 * Put the user's media or text into one slot, or clear it with `null`.
 *
 * The slot is not validated against the template's own slot list, deliberately:
 * a template that is not installed has no slot list, and refusing to store a
 * fill on that basis would lose the user's choices every time they opened the
 * project on a machine missing the template. `composeTemplate` ignores a fill
 * naming no slot, which is the same arrangement `lutOps` makes for an
 * uninstalled preset id — preserve what the document said, and let the layer
 * that can see the template decide what it means.
 */
export function setTemplateFill(
  doc: TimelineDocument,
  elementId: string,
  slotId: string,
  fill: TemplateFill | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isDurationLocked(element)) {
    return doc;
  }
  if (typeof slotId !== "string" || slotId.trim() === "") {
    return doc;
  }
  if (fill != null && !isUsable(fill)) {
    return doc;
  }

  const current = (element as TemplateElementType).fills ?? {};
  const existing = current[slotId];

  if (fill == null) {
    if (!(slotId in current)) {
      return doc;
    }
    // Removed rather than set to `undefined`: `JSON.stringify` drops an
    // undefined value, so the saved project would not match the one in memory.
    const { [slotId]: _cleared, ...rest } = current;
    return withFills(doc, elementId, rest);
  }

  if (sameFill(existing, fill)) {
    return doc;
  }
  return withFills(doc, elementId, { ...current, [slotId]: fill });
}

/**
 * Move a media fill's in-point.
 *
 * Clamped to the source's own length here as well as in `composeTemplate`,
 * because the stored value is what the panel's slider reads back and a value
 * outside the range would leave the handle somewhere the user cannot reach.
 */
export function setTemplateFillOffset(
  doc: TimelineDocument,
  elementId: string,
  slotId: string,
  offsetMs: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isDurationLocked(element)) {
    return doc;
  }
  const fill = ((element as TemplateElementType).fills ?? {})[slotId];
  // A text fill has no in-point, and a slot with none has nothing to move.
  if (fill == null || fill.kind !== "media") {
    return doc;
  }

  const next = clamp(
    Number(offsetMs) || 0,
    0,
    Math.max(0, Number(fill.sourceDurationMs) || 0),
  );
  if (next === fill.offsetMs) {
    return doc;
  }
  return setTemplateFill(doc, elementId, slotId, { ...fill, offsetMs: next });
}

/**
 * Mark clips as template slots.
 *
 * **One mark is one slot.** Marking a multi-selection gives each clip a slot of
 * its own rather than binding them together: sharing an id means "one
 * replacement fills all of these", which is a deliberate act and not what
 * selecting three clips and clicking once should mean.
 *
 * `idGen` is injected rather than called for, the rule `trackNullOp.ts` states:
 * an op that mints its own ids cannot be tested for what it produced.
 *
 * A clip that is already marked is left exactly as it is. Re-minting its
 * `slotId` would orphan every fill keyed on the old one in every project
 * already using the template.
 */
export function setReplaceable(
  doc: TimelineDocument,
  elementIds: readonly string[],
  idGen: () => string,
  label?: string,
): TimelineDocument {
  const targets = elementIds.filter(
    (id) => isReplaceable(doc.elements[id]) && replaceableOf(doc, id) == null,
  );
  if (targets.length === 0) {
    return doc;
  }

  const elements = { ...doc.elements };
  for (const id of targets) {
    const mark: { slotId: string; label?: string } = { slotId: idGen() };
    if (typeof label === "string" && label.trim() !== "") {
      mark.label = label.trim();
    }
    elements[id] = { ...elements[id], replaceable: mark } as TimelineElement;
  }

  return { ...doc, elements };
}

/** Unmark clips. Declines when none of them were marked. */
export function clearReplaceable(
  doc: TimelineDocument,
  elementIds: readonly string[],
): TimelineDocument {
  const targets = elementIds.filter((id) => replaceableOf(doc, id) != null);
  if (targets.length === 0) {
    return doc;
  }

  const elements = { ...doc.elements };
  for (const id of targets) {
    const { replaceable: _cleared, ...rest } = elements[id] as TimelineElement & {
      replaceable?: unknown;
    };
    elements[id] = rest as TimelineElement;
  }

  return { ...doc, elements };
}
