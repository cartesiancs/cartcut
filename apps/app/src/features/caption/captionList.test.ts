import { describe, expect, it } from "vitest";
import type { TimeRange } from "../timeline/clipOps";
import {
  captionListItems,
  silenceRow,
  type CaptionListInput,
  type CaptionListItem,
} from "./captionList";
import { linesFromWordGroups, removeLine, type CaptionLine } from "./lines";

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** Words at 1s, 5s to 8.5s (one line, a pause inside it) and 9s, in one clip. */
function clipLines(key: string, offset = 0): CaptionLine[] {
  return linesFromWordGroups(
    [
      [{ word: "early", start: offset + 1, end: offset + 2 }],
      [
        { word: "inside", start: offset + 5, end: offset + 6 },
        { word: "edge", start: offset + 7.5, end: offset + 8.5 },
      ],
      [{ word: "late", start: offset + 9, end: offset + 10 }],
    ],
    counter(`${key}-`),
  ).map((line) => ({ ...line, sourceKey: key }));
}

const gap = (startMs: number, endMs: number): TimeRange => ({ startMs, endMs });

/** Lead-in, between two lines, inside the middle line, lead-out. */
const GAPS = [gap(100, 900), gap(2_100, 4_900), gap(6_100, 7_400), gap(10_100, 12_000)];

/** The list as a short string, so an ordering reads at a glance. */
function shape(items: CaptionListItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "section":
        return `#${item.number}:${item.key}@${item.at}`;
      case "line":
        return `L${item.index}`;
      case "silence":
        return `S${item.startMs}${item.cut ? "x" : ""}`;
    }
  });
}

const items = (over: Partial<CaptionListInput> & Pick<CaptionListInput, "lines">) =>
  captionListItems({
    leaders: ["a"],
    silenceByKey: {},
    silenceOn: false,
    ...over,
  });

describe("captionListItems, one clip", () => {
  it("is the lines alone when the sweep found nothing", () => {
    expect(shape(items({ lines: clipLines("a") }))).toEqual(["L0", "L1", "L2"]);
  });

  it("puts each gap where it sits: before, between, inside and after the lines", () => {
    expect(
      shape(items({ lines: clipLines("a"), silenceByKey: { a: GAPS } })),
    ).toEqual(["S100", "L0", "S2100", "L1", "S6100", "L2", "S10100"]);
  });

  it("orders the gaps by time whatever order they arrive in", () => {
    expect(
      shape(
        items({ lines: clipLines("a"), silenceByKey: { a: [...GAPS].reverse() } }),
      ),
    ).toEqual(["S100", "L0", "S2100", "L1", "S6100", "L2", "S10100"]);
  });

  it("draws no header for a single clip", () => {
    const out = items({ lines: clipLines("a"), silenceByKey: { a: GAPS } });
    expect(out.some((item) => item.kind === "section")).toBe(false);
  });

  it("keeps a gap with no line to sit by", () => {
    expect(shape(items({ lines: [], silenceByKey: { a: [gap(0, 3_000)] } }))).toEqual([
      "S0",
    ]);
  });

  it("skips a gap with no length", () => {
    expect(
      shape(items({ lines: clipLines("a"), silenceByKey: { a: [gap(3_000, 3_000)] } })),
    ).toEqual(["L0", "L1", "L2"]);
  });
});

describe("captionListItems, several clips", () => {
  const a = clipLines("a");
  const b = clipLines("b", 100);
  const twoClips = {
    lines: [...a, ...b],
    leaders: ["a", "b"],
    silenceByKey: {
      a: [gap(10_100, 12_000)],
      b: [gap(100_100, 100_900)],
    },
  };

  it("is the headers and the lines alone when the sweep found nothing", () => {
    expect(shape(items({ ...twoClips, silenceByKey: {} }))).toEqual([
      "#1:a@0",
      "L0",
      "L1",
      "L2",
      "#2:b@3",
      "L3",
      "L4",
      "L5",
    ]);
  });

  // The position the template could not have got right on its own: a clip's
  // last gap belongs above the next clip's header, its first gap below it.
  it("ends one clip before the next one's header begins", () => {
    expect(shape(items(twoClips))).toEqual([
      "#1:a@0",
      "L0",
      "L1",
      "L2",
      "S10100",
      "#2:b@3",
      "S100100",
      "L3",
      "L4",
      "L5",
    ]);
  });

  it("places a clip's gaps against its own lines, never another clip's", () => {
    // Both clips have a gap at the same source time; each lands in its own section.
    const out = items({
      ...twoClips,
      lines: [...a, ...clipLines("b")],
      silenceByKey: { a: [gap(2_100, 4_900)], b: [gap(2_100, 4_900)] },
    });
    expect(shape(out)).toEqual([
      "#1:a@0",
      "L0",
      "S2100",
      "L1",
      "L2",
      "#2:b@3",
      "L3",
      "S2100",
      "L4",
      "L5",
    ]);
    const keys = out.filter((item) => item.kind === "silence").map((item) => item.key);
    expect(keys).toEqual(["a", "b"]);
  });

  it("puts a speechless clip's gaps under its header", () => {
    const out = items({
      lines: [...a, ...b],
      leaders: ["a", "quiet", "b"],
      silenceByKey: { quiet: [gap(0, 5_000)] },
    });
    expect(shape(out)).toEqual([
      "#1:a@0",
      "L0",
      "L1",
      "L2",
      "#2:quiet@3",
      "S0",
      "#3:b@3",
      "L3",
      "L4",
      "L5",
    ]);
  });

  // A twin is cut with its leader's list, so its leader's rows already stand
  // for it. Rows of its own would be the same footage listed twice.
  it("gives a twin no rows of its own", () => {
    const out = items({
      lines: a,
      leaders: ["a"],
      silenceByKey: { a: [gap(2_100, 4_900)], twin: [gap(2_100, 4_900)] },
    });
    expect(out.filter((item) => item.kind === "silence")).toHaveLength(1);
  });
});

describe("captionListItems, what is cut", () => {
  it("marks every gap cut once the button has cut them", () => {
    expect(
      shape(items({ lines: clipLines("a"), silenceByKey: { a: GAPS }, silenceOn: true })),
    ).toEqual(["S100x", "L0", "S2100x", "L1", "S6100x", "L2", "S10100x"]);
  });

  // A struck-out line takes its whole span with it, the pause inside included,
  // whatever the button says.
  it("marks a gap inside a struck-out line cut, and only that one", () => {
    const lines = removeLine(clipLines("a"), 1);
    expect(shape(items({ lines, silenceByKey: { a: GAPS } }))).toEqual([
      "S100",
      "L0",
      "S2100",
      "L1",
      "S6100x",
      "L2",
      "S10100",
    ]);
  });
});

describe("silenceRow", () => {
  it("names the gap by its length", () => {
    expect(silenceRow({ startMs: 2_100, endMs: 4_900, cut: false }).label).toBe(
      "2.8s silence",
    );
  });

  it("says where the footage went once it is cut", () => {
    expect(silenceRow({ startMs: 0, endMs: 400, cut: true }).title).toMatch(/cut/i);
    expect(silenceRow({ startMs: 0, endMs: 400, cut: false }).title).toMatch(
      /button/i,
    );
  });
});
