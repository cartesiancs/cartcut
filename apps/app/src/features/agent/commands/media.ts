/**
 * Putting new things on the timeline.
 *
 * `add_media` is a batch by design, not by convenience — the same reasoning
 * `add_subtitles` records. Five files placed one at a time cost five round
 * trips, five undo steps, and five chances for the track chooser to scatter
 * them, because each is committed against a document the previous one already
 * changed. Placed together in one transform they land as a run.
 *
 * Probing happens *before* the transform and in parallel: reading a file's
 * metadata is I/O measured in hundreds of milliseconds, and the pure op has to
 * stay pure.
 */

import { v4 as uuidv4 } from "uuid";
import { assetStore } from "../../../states/assetStore";
import { placeNewElement } from "../../timeline/placement";
import { spanEnd } from "../../timeline/geometry";
import { buildMediaElement, DEFAULT_STILL_MS } from "../../element/mediaElement";
import { probeMedia, type MediaProber } from "../../element/mediaProbe";
import { createShapeElement, type ShapeKind } from "../../element/shapeElement";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit, declined } from "../commit";
import { currentDoc, onFrame, playheadMs, requireTrack } from "../context";
import { registerCommands } from "../registry";

type MediaItem = {
  path: string;
  startMs?: number;
  durationMs?: number;
  trackId?: string;
};

/**
 * Resolve a caller's path against the open asset folder.
 *
 * An agent that has just read `list_assets` has bare filenames, not absolute
 * paths, and making it join them itself is making it get separators wrong on
 * one platform.
 */
function resolvePath(input: string): string {
  const looksAbsolute = /^([a-zA-Z]:[\\/]|[\\/]|file:|https?:)/.test(input);
  if (looksAbsolute) {
    return input;
  }
  const dir = assetStore.getState().nowDirectory;
  if (!dir) {
    return input;
  }
  return `${dir.replace(/[\\/]+$/, "")}/${input}`;
}

registerCommands({
  add_media: async (params: {
    items: MediaItem[];
    startMs?: number;
    sequential?: boolean;
    /** Test seam. The DOM prober is the default. */
    prober?: MediaProber;
  }) => {
    const items = params.items ?? [];
    if (items.length === 0) {
      throw new Error("add_media needs at least one entry in `items`.");
    }

    // Probed in parallel, and settled rather than raced: one unreadable file
    // must not lose the other nine.
    const probes = await Promise.allSettled(
      items.map((item) => probeMedia(resolvePath(item.path), params.prober)),
    );

    const skipped: Array<{ path: string; reason: string }> = [];
    const ready: Array<{ item: MediaItem; probe: Awaited<ReturnType<typeof probeMedia>> }> =
      [];

    probes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        ready.push({ item: items[index], probe: outcome.value });
      } else {
        skipped.push({
          path: items[index].path,
          reason:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        });
      }
    });

    if (ready.length === 0) {
      return {
        ...declined(
          "None of those files could be read. Check the paths with list_assets.",
        ),
        skipped,
      };
    }

    const sequential = params.sequential !== false;
    const runStart = onFrame(Math.max(0, params.startMs ?? playheadMs()));
    const createdIds: string[] = [];

    const result = commit((doc) => {
      let next = doc;
      let cursor = runStart;

      for (const { item, probe } of ready) {
        const explicit = item.startMs != null ? onFrame(Math.max(0, item.startMs)) : null;
        const startTime = explicit ?? (sequential ? cursor : runStart);

        const element = buildMediaElement(probe, {
          startTime,
          durationMs: item.durationMs,
        });

        const elementId = uuidv4();
        next = placeNewElement(
          next,
          elementId,
          element,
          startTime,
          uuidv4(),
          item.trackId,
        );
        createdIds.push(elementId);

        // The next clip in a sequential run begins where this one actually
        // ended, read back from the document rather than recomputed — a still
        // takes its length from `durationMs`, a video from the file.
        const placed = next.elements[elementId];
        if (placed != null) {
          cursor = Math.max(cursor, onFrame(spanEnd(placed)));
        }
      }

      return next;
    }, "Those clips could not be placed.");

    return { ...result, skipped, sequential };
  },

  add_shape: (params: {
    kind?: ShapeKind;
    points?: number[][];
    startMs?: number;
    durationMs?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fillColor?: string;
    opacity?: number;
    rotation?: number;
    trackId?: string;
  }) => {
    if (params.points != null && params.points.length < 3) {
      throw new Error("add_shape needs at least three points to draw a polygon.");
    }

    const doc = currentDoc();
    if (params.trackId != null) {
      requireTrack(doc, params.trackId);
    }

    const startTime = onFrame(Math.max(0, params.startMs ?? playheadMs()));
    const element = createShapeElement({
      shape: params.points,
      kind: params.kind,
      startTime,
      duration: params.durationMs ?? DEFAULT_STILL_MS,
      locationX: params.x,
      locationY: params.y,
      width: params.width,
      height: params.height,
      fillColor: params.fillColor,
      opacity: params.opacity,
      rotation: params.rotation,
    });

    const elementId = uuidv4();
    return commit(
      (d: TimelineDocument) =>
        placeNewElement(d, elementId, element, startTime, uuidv4(), params.trackId),
      "The shape could not be placed.",
    );
  },
});
