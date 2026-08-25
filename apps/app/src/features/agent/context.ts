/**
 * The small lookups every command needs before it can do anything.
 *
 * These lived at the top of `commands/edit.ts` while cutting was the only thing
 * an agent could do. Six command files now need the same three answers — what
 * is the document, does this id exist, where is the frame grid — and copying
 * them is how the frame snapping quietly stops applying to whichever family
 * forgot to copy it.
 */

import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { normalizeFps, snapMsToFrame } from "../timeline/frames";
import { trackById, type TimelineDocument, type TimelineTrack } from "../timeline/tracks";
import type { TimelineElement } from "../../@types/timeline";
import { clipRow } from "./serialize";

export function currentDoc(): TimelineDocument {
  return useTimelineStore.getState().getDocument();
}

export function requireElement(
  doc: TimelineDocument,
  elementId: string,
): TimelineElement {
  const element = doc.elements[elementId];
  if (element == null) {
    throw new Error(
      `No clip with id "${elementId}". Use list_clips to see current ids.`,
    );
  }
  return element;
}

export function requireTrack(
  doc: TimelineDocument,
  trackId: string,
): TimelineTrack {
  const track = trackById(doc, trackId);
  if (track == null) {
    throw new Error(
      `No track with id "${trackId}". Use get_project_overview to see tracks.`,
    );
  }
  return track;
}

/** The project frame rate — the same field the exporter samples with. */
export function projectFps(): number {
  return normalizeFps(renderOptionStore.getState().options?.fps);
}

/**
 * An absolute timeline time, moved onto the frame grid.
 *
 * Every absolute time an agent supplies goes through this, exactly as the
 * mouse's does. An agent asking for 1988ms is not asking for something the
 * timeline can express — nothing renders between frames — and letting it
 * through would mean the one path that bypasses the grid is the automated one.
 */
export function onFrame(ms: number): number {
  return snapMsToFrame(ms, projectFps());
}

/** Where the user is looking. The default `startMs` for anything newly added. */
export function playheadMs(): number {
  return Math.max(0, Math.round(useTimelineStore.getState().cursor));
}

/** Compact rows for a set of ids, read from the document as it stands now. */
export function clipsResponse(ids: string[]): unknown[] {
  const doc = currentDoc();
  const names = new Map(doc.tracks.map((t) => [t.id, t.name]));
  return ids
    .filter((id) => doc.elements[id] != null)
    .map((id) => clipRow(id, doc.elements[id], names.get(doc.elements[id].trackId)));
}
