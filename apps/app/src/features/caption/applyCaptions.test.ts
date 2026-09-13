import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import { normalizeRanges, type TimeRange } from "../timeline/clipOps";
import { spanOf } from "../timeline/geometry";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { applyCaptionCommit, type CaptionCommit } from "./applyCaptions";
import { captionRows } from "./rows";
import {
  linesFromWordGroups,
  removeLine,
  removedSpans,
  type CaptionLine,
} from "./lines";
import { planCuts } from "./cuts";

/** A 10s clip, source 0..10000, sitting at timeline 0. */
function doc(over: Record<string, unknown> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      clip: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 10_000,
        trim: { startTime: 0, endTime: 10_000 },
        sourceDuration: 10_000,
        ...over,
      }),
    },
  });
}

/** Three lines a second long, at 1s, 4s and 7s. */
const lines = (): CaptionLine[] =>
  linesFromWordGroups([
    [{ word: "one", start: 1, end: 2 }],
    [{ word: "two", start: 4, end: 5 }],
    [{ word: "three", start: 7, end: 8 }],
  ]);

const rowsOf = (ls: CaptionLine[]) =>
  captionRows(ls, "clip", { w: 1920, h: 1080 });

/** Deterministic ids, so two runs of the same plan are comparable. */
function ids(rowCount: number, cutCount: number): CaptionCommit["ids"] {
  return {
    captions: Array.from({ length: rowCount }, (_, i) => ({
      element: `cap${i}`,
      track: `capTrack${i}`,
    })),
    splits: Array.from({ length: cutCount * 2 }, (_, i) => `split${i}`),
  };
}

function commit(
  base: TimelineDocument,
  ls: CaptionLine[],
  cuts: TimeRange[],
): TimelineDocument {
  const rows = rowsOf(ls);
  return applyCaptionCommit(base, {
    sourceKey: "clip",
    cuts,
    rows,
    ids: ids(rows.length, cuts.length),
  });
}

/** Every text clip placed, ordered in time. */
function captions(d: TimelineDocument) {
  return Object.values(d.elements)
    .filter((el) => el.filetype === "text")
    .sort((a, b) => a.startTime - b.startTime)
    .map((el) => ({
      text: (el as { text: string }).text,
      startTime: el.startTime,
      duration: el.duration,
    }));
}

describe("applyCaptionCommit", () => {
  it("declines by identity when there is nothing to do", () => {
    const base = doc();
    expect(
      applyCaptionCommit(base, {
        sourceKey: "clip",
        cuts: [],
        rows: [],
        ids: ids(0, 0),
      }),
    ).toBe(base);
  });

  it("places every caption when nothing was cut", () => {
    const after = commit(doc(), lines(), []);
    expect(captions(after)).toEqual([
      { text: "one", startTime: 1000, duration: 1000 },
      { text: "two", startTime: 4000, duration: 1000 },
      { text: "three", startTime: 7000, duration: 1000 },
    ]);
  });

  it("puts them all on one text track", () => {
    const after = commit(doc(), lines(), []);
    const trackIds = new Set(
      Object.values(after.elements)
        .filter((el) => el.filetype === "text")
        .map((el) => el.trackId),
    );
    expect(trackIds.size).toBe(1);
  });

  // The whole feature in one assertion: the struck-out line's footage is gone
  // and the caption that followed it has moved up by exactly that much.
  it("cuts a struck-out line's range and pulls the later caption back", () => {
    const edited = removeLine(lines(), 1);
    const plan = planCuts(removedSpans(edited), doc().elements.clip);
    const after = commit(doc(), edited, plan.cuts);

    expect(captions(after)).toEqual([
      { text: "one", startTime: 1000, duration: 1000 },
      { text: "three", startTime: 6000, duration: 1000 },
    ]);
    expect(spanOf(after.elements.clip).end).toBeLessThan(10_000);
  });

  it("does not place a caption whose footage was cut away", () => {
    const cuts = normalizeRanges([{ startMs: 3500, endMs: 5500 }]);
    const after = commit(doc(), lines(), cuts);
    expect(captions(after).map((c) => c.text)).toEqual(["one", "three"]);
  });

  it("shortens a caption the cut runs through", () => {
    const cuts = normalizeRanges([{ startMs: 4500, endMs: 5000 }]);
    const after = commit(doc(), lines(), cuts);
    const two = captions(after).find((c) => c.text === "two");
    expect(two).toEqual({ text: "two", startTime: 4000, duration: 500 });
  });

  // The case the "resolve before cutting" rule exists for: a cut flush to the
  // left edge deletes the original id, so anything reading `doc.elements.clip`
  // afterwards gets undefined and maps every caption as though the clip were
  // untrimmed and at zero.
  it("is still correct when the cut removes the original clip id", () => {
    const cuts = normalizeRanges([{ startMs: 0, endMs: 3000 }]);
    const after = commit(doc(), lines(), cuts);

    expect(after.elements.clip).toBeUndefined();
    expect(captions(after)).toEqual([
      { text: "two", startTime: 1000, duration: 1000 },
      { text: "three", startTime: 4000, duration: 1000 },
    ]);
  });

  it("maps through a trim offset and a speed change", () => {
    const base = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        clip: videoElement({
          trackId: "v1",
          startTime: 1000,
          duration: 8000,
          trim: { startTime: 1000, endTime: 9000 },
          sourceDuration: 10_000,
          speed: 2,
        }),
      },
    });

    // Source 4000 is 3000 into the trim, so 1500 of timeline after the clip's
    // own start at 1000.
    const after = commit(base, lines(), []);
    const two = captions(after).find((c) => c.text === "two");
    expect(two).toEqual({ text: "two", startTime: 2500, duration: 500 });
  });

  // `commit` probes the transform before running it for real. Two runs that
  // minted different ids is the bug `plan.ts` had.
  it("produces identical documents when run twice with the same plan", () => {
    const edited = removeLine(lines(), 1);
    const plan = planCuts(removedSpans(edited), doc().elements.clip);
    const rows = rowsOf(edited);
    const shared = ids(rows.length, plan.cuts.length);

    const first = applyCaptionCommit(doc(), {
      sourceKey: "clip",
      cuts: plan.cuts,
      rows,
      ids: shared,
    });
    const second = applyCaptionCommit(doc(), {
      sourceKey: "clip",
      cuts: plan.cuts,
      rows,
      ids: shared,
    });

    expect(Object.keys(second.elements).sort()).toEqual(
      Object.keys(first.elements).sort(),
    );
    expect(second.elements).toEqual(first.elements);
  });

  it("throws rather than minting a fresh id when the split pool runs dry", () => {
    const rows = rowsOf(lines());
    expect(() =>
      applyCaptionCommit(doc(), {
        sourceKey: "clip",
        cuts: normalizeRanges([{ startMs: 3000, endMs: 4000 }]),
        rows,
        ids: { captions: ids(rows.length, 0).captions, splits: [] },
      }),
    ).toThrow(/split ids/);
  });

  it("places captions with no clip to map against", () => {
    const rows = rowsOf(lines()).map((row) => ({ ...row, sourceKey: null }));
    const after = applyCaptionCommit(doc(), {
      sourceKey: null,
      cuts: [],
      rows,
      ids: ids(rows.length, 0),
    });
    expect(captions(after)).toHaveLength(3);
  });

  it("leaves the video track holding only pieces of the one clip", () => {
    const edited = removeLine(lines(), 1);
    const plan = planCuts(removedSpans(edited), doc().elements.clip);
    const after = commit(doc(), edited, plan.cuts);
    expect(clipsOnTrack(after, "v1")).toHaveLength(2);
  });
});
