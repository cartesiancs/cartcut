import { describe, expect, it } from "vitest";
import { normalizeRanges, type TimeRange } from "./clipOps";
import { videoElement } from "../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "./tracks";
import {
  clipsAcrossCuts,
  removedBefore,
  removedTotal,
  removedWithin,
  shiftPoint,
  shiftSpan,
} from "./rippleMap";

/** The cuts as a caller builds them: normalised, and therefore descending. */
function cutsOf(...ranges: TimeRange[]): TimeRange[] {
  return normalizeRanges(ranges);
}

describe("removedBefore", () => {
  const cuts = cutsOf(
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 5500 },
  );

  it("counts nothing before the first cut", () => {
    expect(removedBefore(0, cuts)).toBe(0);
    expect(removedBefore(1000, cuts)).toBe(0);
  });

  it("counts every cut that has finished", () => {
    expect(removedBefore(3000, cuts)).toBe(1000);
    expect(removedBefore(6000, cuts)).toBe(1500);
  });

  it("counts only the part of a cut the time is inside", () => {
    expect(removedBefore(1400, cuts)).toBe(400);
  });

  it("is zero for an empty cut list", () => {
    expect(removedBefore(9999, [])).toBe(0);
  });
});

describe("removedWithin", () => {
  const cuts = cutsOf(
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 5500 },
  );

  it("ignores cuts that lie outside the span", () => {
    expect(removedWithin({ startMs: 2000, endMs: 5000 }, cuts)).toBe(0);
  });

  it("counts a cut the span contains", () => {
    expect(removedWithin({ startMs: 500, endMs: 3000 }, cuts)).toBe(1000);
  });

  it("counts the overlapping part of a cut the span only reaches into", () => {
    expect(removedWithin({ startMs: 1500, endMs: 3000 }, cuts)).toBe(500);
  });

  it("counts several cuts at once", () => {
    expect(removedWithin({ startMs: 0, endMs: 10_000 }, cuts)).toBe(1500);
  });
});

describe("shiftPoint", () => {
  const cuts = cutsOf({ startMs: 1000, endMs: 2000 });

  it("leaves a time before the cut alone", () => {
    expect(shiftPoint(500, cuts)).toBe(500);
  });

  it("pulls a time after the cut back by the cut's length", () => {
    expect(shiftPoint(3000, cuts)).toBe(2000);
  });

  // The useful half of the `min(endMs, tMs)` clamp: a time in removed footage
  // has to answer *somewhere*, and where the footage resumes is the only
  // answer that stays ordered with its neighbours.
  it("lands a time inside the cut on where the footage resumes", () => {
    expect(shiftPoint(1400, cuts)).toBe(1000);
    expect(shiftPoint(1999, cuts)).toBe(1000);
  });

  it("never goes negative", () => {
    expect(shiftPoint(0, cutsOf({ startMs: 0, endMs: 500 }))).toBe(0);
  });
});

describe("shiftSpan", () => {
  const cuts = cutsOf({ startMs: 1000, endMs: 2000 });

  it("returns the span unchanged when nothing was cut", () => {
    expect(shiftSpan({ startMs: 100, endMs: 900 }, [])).toEqual({
      startMs: 100,
      endMs: 900,
    });
  });

  it("leaves a span entirely before the cut alone", () => {
    expect(shiftSpan({ startMs: 100, endMs: 900 }, cuts)).toEqual({
      startMs: 100,
      endMs: 900,
    });
  });

  it("moves a span entirely after the cut, keeping its length", () => {
    expect(shiftSpan({ startMs: 3000, endMs: 4000 }, cuts)).toEqual({
      startMs: 2000,
      endMs: 3000,
    });
  });

  // The case that makes the length its own computation: shifting both edges by
  // `removedBefore` would move the end by 1000 as well and keep the length,
  // leaving a caption on screen over footage that is gone.
  it("shortens a span the cut runs through", () => {
    expect(shiftSpan({ startMs: 500, endMs: 2500 }, cuts)).toEqual({
      startMs: 500,
      endMs: 1500,
    });
  });

  it("declines when the cut consumed the whole span", () => {
    expect(shiftSpan({ startMs: 1200, endMs: 1800 }, cuts)).toBeNull();
  });

  it("declines when the span exactly matches a cut", () => {
    expect(shiftSpan({ startMs: 1000, endMs: 2000 }, cuts)).toBeNull();
  });

  it("carries a span across several cuts", () => {
    const many = cutsOf(
      { startMs: 1000, endMs: 2000 },
      { startMs: 4000, endMs: 4500 },
    );
    // 3000ms long, 1000 of it removed by the second cut only, and 1000 removed
    // before it by the first.
    expect(shiftSpan({ startMs: 3000, endMs: 6000 }, many)).toEqual({
      startMs: 2000,
      endMs: 4500,
    });
  });
});

describe("removedTotal", () => {
  it("adds the cuts up", () => {
    expect(
      removedTotal(
        cutsOf({ startMs: 1000, endMs: 2000 }, { startMs: 5000, endMs: 5500 }),
      ),
    ).toBe(1500);
  });

  it("is zero for no cuts", () => {
    expect(removedTotal([])).toBe(0);
  });

  // `normalizeRanges` merges touching ranges, so two silences that meet cost
  // their combined length once rather than twice.
  it("counts merged ranges once", () => {
    expect(
      removedTotal(
        cutsOf({ startMs: 1000, endMs: 2000 }, { startMs: 2000, endMs: 3000 }),
      ),
    ).toBe(2000);
  });
});

describe("clipsAcrossCuts", () => {
  /** A picture track being cut, a music bed, and a caption from an earlier pass. */
  const doc = () =>
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [
        createTrack("t1", "text", 0),
        createTrack("v1", "video", 1),
        createTrack("a1", "audio", 2),
      ],
      elements: {
        picture: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 10_000,
          trim: { startTime: 0, endTime: 10_000 },
          sourceDuration: 10_000,
        }),
        music: videoElement({
          trackId: "a1",
          startTime: 0,
          duration: 10_000,
          trim: { startTime: 0, endTime: 10_000 },
          sourceDuration: 10_000,
        }),
        oldCaption: videoElement({
          trackId: "t1",
          startTime: 4000,
          duration: 500,
          trim: { startTime: 0, endTime: 500 },
          sourceDuration: 500,
        }),
      },
    });

  it("names a clip on another track that the cut runs through", () => {
    const stranded = clipsAcrossCuts(doc(), "v1", cutsOf({ startMs: 4000, endMs: 4400 }));
    expect(stranded.sort()).toEqual(["music", "oldCaption"]);
  });

  // The commonest case, and the one an implementation that skipped text tracks
  // would leave silent.
  it("includes text tracks", () => {
    expect(
      clipsAcrossCuts(doc(), "v1", cutsOf({ startMs: 4100, endMs: 4200 })),
    ).toContain("oldCaption");
  });

  it("never names a clip on the track being cut", () => {
    expect(
      clipsAcrossCuts(doc(), "v1", cutsOf({ startMs: 0, endMs: 9000 })),
    ).not.toContain("picture");
  });

  it("says nothing when the cuts miss everything else", () => {
    const empty = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        picture: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 10_000,
          trim: { startTime: 0, endTime: 10_000 },
          sourceDuration: 10_000,
        }),
      },
    });
    expect(clipsAcrossCuts(empty, "v1", cutsOf({ startMs: 1000, endMs: 2000 }))).toEqual([]);
  });

  it("says nothing for a clip that only touches a cut's edge", () => {
    // Half-open, the convention the whole timeline uses.
    expect(
      clipsAcrossCuts(doc(), "v1", cutsOf({ startMs: 4500, endMs: 5000 })),
    ).not.toContain("oldCaption");
  });

  it("says nothing with no cuts", () => {
    expect(clipsAcrossCuts(doc(), "v1", [])).toEqual([]);
  });
});
