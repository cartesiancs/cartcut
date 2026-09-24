/**
 * Naming a stretch of text from outside the editor.
 *
 * The document side is already covered by `timeline/textRunOps.test.ts`. What
 * is tested here is the half this module adds: turning a `match` into offsets,
 * and refusing rather than silently naming nothing.
 *
 * The range resolver is pure and takes the string, so it needs no store and no
 * DOM — which is why it is the part worth extracting and pinning.
 */

import { describe, expect, it } from "vitest";

import {
  occurrencesOf,
  resolveRange,
  resolveRanges,
} from "./textRange";

describe("occurrencesOf", () => {
  it("finds every occurrence, left to right", () => {
    expect(occurrencesOf("a-b-a-b-a", "a")).toEqual([0, 4, 8]);
  });

  it("does not overlap a match with itself", () => {
    // "aaaa" contains "aa" twice by this counting and three times by an
    // overlapping one. Non-overlapping is what a styling pass wants: the
    // overlapping reading would paint the middle pair twice and leave the
    // caller unable to describe the second half on its own.
    expect(occurrencesOf("aaaa", "aa")).toEqual([0, 2]);
  });

  it("answers an empty list rather than throwing on a miss", () => {
    expect(occurrencesOf("Hello", "zz")).toEqual([]);
  });
});

describe("resolveRange", () => {
  const TEXT = "Ship it, then ship it again";

  it("styles every occurrence when no occurrence is named", () => {
    expect(resolveRange(TEXT, { match: "ship" }, 0)).toEqual([
      { from: 14, to: 18 },
    ]);
    // Case-sensitive on purpose: "Ship" at 0 is a different word to the eye.
    expect(resolveRange(TEXT, { match: "it" }, 0)).toEqual([
      { from: 5, to: 7 },
      { from: 19, to: 21 },
    ]);
  });

  it("picks one occurrence, 1-based", () => {
    expect(resolveRange(TEXT, { match: "it", occurrence: 2 }, 0)).toEqual([
      { from: 19, to: 21 },
    ]);
  });

  it("refuses a match that is not there", () => {
    expect(() => resolveRange(TEXT, { match: "sail" }, 0)).toThrow(
      /does not appear/,
    );
  });

  it("refuses an occurrence past the end, and says how many there are", () => {
    expect(() => resolveRange(TEXT, { match: "it", occurrence: 3 }, 0)).toThrow(
      /appears 2 time/,
    );
  });

  it("takes explicit offsets", () => {
    expect(resolveRange(TEXT, { from: 0, to: 4 }, 0)).toEqual([
      { from: 0, to: 4 },
    ]);
  });

  it("refuses a spec that names neither form", () => {
    expect(() => resolveRange(TEXT, {}, 2)).toThrow(/ranges\[2\]/);
    expect(() => resolveRange(TEXT, { from: 3 }, 0)).toThrow(/both `from` and `to`/);
  });

  it("counts in UTF-16 code units, which is why match exists", () => {
    // The emoji is one grapheme and two code units, so "b" sits at 3 and not
    // at 2. An agent counting characters would style the wrong glyph; `match`
    // is how it avoids having to count at all.
    const withEmoji = "a\u{1F600}b";
    expect(withEmoji.length).toBe(4);
    expect(resolveRange(withEmoji, { match: "b" }, 0)).toEqual([
      { from: 3, to: 4 },
    ]);
  });
});

describe("resolveRanges", () => {
  it("flattens several specs in the order they were written", () => {
    expect(
      resolveRanges("one two three", [{ match: "three" }, { match: "one" }]),
    ).toEqual([
      { from: 8, to: 13 },
      { from: 0, to: 3 },
    ]);
  });

  it("refuses an empty list", () => {
    expect(() => resolveRanges("abc", [])).toThrow(/at least one/);
    expect(() => resolveRanges("abc", undefined)).toThrow(/at least one/);
  });

  it("refuses the whole list when one entry is bad", () => {
    // Half an edit is worse than none: the caller cannot tell which ranges
    // landed, and the usual cause is a typo it can fix once told.
    expect(() =>
      resolveRanges("one two", [{ match: "one" }, { match: "nine" }]),
    ).toThrow(/ranges\[1\]/);
  });
});
