/**
 * Giving a template's document an identity of its own inside a project.
 *
 * A composition forked from an installed template starts with the template
 * author's element and track ids. Two forks of one template would share all of
 * them, and so would a template exported from this very project and placed
 * back into it. Everything keyed outside the document by those ids would then
 * mix the two: `trackHeightStore` and `noteStore` (by track id, saved with the
 * project), `loadedAssetStore`'s decoders and the graphic rasters (by element
 * id). A fresh id for every element and every track removes the whole class at
 * the moment the copy is made.
 *
 * Pure, DOM-free and store-free.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { renameElementRefs } from "../timeline/elementRefs";
import { chooseTrackFor } from "../timeline/placement";
import {
  SCHEMA_VERSION,
  normalizeDocument,
  paintOrder,
  type TimelineDocument,
} from "../timeline/tracks";
import type { TimelineContent } from "./project";

/**
 * Every clip whose `trackId` names no track, given one.
 *
 * `templateDocument.ts` reads a missing or malformed `tracks.json` as no tracks
 * at all, and `normalizeDocument` never creates a track, so such a clip would
 * be in the document and on no row of the timeline. Each is placed by
 * `placement.ts#chooseTrackFor`, the rule a newly added clip follows, back to
 * front so the stack keeps the order the template painted in. A transition is
 * not placed: it goes on its outgoing clip's row, where `repairTransitions`
 * expects it.
 *
 * Returns its input by identity when every clip already has a row.
 */
export function adoptOrphans(
  content: TimelineContent,
  idGen: () => string,
): TimelineContent {
  const trackIds = new Set(content.tracks.map((track) => track.id));
  const orphaned = (element: TimelineElement) =>
    !trackIds.has(element.trackId);
  if (!Object.values(content.elements).some(orphaned)) {
    return content;
  }

  let doc: TimelineDocument = {
    schemaVersion: SCHEMA_VERSION,
    tracks: content.tracks,
    elements: content.elements,
  };

  const order = paintOrder(doc);
  for (const id of order) {
    const element = doc.elements[id];
    if (!orphaned(element) || element.filetype === "transition") {
      continue;
    }
    const chosen = chooseTrackFor(doc, element, element.startTime, idGen());
    doc = {
      ...chosen.doc,
      elements: {
        ...chosen.doc.elements,
        [id]: { ...element, trackId: chosen.trackId } as TimelineElement,
      },
    };
  }

  const placed = new Set(doc.tracks.map((track) => track.id));
  let elements: Timeline | null = null;
  for (const id of order) {
    const element = doc.elements[id];
    if (element.filetype !== "transition" || placed.has(element.trackId)) {
      continue;
    }
    const fromId = (element as { fromId?: string }).fromId ?? "";
    const host = doc.elements[fromId];
    if (host == null) {
      continue;
    }
    elements ??= { ...doc.elements };
    elements[id] = { ...element, trackId: host.trackId } as TimelineElement;
  }
  if (elements != null) {
    doc = { ...doc, elements };
  }

  const normalized = normalizeDocument(doc);
  return { tracks: normalized.tracks, elements: normalized.elements };
}

/**
 * The same document under fresh ids.
 *
 * Renamed: every element's map key and `key` field, every track's `id` and
 * every clip's `trackId`, and every reference between elements through
 * `timeline/elementRefs.ts` (parent, property link source, a transition's two
 * clips). A reference to an element that is not in the document is dropped by
 * that module's rules rather than left naming an id from the author's machine.
 */
export function rekeyContent(
  content: TimelineContent,
  idGen: () => string,
): TimelineContent {
  const trackIds = new Map<string, string>();
  for (const track of content.tracks) {
    trackIds.set(track.id, idGen());
  }
  const elementIds = new Map<string, string>();
  for (const id of Object.keys(content.elements)) {
    elementIds.set(id, idGen());
  }
  const rename = (id: string) => elementIds.get(id) ?? null;

  const tracks = content.tracks.map((track) => ({
    ...track,
    id: trackIds.get(track.id) as string,
  }));

  const elements: Timeline = {};
  for (const [oldId, element] of Object.entries(content.elements)) {
    const id = elementIds.get(oldId) as string;
    elements[id] = renameElementRefs(
      {
        ...element,
        key: id,
        trackId: trackIds.get(element.trackId) ?? element.trackId,
      } as TimelineElement,
      rename,
    );
  }

  return { tracks, elements };
}
