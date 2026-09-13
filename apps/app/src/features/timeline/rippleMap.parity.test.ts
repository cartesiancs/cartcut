/**
 * `rippleMap` against the real `removeRanges`.
 *
 * The module claims that where a time ends up after a rippled cut can be
 * computed from the cut list alone, without looking at the document. That is a
 * claim about `removeRanges`, `splitClip` and `rippleDelete`, not about
 * arithmetic, so asserting it against hand-written expectations would only
 * restate the implementation. Here the edit is actually performed and the
 * prediction is checked against where the footage measurably landed.
 *
 * The oracle is the post-cut document read the slow way: find the surviving
 * piece whose `trim` window contains a source time, then ask `timelineTimeAt`.
 * That is exactly the search the arithmetic exists to avoid, which is what
 * makes it a fair check.
 */

import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import {
  normalizeRanges,
  removeRanges,
  type TimeRange,
} from "./clipOps";
import {
  isDynamicElement,
  spanOf,
  timelineTimeAt,
} from "./geometry";
import { shiftPoint, shiftSpan } from "./rippleMap";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

const SOURCE_START = 2000;
const SOURCE_END = 12_000;

/** The clip under test, plus a neighbour on its track and one on a text track. */
function build(speed: number): { doc: TimelineDocument; ids: string[] } {
  const duration = SOURCE_END - SOURCE_START;
  const cut = videoElement({
    trackId: "v1",
    startTime: 5000,
    duration,
    trim: { startTime: SOURCE_START, endTime: SOURCE_END },
    sourceDuration: 20_000,
    speed,
  });

  const later = videoElement({
    trackId: "v1",
    startTime: 5000 + duration / speed + 3000,
    duration: 1000,
    trim: { startTime: 0, endTime: 1000 },
    sourceDuration: 1000,
  });

  return {
    doc: normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("t1", "text", 0), createTrack("v1", "video", 1)],
      elements: { cut, later },
    }),
    ids: ["cut", "later"],
  };
}

/** An id generator whose output is recorded, so the pieces can be found after. */
function pool(): { next: () => string; minted: string[] } {
  const minted: string[] = [];
  let n = 0;
  return {
    next: () => {
      const id = `piece${n++}`;
      minted.push(id);
      return id;
    },
    minted,
  };
}

/**
 * Where `sourceMs` actually ended up, read off the document.
 *
 * `null` when no surviving piece covers it, which is the document's way of
 * saying that footage was removed.
 */
function actualTimelineTimeOf(
  doc: TimelineDocument,
  pieceIds: string[],
  sourceMs: number,
): number | null {
  for (const id of pieceIds) {
    const piece = doc.elements[id];
    if (piece == null || !isDynamicElement(piece)) {
      continue;
    }
    if (sourceMs >= piece.trim.startTime && sourceMs < piece.trim.endTime) {
      return timelineTimeAt(piece, sourceMs);
    }
  }
  return null;
}

const CASES: Array<{ name: string; ranges: TimeRange[] }> = [
  { name: "one cut through the middle", ranges: [{ startMs: 8000, endMs: 9000 }] },
  {
    name: "two disjoint cuts",
    ranges: [
      { startMs: 6500, endMs: 7000 },
      { startMs: 10_000, endMs: 11_500 },
    ],
  },
  { name: "a cut flush to the left edge", ranges: [{ startMs: 5000, endMs: 6000 }] },
  {
    name: "two touching cuts, which normalizeRanges merges",
    ranges: [
      { startMs: 7000, endMs: 8000 },
      { startMs: 8000, endMs: 9000 },
    ],
  },
  {
    name: "three cuts, applied together",
    ranges: [
      { startMs: 6000, endMs: 6500 },
      { startMs: 8000, endMs: 8400 },
      { startMs: 11_000, endMs: 12_000 },
    ],
  },
];

describe("rippleMap against removeRanges", () => {
  for (const speed of [1, 2, 0.5]) {
    describe(`at speed ${speed}`, () => {
      const flush = () => {
        const { doc } = build(speed);
        const span = spanOf(doc.elements.cut);
        return [{ startMs: span.end - 1000, endMs: span.end }];
      };

      const cases = [
        ...CASES,
        { name: "a cut flush to the right edge", ranges: flush() },
      ];

      for (const testCase of cases) {
        it(`predicts every surviving instant: ${testCase.name}`, () => {
          const { doc } = build(speed);
          const original = doc.elements.cut;
          const span = spanOf(original);
          const cuts = normalizeRanges(testCase.ranges);

          const ids = pool();
          const after = removeRanges(doc, "cut", cuts, true, ids.next);
          expect(after).not.toBe(doc);

          const pieceIds = ["cut", ...ids.minted];

          // Probe the source window densely. Each probe is a moment of speech a
          // caption could sit on.
          for (let sourceMs = SOURCE_START; sourceMs < SOURCE_END; sourceMs += 97) {
            const before = timelineTimeAt(original, sourceMs);
            const actual = actualTimelineTimeOf(after, pieceIds, sourceMs);
            const predicted = shiftPoint(before, cuts);

            if (actual == null) {
              // The document says this footage is gone, so the prediction must
              // land inside a cut rather than on surviving picture.
              const inACut = cuts.some(
                (c) => before >= c.startMs - 1e-6 && before < c.endMs,
              );
              expect(inACut, `source ${sourceMs} vanished but sits in no cut`).toBe(
                true,
              );
              continue;
            }

            expect(
              Math.abs(actual - predicted),
              `source ${sourceMs}: document says ${actual}, map says ${predicted}`,
            ).toBeLessThan(0.51);
          }
        });
      }

      it("predicts where the neighbour on the same track landed", () => {
        const { doc } = build(speed);
        const cuts = normalizeRanges([{ startMs: 8000, endMs: 9000 }]);
        const beforeStart = doc.elements.later.startTime;

        const ids = pool();
        const after = removeRanges(doc, "cut", cuts, true, ids.next);

        // A lane-local ripple pulls it back by the whole cut, and the map says
        // the same thing without knowing the clip exists.
        expect(after.elements.later.startTime).toBeCloseTo(
          shiftPoint(beforeStart, cuts),
          6,
        );
      });
    });
  }

  it("leaves a clip on another track exactly where it was", () => {
    const { doc } = build(1);
    const withText = normalizeDocument({
      ...doc,
      elements: {
        ...doc.elements,
        caption: videoElement({
          trackId: "t1",
          startTime: 8500,
          duration: 500,
          trim: { startTime: 0, endTime: 500 },
          sourceDuration: 500,
        }),
      },
    });

    const after = removeRanges(
      withText,
      "cut",
      normalizeRanges([{ startMs: 8000, endMs: 9000 }]),
      true,
      pool().next,
    );

    // The decision the feature rests on, stated as a test: the ripple is
    // lane-local, so anything already sitting on another row goes out of sync
    // and nothing repairs it. That is what the panel has to warn about.
    expect(after.elements.caption.startTime).toBe(8500);
  });

  it("removes the clip entirely when the cuts cover all of it", () => {
    const { doc } = build(1);
    const span = spanOf(doc.elements.cut);
    const ids = pool();
    const after = removeRanges(
      doc,
      "cut",
      normalizeRanges([{ startMs: span.start, endMs: span.end }]),
      true,
      ids.next,
    );

    for (const id of ["cut", ...ids.minted]) {
      expect(after.elements[id]).toBeUndefined();
    }
  });

  it("agrees with the document about a span's length, not just its start", () => {
    const { doc } = build(1);
    const original = doc.elements.cut;
    const cuts = normalizeRanges([{ startMs: 8000, endMs: 9000 }]);
    const ids = pool();
    const after = removeRanges(doc, "cut", cuts, true, ids.next);
    const pieceIds = ["cut", ...ids.minted];

    // A caption running 7500..9500 straddles the cut. What survives is
    // 7500..8000 and 9000..9500, which is 1000ms of picture.
    const shifted = shiftSpan({ startMs: 7500, endMs: 9500 }, cuts);
    expect(shifted).not.toBeNull();
    expect(shifted!.endMs - shifted!.startMs).toBe(1000);

    // And its start is where the document put that instant.
    const sourceAt7500 = SOURCE_START + (7500 - original.startTime);
    expect(actualTimelineTimeOf(after, pieceIds, sourceAt7500)).toBeCloseTo(
      shifted!.startMs,
      6,
    );
  });
});
