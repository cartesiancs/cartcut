import { describe, expect, it } from "vitest";
import {
  TIMELINE_VIEW_ENTRY_VERSION,
  parseTimelineViewEntry,
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
