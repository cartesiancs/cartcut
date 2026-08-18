import { describe, it, expect } from "vitest";
import {
  findCollisions,
  firstFreeStart,
  fitInto,
  freeGaps,
  occupiedIntervals,
  overlaps,
} from "./overlap";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, videoElement } from "../renderer/testing";

/** One video track "t0" holding the given `[start, length]` clips. */
function track(...clips: Array<[string, number, number]>): TimelineDocument {
  const elements: Record<string, any> = {};
  for (const [id, startTime, duration] of clips) {
    elements[id] = imageElement({ trackId: "t0", startTime, duration });
  }
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t0", "video", 0)],
    elements,
  });
}

describe("overlaps", () => {
  it("is true when the intervals share any instant", () => {
    expect(overlaps({ start: 0, end: 100 }, { start: 50, end: 150 })).toBe(true);
    expect(overlaps({ start: 50, end: 150 }, { start: 0, end: 100 })).toBe(true);
  });

  it("lets back-to-back intervals meet without colliding", () => {
    // Half-open, matching isTimeInRange — this is what makes the two halves of
    // a split sit flush on one track instead of fighting for the same pixel.
    expect(overlaps({ start: 0, end: 100 }, { start: 100, end: 200 })).toBe(
      false,
    );
  });

  it("treats a zero-length interval as occupying nothing", () => {
    expect(overlaps({ start: 50, end: 50 }, { start: 0, end: 100 })).toBe(false);
  });

  it("is true when one interval contains the other", () => {
    expect(overlaps({ start: 0, end: 100 }, { start: 25, end: 75 })).toBe(true);
  });
});

describe("occupiedIntervals", () => {
  it("returns the track's clips in time order", () => {
    const doc = track(["b", 3000, 1000], ["a", 0, 1000]);
    expect(occupiedIntervals(doc, "t0")).toEqual([
      { start: 0, end: 1000 },
      { start: 3000, end: 4000 },
    ]);
  });

  it("omits excluded ids, so a dragged clip does not block itself", () => {
    const doc = track(["a", 0, 1000]);
    expect(occupiedIntervals(doc, "t0", ["a"])).toEqual([]);
  });

  it("measures a sped-up clip by its timeline span, not its source length", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("t0", "video", 0)],
      elements: {
        fast: videoElement({
          trackId: "t0",
          startTime: 0,
          duration: 4000,
          speed: 2,
          trim: { startTime: 0, endTime: 4000 },
          sourceDuration: 4000,
        }),
      },
    });
    expect(occupiedIntervals(doc, "t0")).toEqual([{ start: 0, end: 2000 }]);
  });

  it("ignores other tracks", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("t0", "video", 0), createTrack("t1", "video", 1)],
      elements: {
        here: imageElement({ trackId: "t0", startTime: 0, duration: 1000 }),
        elsewhere: imageElement({ trackId: "t1", startTime: 0, duration: 1000 }),
      },
    });
    expect(occupiedIntervals(doc, "t0")).toHaveLength(1);
  });
});

describe("findCollisions", () => {
  it("names what a span would land on", () => {
    const doc = track(["a", 0, 1000], ["b", 2000, 1000]);
    expect(findCollisions(doc, "t0", { start: 500, end: 2500 })).toEqual([
      "a",
      "b",
    ]);
  });

  it("finds nothing in a gap", () => {
    const doc = track(["a", 0, 1000], ["b", 2000, 1000]);
    expect(findCollisions(doc, "t0", { start: 1000, end: 2000 })).toEqual([]);
  });

  it("finds nothing on an empty track", () => {
    expect(findCollisions(track(), "t0", { start: 0, end: 5000 })).toEqual([]);
  });
});

describe("freeGaps", () => {
  it("gives an empty track one unbounded gap", () => {
    expect(freeGaps(track(), "t0")).toEqual([{ start: 0, end: Infinity }]);
  });

  it("reports the space before, between and after clips", () => {
    const doc = track(["a", 1000, 1000], ["b", 4000, 1000]);
    expect(freeGaps(doc, "t0")).toEqual([
      { start: 0, end: 1000 },
      { start: 2000, end: 4000 },
      { start: 5000, end: Infinity },
    ]);
  });

  it("reports no gap between clips that are flush", () => {
    const doc = track(["a", 0, 1000], ["b", 1000, 1000]);
    expect(freeGaps(doc, "t0")).toEqual([{ start: 2000, end: Infinity }]);
  });

  it("does not invent a gap inside an overlap that slipped through", () => {
    // Not supposed to happen, but the arithmetic must not go backwards if it
    // does — a negative-width gap would offer a bogus drop target.
    const doc = track(["a", 0, 3000], ["b", 1000, 3000]);
    for (const gap of freeGaps(doc, "t0")) {
      expect(gap.end).toBeGreaterThan(gap.start);
    }
  });
});

describe("firstFreeStart", () => {
  it("returns the requested time when the track is free there", () => {
    expect(firstFreeStart(track(), "t0", 5000, 1000)).toBe(5000);
  });

  it("slides past a clip that is in the way", () => {
    // This is what makes "add at the playhead" behave when the playhead sits
    // on top of something.
    const doc = track(["a", 4000, 2000]);
    expect(firstFreeStart(doc, "t0", 5000, 1000)).toBe(6000);
  });

  it("uses a gap large enough and skips one that is not", () => {
    const doc = track(["a", 0, 1000], ["b", 1500, 1000]);
    // The 500ms gap cannot hold 800ms, so it lands after "b".
    expect(firstFreeStart(doc, "t0", 0, 800)).toBe(2500);
    // ...but a 400ms clip fits in it.
    expect(firstFreeStart(doc, "t0", 0, 400)).toBe(1000);
  });

  it("never returns a time before the one asked for", () => {
    const doc = track(["a", 0, 1000]);
    expect(firstFreeStart(doc, "t0", 3000, 1000)).toBe(3000);
  });

  it("ignores the clip being moved", () => {
    const doc = track(["a", 0, 1000]);
    expect(firstFreeStart(doc, "t0", 0, 1000, ["a"])).toBe(0);
  });
});

describe("fitInto", () => {
  it("leaves a drop that already fits exactly where it was aimed", () => {
    expect(fitInto(track(["a", 0, 1000]), "t0", 5000, 1000)).toBe(5000);
  });

  it("snaps flush to a neighbour when the drop just overlaps it", () => {
    const doc = track(["a", 0, 1000]);
    // Aimed 30ms into "a"; with 200ms of tolerance it butts up against its end.
    expect(fitInto(doc, "t0", 970, 1000, [], 200)).toBe(1000);
  });

  it("refuses a drop deep inside a long clip", () => {
    // Reverting beats overwriting: a mis-aimed drag must not eat footage.
    const doc = track(["a", 0, 20_000]);
    expect(fitInto(doc, "t0", 9000, 1000, [], 200)).toBeNull();
  });

  it("refuses when the nearest opening is beyond the tolerance", () => {
    const doc = track(["a", 0, 5000]);
    expect(fitInto(doc, "t0", 2000, 1000, [], 100)).toBeNull();
  });

  it("prefers the closer edge of the two around a gap", () => {
    const doc = track(["a", 0, 1000], ["b", 5000, 1000]);
    // A 1000ms clip aimed at 3800 fits at 3800 already — no snap needed.
    expect(fitInto(doc, "t0", 3800, 1000, [], 500)).toBe(3800);

    // Aimed at 4700 the clip would run to 5700 and eat 700ms of "b". The
    // nearest legal start is 4000, flush against it — a 700ms correction, so
    // it needs at least that much tolerance to be offered at all.
    expect(fitInto(doc, "t0", 4700, 1000, [], 800)).toBe(4000);
    expect(fitInto(doc, "t0", 4700, 1000, [], 500)).toBeNull();
  });

  it("skips a gap too small to hold the clip", () => {
    const doc = track(["a", 0, 1000], ["b", 1200, 1000]);
    // The 200ms gap cannot take 1000ms, so it goes after "b" if within reach.
    expect(fitInto(doc, "t0", 1100, 1000, [], 1500)).toBe(2200);
  });

  it("ignores the clip being dragged, so it can be nudged in place", () => {
    const doc = track(["a", 1000, 1000]);
    expect(fitInto(doc, "t0", 1100, 1000, ["a"])).toBe(1100);
  });

  it("returns null rather than a negative start", () => {
    const doc = track(["a", 0, 20_000]);
    const result = fitInto(doc, "t0", -500, 1000, [], 100);
    expect(result === null || result >= 0).toBe(true);
  });
});
