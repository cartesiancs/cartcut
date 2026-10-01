import { describe, expect, it } from "vitest";
import { captionWarnings, type CaptionWarningInput } from "./captionWarnings";

const warnings = (over: Partial<CaptionWarningInput> = {}) =>
  captionWarnings({
    clipCount: 1,
    cutting: false,
    covered: 0,
    refused: 0,
    stranded: 0,
    ...over,
  });

describe("captionWarnings", () => {
  it("says nothing about a session that cuts nothing", () => {
    expect(warnings()).toEqual([]);
  });

  // A refused clip is decided at start, when nothing is asked to be cut yet.
  // "Not cut" is only news once a cut was asked for.
  it("holds a refusal back until something is to be cut", () => {
    expect(warnings({ refused: 2 })).toEqual([]);
    expect(warnings({ refused: 2, cutting: true }).map((w) => w.key)).toEqual([
      "refused:2",
    ]);
  });

  it("names stranded clips and whole-clip cuts by count", () => {
    const out = warnings({ cutting: true, covered: 1, stranded: 3 });
    expect(out.map((w) => w.key)).toEqual(["covered:1", "stranded:3"]);
    expect(out[0].message).toMatch(/whole clip/);
    expect(out[1].message).toMatch(/^3 clip\(s\)/);
  });

  it("words a covered clip for one clip and for several", () => {
    expect(warnings({ covered: 1 })[0].message).toMatch(/^Those cuts cover the whole clip/);
    expect(warnings({ covered: 1, clipCount: 2 })[0].message).toMatch(
      /^The cuts cover 1 whole clip/,
    );
  });

  // The caller shows each key once, so the same state has to give the same key.
  it("gives the same state the same keys", () => {
    const input = { cutting: true, covered: 1, refused: 1, stranded: 2 };
    expect(warnings(input).map((w) => w.key)).toEqual(
      warnings(input).map((w) => w.key),
    );
  });
});
