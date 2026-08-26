/**
 * Where a drop lands. This arithmetic sat inline in the canvas's drop handler
 * with no coverage at all, which is how the same class of bug — drawing and
 * hit-testing computing a position two different ways — got into `layout.ts`
 * in the first place.
 */

import { describe, it, expect } from "vitest";
import { dropTargetAt } from "./dropTarget";
import {
  RULER_OFFSET,
  TRACK_GAP,
  TRACK_HEIGHT,
  TRACK_PITCH,
  layoutTimeline,
  xAtTime,
  type LayoutInput,
} from "../timeline/layout";
import { frameToMs, msToFrame } from "../timeline/frames";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";

const RANGE = 0.9; // 45px per second
const FPS = 30;

function doc(
  tracks: Array<[string, "video" | "audio" | "text"]>,
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind], index) => createTrack(id, kind, index)),
    elements: {},
  });
}

function layout(d: TimelineDocument, over: Partial<LayoutInput> = {}) {
  return layoutTimeline({
    doc: d,
    range: RANGE,
    hScroll: 0,
    vScroll: 0,
    viewportW: 1000,
    viewportH: 500,
    ...over,
  });
}

const THREE_TRACKS = doc([
  ["v1", "video"],
  ["v2", "video"],
  ["a1", "audio"],
]);

/** Vertical middle of row `index`, with the ruler gutter accounted for. */
function midRow(index: number): number {
  return RULER_OFFSET + index * TRACK_PITCH + TRACK_HEIGHT / 2;
}

describe("dropTargetAt", () => {
  describe("the moment", () => {
    it("reads x back as the time drawn there", () => {
      // Round trip against the function the canvas draws with, so a drop lands
      // under the pointer rather than near it.
      const x = xAtTime(4000, RANGE, 0);
      const target = dropTargetAt(layout(THREE_TRACKS), x, midRow(0), RANGE, 0, FPS);

      expect(target.startMs).toBeCloseTo(4000, 0);
    });

    it("accounts for horizontal scroll", () => {
      const scrolled = dropTargetAt(
        layout(THREE_TRACKS, { hScroll: 450 }),
        0,
        midRow(0),
        RANGE,
        450,
        FPS,
      );

      // 450px at 45px/s is ten seconds of scroll.
      expect(scrolled.startMs).toBeCloseTo(10000, 0);
    });

    it("accounts for zoom", () => {
      const zoomed = 3.6; // four times in
      const x = xAtTime(4000, zoomed, 0);
      const target = dropTargetAt(
        layout(THREE_TRACKS, { range: zoomed }),
        x,
        midRow(0),
        zoomed,
        0,
        FPS,
      );

      expect(target.startMs).toBeCloseTo(4000, 0);
    });

    it("lands on a frame boundary", () => {
      const target = dropTargetAt(
        layout(THREE_TRACKS),
        137,
        midRow(0),
        RANGE,
        0,
        FPS,
      );

      // An unsnapped drop leaves a sub-frame sliver that only shows on export.
      expect(target.startMs).toBe(frameToMs(msToFrame(target.startMs, FPS), FPS));
    });

    it("snaps to the fps it is given, not a fixed one", () => {
      const at24 = dropTargetAt(layout(THREE_TRACKS), 137, midRow(0), RANGE, 0, 24);

      expect(at24.startMs).toBe(frameToMs(msToFrame(at24.startMs, 24), 24));
    });

    it("clamps a drop left of zero to zero", () => {
      const target = dropTargetAt(
        layout(THREE_TRACKS),
        -200,
        midRow(0),
        RANGE,
        0,
        FPS,
      );

      expect(target.startMs).toBe(0);
    });

    it("clamps before snapping, so a near-zero drop does not round negative", () => {
      // The ordering that matters: `snapMsToFrame` rounds, so snapping first
      // would turn a drop a pixel left of the origin into a negative frame.
      for (const x of [-1, -0.5, -8, 0, 1]) {
        const target = dropTargetAt(layout(THREE_TRACKS), x, midRow(0), RANGE, 0, FPS);
        expect(target.startMs).toBeGreaterThanOrEqual(0);
        expect(Object.is(target.startMs, -0)).toBe(false);
      }
    });
  });

  describe("the row", () => {
    it("names the track under the pointer", () => {
      const l = layout(THREE_TRACKS);

      expect(dropTargetAt(l, 100, midRow(0), RANGE, 0, FPS).trackId).toBe("v1");
      expect(dropTargetAt(l, 100, midRow(1), RANGE, 0, FPS).trackId).toBe("v2");
      expect(dropTargetAt(l, 100, midRow(2), RANGE, 0, FPS).trackId).toBe("a1");
    });

    it("claims a row from its top edge", () => {
      const top = RULER_OFFSET + TRACK_PITCH;
      const l = layout(THREE_TRACKS);

      expect(dropTargetAt(l, 100, top, RANGE, 0, FPS).trackId).toBe("v2");
      expect(dropTargetAt(l, 100, top - 1, RANGE, 0, FPS).trackId).not.toBe("v2");
    });

    it("releases it before the next one starts", () => {
      const bottom = RULER_OFFSET + TRACK_PITCH + TRACK_HEIGHT;
      const l = layout(THREE_TRACKS);

      expect(dropTargetAt(l, 100, bottom - 1, RANGE, 0, FPS).trackId).toBe("v2");
      expect(dropTargetAt(l, 100, bottom, RANGE, 0, FPS).trackId).toBe(null);
    });

    it("has no row in the gap between two", () => {
      // `TRACK_GAP` is real space, and a drop there should fall through to the
      // automatic track chooser rather than silently picking a neighbour.
      const gap = RULER_OFFSET + TRACK_HEIGHT + TRACK_GAP / 2;

      expect(dropTargetAt(layout(THREE_TRACKS), 100, gap, RANGE, 0, FPS).trackId).toBe(
        null,
      );
    });

    it("has no row in the ruler gutter", () => {
      // The ruler overlaps the top of the canvas; a drop up there aimed at no
      // track in particular.
      const l = layout(THREE_TRACKS);

      expect(dropTargetAt(l, 100, 0, RANGE, 0, FPS).trackId).toBe(null);
      expect(dropTargetAt(l, 100, RULER_OFFSET - 1, RANGE, 0, FPS).trackId).toBe(null);
      expect(dropTargetAt(l, 100, RULER_OFFSET, RANGE, 0, FPS).trackId).toBe("v1");
    });

    it("has no row below the last one", () => {
      const belowAll = RULER_OFFSET + 3 * TRACK_PITCH + 50;

      expect(
        dropTargetAt(layout(THREE_TRACKS), 100, belowAll, RANGE, 0, FPS).trackId,
      ).toBe(null);
    });

    it("has no row at all on an empty timeline", () => {
      const target = dropTargetAt(layout(doc([])), 100, 100, RANGE, 0, FPS);

      expect(target.trackId).toBe(null);
      expect(target.startMs).toBeGreaterThan(0);
    });

    it("accounts for vertical scroll", () => {
      // Scrolled down by one row, the second track sits where the first was.
      const l = layout(THREE_TRACKS, { vScroll: TRACK_PITCH });

      expect(dropTargetAt(l, 100, midRow(0), RANGE, 0, FPS).trackId).toBe("v2");
    });
  });

  it("decides the row and the moment independently", () => {
    // A drop in the ruler gutter still has a usable time — the caller places it
    // at that moment on an automatically chosen track.
    const target = dropTargetAt(
      layout(THREE_TRACKS),
      xAtTime(6000, RANGE, 0),
      0,
      RANGE,
      0,
      FPS,
    );

    expect(target.trackId).toBe(null);
    expect(target.startMs).toBeCloseTo(6000, 0);
  });
});
