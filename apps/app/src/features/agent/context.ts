/**
 * The small lookups every command needs before it can do anything.
 *
 * These lived at the top of `commands/edit.ts` while cutting was the only thing
 * an agent could do. Six command files now need the same three answers — what
 * is the document, does this id exist, where is the frame grid — and copying
 * them is how the frame snapping quietly stops applying to whichever family
 * forgot to copy it.
 */

import { activeTransaction } from "../extension/transaction";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { bakeRateFor } from "../animation/keyframes";
import { normalizeFps, snapMsToFrame } from "../timeline/frames";
import { spanLength, spanStart } from "../timeline/geometry";
import { trackById, type TimelineDocument, type TimelineTrack } from "../timeline/tracks";
import type { TimelineElement } from "../../@types/timeline";
import { clipRow } from "./serialize";

/**
 * The document every command reads.
 *
 * Inside a batch this is the working document rather than the store's, so
 * step N of a batch validates against step N-1's result. Without it, a batch
 * that splits a clip and then trims one of the halves would look up an id that
 * the store has never heard of.
 */
export function currentDoc(): TimelineDocument {
  return activeTransaction()?.working ?? useTimelineStore.getState().getDocument();
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

/**
 * The rate this project's curves must be baked at.
 *
 * `bakeRateFor` is the rule (`max(60, fps)`). Every op in `keyframeOps` takes
 * `bakeHz` as a trailing optional defaulting to 60, so a command that omits it
 * bakes a 120fps project's curve at half the project's rate and it steps,
 * visibly, until the file is reloaded. Reading the store for it is what an
 * agent command is allowed to do and a pure op is not.
 */
export function projectBakeHz(): number {
  return bakeRateFor(projectFps());
}

/**
 * An absolute timeline time as an offset from the clip's start, on the grid.
 *
 * **Keyframe times are stored relative to the clip's own start**, while every
 * tool in this surface speaks absolute timeline ms. Exposing the element-local
 * form to an agent would be a trap: it has just read `list_clips`, which reports
 * absolute times, and nothing in the parameter name would say otherwise.
 *
 * Throws rather than clamping when the time falls outside the clip. A keyframe
 * past the clip's end never plays, so clamping would report success for an edit
 * with no visible effect.
 */
export function localTime(element: TimelineElement, atMs: number): number {
  const start = spanStart(element);
  const length = spanLength(element);
  const local = onFrame(atMs) - start;

  if (local < 0 || local > length) {
    throw new Error(
      `${Math.round(atMs)}ms is outside the clip, which runs ${Math.round(start)}–${Math.round(
        start + length,
      )}ms. A keyframe outside the clip would never play.`,
    );
  }
  return local;
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
