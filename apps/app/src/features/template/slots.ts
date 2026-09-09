/**
 * Which of a template's clips its user may replace, derived from the document.
 *
 * A template's author marks clips in the timeline's context menu, which writes
 * an optional `replaceable` field. This module reads those marks back and turns
 * them into the list `<option-template>` renders and `compose.ts` fills.
 *
 * **The slot list is derived, never stored.** `template.json` carries a name
 * and a thumbnail and nothing else, deliberately: a slot list written beside
 * the document would be a second answer to a question the document already
 * answers, and the copy that drifted would be the one nobody was looking at.
 * Deriving it also means a slot cannot outlive the clip it names — deleting a
 * marked clip before exporting simply removes the slot.
 *
 * **A slot is not an element.** `slotId` is a name the author gives, so the
 * same shot cut in twice — or a lower third repeated in the outro — is one
 * thing to hand a replacement for rather than two. That grouping is the whole
 * reason the field is not just a boolean.
 *
 * DOM-free and store-free, so it runs in the `node` suite with the rest of the
 * pure modules.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { detectFlavour, toFsPath } from "../project/assetPaths";

export type TemplateSlotKind = "media" | "text";

export type TemplateSlot = {
  slotId: string;
  /** What `<option-template>` calls this row. Never empty. */
  label: string;
  kind: TemplateSlotKind;
  /** Every element this one fill replaces, sorted so the order is stable. */
  elementKeys: string[];
  /** The slot's span on the template's own timeline, in ms. */
  durationMs: number;
  width: number;
  height: number;
};

/**
 * The four filetypes a person can hand a replacement for.
 *
 * A shape's fill, an effect's parameters and a transition's preset are settings
 * rather than sources, and a group holds a transform rather than content —
 * there is nothing about any of them a file could stand in for. Audio is left
 * out for a different reason: a template's music is part of the template, and
 * `add_media` on a track of the user's own is the better way to change it.
 */
const REPLACEABLE_FILETYPES = ["video", "image", "gif", "text"] as const;

export function isReplaceableFiletype(filetype: string): boolean {
  return (REPLACEABLE_FILETYPES as readonly string[]).includes(filetype);
}

/** The kind of fill this element takes. `null` when it can take none. */
export function slotKindOf(
  element: TimelineElement | undefined | null,
): TemplateSlotKind | null {
  const filetype = (element as { filetype?: string } | null)?.filetype;
  if (filetype == null || !isReplaceableFiletype(filetype)) {
    return null;
  }
  return filetype === "text" ? "text" : "media";
}

/** The mark, if this element carries a usable one. A guard, so it never throws. */
function markOf(
  element: unknown,
): { slotId: string; label: string | null } | null {
  if (element == null || typeof element !== "object") {
    return null;
  }
  const raw = (element as { replaceable?: unknown }).replaceable;
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const slotId = (raw as { slotId?: unknown }).slotId;
  if (typeof slotId !== "string" || slotId.trim() === "") {
    return null;
  }
  const label = (raw as { label?: unknown }).label;
  return {
    slotId: slotId.trim(),
    label: typeof label === "string" && label.trim() !== "" ? label.trim() : null,
  };
}

/** The filename a media clip's `localpath` names, decoded and separator-agnostic. */
function basenameOf(localpath: unknown): string | null {
  if (typeof localpath !== "string" || localpath === "") {
    return null;
  }
  const fsPath = toFsPath(localpath, detectFlavour(localpath));
  const name = fsPath.split(/[\\/]/).pop() ?? "";
  return name === "" ? null : name;
}

/** A text clip's own content, flattened to the one line a row can show. */
function oneLine(text: unknown): string | null {
  if (typeof text !== "string") {
    return null;
  }
  const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return flat === "" ? null : flat;
}

function labelFor(
  element: TimelineElement,
  kind: TemplateSlotKind,
  slotId: string,
): string {
  const derived =
    kind === "text"
      ? oneLine((element as { text?: unknown }).text)
      : basenameOf((element as { localpath?: unknown }).localpath);
  return derived ?? slotId;
}

/**
 * Every slot this document offers, in the order they appear on screen.
 *
 * Front to back, because that is the order someone filling them in will meet
 * them; ties break on `slotId` so the list can never go hash-dependent.
 *
 * A slot takes its kind, span and box from its **first member in key order**,
 * and members that disagree about kind are dropped from it. Authoring cannot
 * produce a mixed slot — the context menu mints a fresh id per mark — so that
 * case only arises from a hand-edited file, and a dropped member keeps its
 * placeholder, which is visible. Taking it in would put a line of text into a
 * video.
 */
export function slotsOf(elements: Timeline): TemplateSlot[] {
  const groups = new Map<
    string,
    { keys: string[]; kind: TemplateSlotKind; label: string | null }
  >();

  // Key order throughout, so "first member" is a fact about the document rather
  // than about the order `Object.keys` happened to return.
  for (const key of Object.keys(elements).sort()) {
    const element = elements[key];
    const mark = markOf(element);
    if (mark == null) {
      continue;
    }
    const kind = slotKindOf(element);
    if (kind == null) {
      continue;
    }

    const existing = groups.get(mark.slotId);
    if (existing == null) {
      groups.set(mark.slotId, { keys: [key], kind, label: mark.label });
      continue;
    }
    if (existing.kind !== kind) {
      continue;
    }
    existing.keys.push(key);
    existing.label = existing.label ?? mark.label;
  }

  const slots: (TemplateSlot & { at: number })[] = [];

  for (const [slotId, group] of groups) {
    const first = elements[group.keys[0]] as TimelineElement & {
      width?: number;
      height?: number;
    };
    const at = Math.min(
      ...group.keys.map((key) => Number(elements[key]?.startTime) || 0),
    );
    slots.push({
      slotId,
      kind: group.kind,
      label: group.label ?? labelFor(first, group.kind, slotId),
      elementKeys: group.keys,
      durationMs: Number(first?.duration) || 0,
      width: Number(first?.width) || 0,
      height: Number(first?.height) || 0,
      at,
    });
  }

  return slots
    .sort((a, b) => a.at - b.at || a.slotId.localeCompare(b.slotId))
    .map(({ at: _at, ...slot }) => slot);
}
