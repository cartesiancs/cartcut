import { describe, expect, it } from "vitest";
import {
  TIMELINE_VIEW_ENTRY_VERSION,
  parseTimelineViewEntry,
  parseTimelineViewNotes,
  serializeTimelineViewEntry,
} from "./timelineView";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
} from "../timeline/trackHeights";

const IDS = ["v1", "v2", "a1"];

describe("serializeTimelineViewEntry", () => {
  it("writes nothing for a project with every row at the default", () => {
    // `null` is the load-bearing answer: it means no zip entry at all, so a
    // project nobody resized a row in stays byte-identical to an older one.
    expect(serializeTimelineViewEntry({}, IDS)).toBeNull();
    expect(
      serializeTimelineViewEntry({ v1: DEFAULT_TRACK_HEIGHT }, IDS),
    ).toBeNull();
  });

  it("writes nothing when the only resized rows no longer exist", () => {
    expect(serializeTimelineViewEntry({ gone: 90 }, IDS)).toBeNull();
  });

  it("writes the resized rows in an envelope", () => {
    const text = serializeTimelineViewEntry({ v2: 90, gone: 70 }, IDS);
    expect(JSON.parse(text!)).toEqual({
      v: TIMELINE_VIEW_ENTRY_VERSION,
      trackHeights: { v2: 90 },
    });
  });

  it("writes the same bytes whatever order the rows were resized in", () => {
    const one = serializeTimelineViewEntry({ v2: 90, v1: 60 }, IDS);
    const two = serializeTimelineViewEntry({ v1: 60, v2: 90 }, [...IDS].reverse());
    expect(one).toBe(two);
  });
});

describe("parseTimelineViewEntry", () => {
  const entry = (trackHeights: unknown, v: unknown = TIMELINE_VIEW_ENTRY_VERSION) =>
    JSON.stringify({ v, trackHeights });

  it("round-trips what was written", () => {
    const heights = { v1: 60, a1: 150 };
    const text = serializeTimelineViewEntry(heights, IDS);
    expect(parseTimelineViewEntry(text, IDS)).toEqual(heights);
  });

  it("fails closed on anything that is not a version 1 envelope", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "{",
      "[]",
      "42",
      '"text"',
      JSON.stringify({ trackHeights: { v1: 60 } }),
      entry({ v1: 60 }, 2),
      entry([60]),
      entry(null),
      entry("v1"),
    ]) {
      expect(parseTimelineViewEntry(bad as string | null, IDS)).toEqual({});
    }
  });

  it("drops values that are not numbers, and rows the project does not have", () => {
    const text = entry({ v1: "60", v2: null, a1: true, gone: 90, v3: 80 });
    expect(parseTimelineViewEntry(text, IDS)).toEqual({});
  });

  it("brings an out-of-range height into range rather than dropping it", () => {
    const text = entry({ v1: 10_000, v2: -5, a1: 57.6 });
    expect(parseTimelineViewEntry(text, IDS)).toEqual({
      v1: MAX_TRACK_HEIGHT,
      v2: MIN_TRACK_HEIGHT,
      a1: 58,
    });
  });

  it("leaves a stored default out, as the writer would have", () => {
    const text = entry({ v1: DEFAULT_TRACK_HEIGHT, v2: Number.MAX_VALUE });
    expect(parseTimelineViewEntry(text, IDS)).toEqual({ v2: MAX_TRACK_HEIGHT });
  });

  it("reads an id like __proto__ as data", () => {
    const text = '{"v":1,"trackHeights":{"__proto__":70}}';
    const parsed = parseTimelineViewEntry(text, ["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe("notes in the timelineView entry", () => {
  const note = (id: string, trackId = "v1", text = "fix the cut") => ({
    id,
    trackId,
    atMs: 1500,
    text,
  });

  it("writes the same bytes as before for a project with heights and no notes", () => {
    expect(serializeTimelineViewEntry({ v2: 90 }, IDS, [])).toBe(
      '{"v":1,"trackHeights":{"v2":90}}',
    );
  });

  it("writes notes alone without an empty heights key", () => {
    const text = serializeTimelineViewEntry({}, IDS, [note("a")]);
    expect(JSON.parse(text!)).toEqual({
      v: TIMELINE_VIEW_ENTRY_VERSION,
      notes: [note("a")],
    });
  });

  it("writes nothing for empty notes and notes on missing tracks", () => {
    expect(
      serializeTimelineViewEntry({}, IDS, [note("a", "v1", ""), note("b", "gone")]),
    ).toBeNull();
  });

  it("writes the same bytes whatever order a note's keys were built in", () => {
    const shuffled = { text: "fix the cut", atMs: 1500, trackId: "v1", id: "a" };
    expect(serializeTimelineViewEntry({}, IDS, [shuffled])).toBe(
      serializeTimelineViewEntry({}, IDS, [note("a")]),
    );
  });

  it("round-trips notes in the order they were made, beside the heights", () => {
    const notes = [note("b", "a1"), note("a", "v2")];
    const text = serializeTimelineViewEntry({ v1: 60 }, IDS, notes);
    expect(parseTimelineViewNotes(text, IDS)).toEqual(notes);
    expect(parseTimelineViewEntry(text, IDS)).toEqual({ v1: 60 });
  });

  it("drops malformed notes one at a time and never costs the heights", () => {
    const text = JSON.stringify({
      v: TIMELINE_VIEW_ENTRY_VERSION,
      trackHeights: { v1: 60 },
      notes: [
        note("ok"),
        note("ok"),
        { ...note("blank"), text: "   " },
        { ...note("t"), atMs: "1500" },
        { ...note("nan"), atMs: null },
        note("gone", "gone"),
        { trackId: "v1", atMs: 0, text: "no id" },
        null,
        "note",
      ],
    });
    expect(parseTimelineViewNotes(text, IDS)).toEqual([note("ok")]);
    expect(parseTimelineViewEntry(text, IDS)).toEqual({ v1: 60 });
  });

  it("reads no notes from anything that is not a version 1 envelope", () => {
    for (const bad of [
      null,
      "",
      "{",
      JSON.stringify({ notes: [note("a")] }),
      JSON.stringify({ v: 2, notes: [note("a")] }),
      JSON.stringify({ v: 1, notes: { a: note("a") } }),
    ]) {
      expect(parseTimelineViewNotes(bad, IDS)).toEqual([]);
    }
  });
});
