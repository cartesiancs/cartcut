/**
 * Importing files onto the timeline: the half that is I/O, and the half that
 * is a pure transform.
 *
 * The asset panel's original path — `AssetController.add` calling
 * `elementControl.addImage/addVideo/...` — is callback-based with no promise
 * and no returned id, which makes it impossible to place several files as one
 * run. It coped by leaving the drop position on a shared `control.dropHint`
 * field for the next add to pick up, which races the moment two files are
 * dropped together (whichever probe finishes first takes the hint) and leaves a
 * stale hint behind when one fails, so the *next* thing added anywhere in the
 * app lands at a position nobody asked for.
 *
 * `mediaProbe.ts` and `mediaElement.ts` already exist to replace that path, and
 * `agent/commands/media.ts` already composes them into exactly the batch this
 * needs. What was missing was a seam the UI could reach: `commit()` lives in
 * the agent layer and reports a diff no mouse gesture wants. So the batch moves
 * here, and both callers use it — the agent through `commit`, the drop handlers
 * through `withCheckpoint`. One code path, one undo step, no shared field.
 */

import { spanEnd } from "../timeline/geometry";
import { snapMsToFrame } from "../timeline/frames";
import { placeNewElement } from "../timeline/placement";
import type { TimelineDocument } from "../timeline/tracks";
import { buildMediaElement, type MediaProbe } from "../element/mediaElement";
import { probeMedia, type MediaProber } from "../element/mediaProbe";

export type ImportItem = {
  path: string;
  /** Overrides the run's position for this one file. */
  startMs?: number;
  /** Stills only. */
  durationMs?: number;
  trackId?: string;
};

export type ImportPlan = {
  ready: { item: ImportItem; probe: MediaProbe }[];
  /** Files that could not be read, with the reason to show the user. */
  skipped: { path: string; reason: string }[];
};

export const emptyPlan: ImportPlan = { ready: [], skipped: [] };

/**
 * Look at every file, and keep the ones the editor can render.
 *
 * Probed in parallel and *settled* rather than raced: reading metadata is I/O
 * measured in hundreds of milliseconds, and one unreadable file in a drop of
 * ten must not lose the other nine. `probeMedia` throws with a usable message
 * for an extension there is no renderer for, which is why nothing upstream
 * filters by extension — this is the single place that decides.
 */
export async function planImport(
  items: readonly (ImportItem | string)[],
  prober?: MediaProber,
): Promise<ImportPlan> {
  const normalized: ImportItem[] = items.map((item) =>
    typeof item === "string" ? { path: item } : item,
  );

  if (normalized.length === 0) {
    return emptyPlan;
  }

  const outcomes = await Promise.allSettled(
    normalized.map((item) => probeMedia(item.path, prober)),
  );

  const ready: ImportPlan["ready"] = [];
  const skipped: ImportPlan["skipped"] = [];

  outcomes.forEach((outcome, index) => {
    const item = normalized[index];
    if (outcome.status === "fulfilled") {
      ready.push({ item, probe: outcome.value });
    } else {
      skipped.push({
        path: item.path,
        reason:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      });
    }
  });

  return { ready, skipped };
}

export type PlaceOptions = {
  /** Where the run begins. Already clamped and snapped by the caller. */
  startMs: number;
  /** The row the user aimed at, if they aimed at one. */
  trackId?: string | null;
  fps: number;
  newId: () => string;
  /**
   * Lay the files end to end rather than stacking them at one moment.
   *
   * On by default: a folder of clips dropped together is a run, and stacking
   * them would scatter them across as many new tracks as there are files.
   */
  sequential?: boolean;
};

/**
 * Place every probed file, as one pure transform.
 *
 * Declines by identity when there is nothing to place, so `withCheckpoint`
 * records no undo step for a drop of nothing but unreadable files — the rule
 * every op in this codebase follows.
 */
export function placeImported(
  doc: TimelineDocument,
  plan: ImportPlan,
  options: PlaceOptions,
): { doc: TimelineDocument; createdIds: string[] } {
  if (plan.ready.length === 0) {
    return { doc, createdIds: [] };
  }

  const { startMs, trackId, fps, newId } = options;
  const sequential = options.sequential !== false;
  const onFrame = (ms: number) => Math.max(0, snapMsToFrame(Math.max(0, ms), fps));

  const runStart = onFrame(startMs);
  const createdIds: string[] = [];

  let next = doc;
  let cursor = runStart;

  for (const { item, probe } of plan.ready) {
    const explicit = item.startMs != null ? onFrame(item.startMs) : null;
    const startTime = explicit ?? (sequential ? cursor : runStart);

    const element = buildMediaElement(probe, {
      startTime,
      durationMs: item.durationMs,
    });

    const elementId = newId();
    next = placeNewElement(
      next,
      elementId,
      element,
      startTime,
      newId(),
      item.trackId ?? trackId ?? undefined,
    );
    createdIds.push(elementId);

    // Read back rather than recomputed: a still takes its length from
    // `durationMs` and a video from the file, and only the placed element
    // knows which happened.
    const placed = next.elements[elementId];
    if (placed != null) {
      cursor = Math.max(cursor, onFrame(spanEnd(placed)));
    }
  }

  return { doc: next, createdIds };
}
