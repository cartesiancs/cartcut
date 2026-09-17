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
function ids(rowCount: number): CaptionCommit["ids"] {
  return {
    captions: Array.from({ length: rowCount }, (_, i) => ({
      element: `cap${i}`,
      track: `capTrack${i}`,
    })),
  };
}

/** Two split ids per cut, named after the clip. */
function splits(key: string, cutCount: number): string[] {
  return Array.from({ length: cutCount * 2 }, (_, i) => `${key}-split${i}`);
}

/** The one clip every case below started from. */
function oneClip(cuts: TimeRange[]): CaptionCommit["clips"] {
  return [{ key: "clip", cuts, splits: splits("clip", cuts.length) }];
}

function commit(
  base: TimelineDocument,
  ls: CaptionLine[],
  cuts: TimeRange[],
): TimelineDocument {
  const rows = rowsOf(ls);
  return applyCaptionCommit(base, {
    clips: oneClip(cuts),
    rows,
    ids: ids(rows.length),
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
        clips: oneClip([]),
        rows: [],
        ids: ids(0),
      }),
    ).toBe(base);
    expect(applyCaptionCommit(base, { clips: [], rows: [], ids: ids(0) })).toBe(
      base,
    );
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
    const shared = ids(rows.length);

    const first = applyCaptionCommit(doc(), {
      clips: oneClip(plan.cuts),
      rows,
      ids: shared,
    });
    const second = applyCaptionCommit(doc(), {
      clips: oneClip(plan.cuts),
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
        clips: [
          {
            key: "clip",
            cuts: normalizeRanges([{ startMs: 3000, endMs: 4000 }]),
            splits: [],
          },
        ],
        rows,
        ids: ids(rows.length),
      }),
    ).toThrow(/split ids/);
  });

  it("places captions with no clip to map against", () => {
    const rows = rowsOf(lines()).map((row) => ({ ...row, sourceKey: null }));
    const after = applyCaptionCommit(doc(), {
      clips: [],
      rows,
      ids: ids(rows.length),
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

describe("applyCaptionCommit over several clips", () => {
  /** X at 0-10s and Y at 10-20s on v1, and Z at 5-15s on v2. */
  function scene(): TimelineDocument {
    const clip = (trackId: string, localpath: string, startTime: number) =>
      videoElement({
        trackId,
        localpath,
        startTime,
        duration: 10_000,
        trim: { startTime: 0, endTime: 10_000 },
        sourceDuration: 10_000,
      });
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
      elements: {
        x: clip("v1", "file:///x.mov", 0),
        y: clip("v1", "file:///y.mov", 10_000),
        z: clip("v2", "file:///z.mov", 5_000),
      },
    });
  }

  const pieces = (d: TimelineDocument, trackId: string) =>
    clipsOnTrack(d, trackId).map(([, el]) => ({
      file: (el as any).localpath,
      start: Math.round(spanOf(el).start),
      end: Math.round(spanOf(el).end),
      from: Math.round((el as any).trim.startTime),
    }));

  const cutsFor = (base: TimelineDocument, key: string, ranges: TimeRange[]) =>
    planCuts(ranges, base.elements[key]).cuts;

  const tagged = (key: string, word: string, start: number) =>
    linesFromWordGroups([[{ word, start, end: start + 1 }]]).map((line) => ({
      ...line,
      sourceKey: key,
    }));

  it("cuts both clips on one track, the later one first, and moves each caption by its own track", () => {
    const base = scene();
    const xCuts = cutsFor(base, "x", [{ startMs: 2_000, endMs: 3_000 }]);
    const yCuts = cutsFor(base, "y", [{ startMs: 1_000, endMs: 2_000 }]);
    const ls = [...tagged("x", "ex", 5), ...tagged("y", "why", 5)];
    const rows = captionRows(ls, null, { w: 1920, h: 1080 });

    const after = applyCaptionCommit(base, {
      clips: [
        // In the chosen order, which is not timeline order. The commit orders
        // the cutting itself.
        { key: "x", cuts: xCuts, splits: splits("x", xCuts.length) },
        { key: "y", cuts: yCuts, splits: splits("y", yCuts.length) },
      ],
      rows,
      ids: ids(rows.length),
    });

    expect(pieces(after, "v1")).toEqual([
      { file: "file:///x.mov", start: 0, end: 2_000, from: 0 },
      { file: "file:///x.mov", start: 2_000, end: 9_000, from: 3_000 },
      { file: "file:///y.mov", start: 9_000, end: 10_000, from: 0 },
      { file: "file:///y.mov", start: 10_000, end: 18_000, from: 2_000 },
    ]);
    expect(captions(after)).toEqual([
      { text: "ex", startTime: 4_000, duration: 1_000 },
      { text: "why", startTime: 13_000, duration: 1_000 },
    ]);
  });

  it("leaves each track with only its own clip's cuts", () => {
    const base = scene();
    const zCuts = cutsFor(base, "z", [{ startMs: 0, endMs: 1_000 }]);
    const after = applyCaptionCommit(base, {
      clips: [
        { key: "x", cuts: [], splits: [] },
        { key: "z", cuts: zCuts, splits: splits("z", zCuts.length) },
      ],
      rows: [],
      ids: ids(0),
    });
    expect(pieces(after, "v1")).toEqual(pieces(base, "v1"));
    expect(pieces(after, "v2")).toEqual([
      { file: "file:///z.mov", start: 5_000, end: 14_000, from: 1_000 },
    ]);
  });

  it("throws when one clip's pool runs dry, whatever the other clip has spare", () => {
    const base = scene();
    const xCuts = cutsFor(base, "x", [{ startMs: 2_000, endMs: 3_000 }]);
    const yCuts = cutsFor(base, "y", [{ startMs: 2_000, endMs: 3_000 }]);
    expect(() =>
      applyCaptionCommit(base, {
        clips: [
          { key: "x", cuts: xCuts, splits: [] },
          { key: "y", cuts: yCuts, splits: splits("y", 5) },
        ],
        rows: [],
        ids: ids(0),
      }),
    ).toThrow(/split ids/);
  });

  it("places nothing for a row whose clip is not in the commit", () => {
    const base = scene();
    const ls = [...tagged("x", "kept", 1), ...tagged("ghost", "dropped", 1)];
    const rows = captionRows(ls, null, { w: 1920, h: 1080 });
    const after = applyCaptionCommit(base, {
      clips: [{ key: "x", cuts: [], splits: [] }],
      rows,
      ids: ids(rows.length),
    });
    expect(captions(after).map((c) => c.text)).toEqual(["kept"]);
  });

  it("produces identical documents when run twice", () => {
    const base = scene();
    const xCuts = cutsFor(base, "x", [{ startMs: 2_000, endMs: 3_000 }]);
    const zCuts = cutsFor(base, "z", [{ startMs: 4_000, endMs: 6_000 }]);
    const ls = [...tagged("x", "ex", 5), ...tagged("z", "zed", 7)];
    const rows = captionRows(ls, null, { w: 1920, h: 1080 });
    const plan: CaptionCommit = {
      clips: [
        { key: "z", cuts: zCuts, splits: splits("z", zCuts.length) },
        { key: "x", cuts: xCuts, splits: splits("x", xCuts.length) },
      ],
      rows,
      ids: ids(rows.length),
    };
    expect(applyCaptionCommit(scene(), plan).elements).toEqual(
      applyCaptionCommit(scene(), plan).elements,
    );
  });
});
