import { describe, expect, it } from "vitest";
import {
  captionsFrom,
  lineIndexAt,
  linesFromWordGroups,
  mergeCaretOffset,
  mergeLineWithPrevious,
  setLineText,
  splitLineAt,
  splitLineAt as split,
  wordIndexAt,
  type CaptionWord,
} from "./lines";

/** "hello there world" — three words, one second each. */
const WORDS: CaptionWord[] = [
  { word: "hello", start: 0, end: 1, score: 0.9 },
  { word: "there", start: 1, end: 2, score: 0.8 },
  { word: "world", start: 2, end: 3, score: 0.7 },
];

const lines = () => linesFromWordGroups([WORDS]);

describe("linesFromWordGroups", () => {
  it("takes the span from the words and the text from joining them", () => {
    expect(lines()).toEqual([
      { words: WORDS, start: 0, end: 3, text: "hello there world" },
    ]);
  });

  it("drops empty groups rather than making a line with no span", () => {
    expect(linesFromWordGroups([[], WORDS, []])).toHaveLength(1);
  });
});

describe("splitLineAt", () => {
  it("splits on a word boundary at that word's exact start", () => {
    // Caret after "hello ", i.e. before "there", whose start is 1.
    const [first, second] = split(lines(), 0, 6);

    expect(first.text).toBe("hello");
    expect(first.end).toBe(1);
    expect(first.words.map((w) => w.word)).toEqual(["hello"]);

    expect(second.text).toBe("there world");
    expect(second.start).toBe(1);
    expect(second.words.map((w) => w.word)).toEqual(["there", "world"]);
  });

  it("keeps the outer edges of the original line", () => {
    const [first, second] = split(lines(), 0, 6);
    expect(first.start).toBe(0);
    expect(second.end).toBe(3);
  });

  it("never divides a word's timing when a boundary is reachable", () => {
    // "hel|lo there world" — the caret is inside "hello", but a fragment still
    // counts as a token, so the cut snaps to the end of the word it is inside
    // rather than slicing that word's second in half. A caption edge mid-word
    // is a time that corresponds to nothing audible.
    const [first, second] = split(lines(), 0, 3);

    expect(first.text).toBe("hel");
    expect(second.text).toBe("lo there world");
    expect(first.end).toBe(1);
    expect(first.words.map((w) => w.word)).toEqual(["hello"]);
    expect(second.words.map((w) => w.word)).toEqual(["there", "world"]);
  });

  it("falls back to the caret's position only when no boundary is reachable", () => {
    // Caret past the last word boundary: tokens("hello there world x") is 4
    // against 3 words, so there is no `words[n]` to snap to.
    const long = setLineText(lines(), 0, "hello there world extra");
    const [first, second] = split(long, 0, 23 - 5);

    expect(first.text).toBe("hello there world");
    expect(second.text).toBe("extra");
    expect(first.end).toBeCloseTo(3 * (18 / 23), 5);
    expect(second.start).toBe(first.end);
    expect(second.end).toBe(3);
  });

  it("survives a line whose text no longer matches its words", () => {
    // The case that used to be impossible to reason about: the user rewrote the
    // line, so counting tokens says nothing about the word list.
    const edited = setLineText(lines(), 0, "completely different wording here now");
    const result = split(edited, 0, 21);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("completely different");
    expect(result[1].text).toBe("wording here now");
    expect(result[0].end).toBeGreaterThan(result[0].start);
    expect(result[1].end).toBeGreaterThan(result[1].start);
    expect(result[1].end).toBe(3);
  });

  it("splits a single-word line by time, not by word", () => {
    const one = linesFromWordGroups([[{ word: "안녕하세요", start: 0, end: 2 }]]);
    const [first, second] = split(one, 0, 2);

    expect(first.text).toBe("안녕");
    expect(second.text).toBe("하세요");
    expect(first.end).toBeCloseTo(0.8, 5);
    expect(second.end).toBe(2);
  });

  it("declines at the start of a line, by identity", () => {
    const before = lines();
    expect(split(before, 0, 0)).toBe(before);
  });

  it("declines at the end of a line, by identity", () => {
    const before = lines();
    expect(split(before, 0, before[0].text.length)).toBe(before);
  });

  it("declines where the caret sits among whitespace only", () => {
    // Trailing whitespace before the caret leaves an empty head.
    const padded = setLineText(lines(), 0, "   hello");
    expect(split(padded, 0, 2)).toBe(padded);
  });

  it("declines on an index that is not there", () => {
    const before = lines();
    expect(split(before, 7, 3)).toBe(before);
  });

  it("never loses a word across a split", () => {
    for (let caret = 1; caret < "hello there world".length; caret += 1) {
      const result = splitLineAt(lines(), 0, caret);
      const kept = result.flatMap((line) => line.words);
      expect(kept).toHaveLength(WORDS.length);
    }
  });
});

describe("mergeLineWithPrevious", () => {
  it("joins the text and unions the span", () => {
    const [merged] = mergeLineWithPrevious(split(lines(), 0, 6), 1);

    expect(merged.text).toBe("hello there world");
    expect(merged.start).toBe(0);
    expect(merged.end).toBe(3);
    expect(merged.words).toHaveLength(3);
  });

  it("round-trips a split", () => {
    const before = lines();
    const merged = mergeLineWithPrevious(split(before, 0, 6), 1);

    expect(merged).toEqual(before);
  });

  it("declines at the first line, by identity", () => {
    const before = lines();
    expect(mergeLineWithPrevious(before, 0)).toBe(before);
  });

  it("declines past the end, by identity", () => {
    const before = lines();
    expect(mergeLineWithPrevious(before, 9)).toBe(before);
  });

  it("reports the caret offset at the join", () => {
    const parts = split(lines(), 0, 6);
    expect(mergeCaretOffset(parts, 1)).toBe("hello".length);
  });
});

describe("setLineText", () => {
  it("leaves the timing alone", () => {
    const [line] = setLineText(lines(), 0, "something else entirely");

    expect(line.text).toBe("something else entirely");
    expect(line.start).toBe(0);
    expect(line.end).toBe(3);
    expect(line.words).toEqual(WORDS);
  });

  it("declines an unchanged value, by identity", () => {
    const before = lines();
    expect(setLineText(before, 0, before[0].text)).toBe(before);
  });

  it("survives a split, which is the defect this model replaces", () => {
    // Two lines; edit the second; split the first. The edit must still be there.
    const two = split(lines(), 0, 6);
    const edited = setLineText(two, 1, "CORRECTED");
    const after = split(edited, 0, 3);

    expect(after.map((line) => line.text)).toEqual(["hel", "lo", "CORRECTED"]);
  });
});

describe("lineIndexAt / wordIndexAt", () => {
  it("is half-open, so a boundary belongs to the later line", () => {
    const two = split(lines(), 0, 6);

    expect(lineIndexAt(two, 0)).toBe(0);
    expect(lineIndexAt(two, 0.99)).toBe(0);
    expect(lineIndexAt(two, 1)).toBe(1);
  });

  it("answers null outside every line rather than falling back to the first", () => {
    // The previous behaviour drew caption 0 before the first word and after the
    // last, which is why a caption appeared over a silent opening.
    const only = lines();
    expect(lineIndexAt(only, -1)).toBeNull();
    expect(lineIndexAt(only, 3)).toBeNull();
    expect(lineIndexAt(only, 99)).toBeNull();
  });

  it("finds the spoken word, or null between them", () => {
    const [line] = lines();
    expect(wordIndexAt(line, 1.5)).toBe(1);
    expect(wordIndexAt(line, 9)).toBeNull();
    expect(wordIndexAt(undefined, 1)).toBeNull();
  });
});

describe("captionsFrom", () => {
  it("converts to whole milliseconds", () => {
    expect(captionsFrom(lines())).toEqual([
      { text: "hello there world", startTime: 0, duration: 3000 },
    ]);
  });

  it("drops a line the user emptied", () => {
    expect(captionsFrom(setLineText(lines(), 0, "   "))).toEqual([]);
  });

  it("never emits a zero duration", () => {
    const instant = linesFromWordGroups([[{ word: "hi", start: 1, end: 1 }]]);
    expect(captionsFrom(instant)[0].duration).toBeGreaterThan(0);
  });

  it("clamps a negative start rather than placing off the timeline", () => {
    const early = linesFromWordGroups([[{ word: "hi", start: -0.5, end: 1 }]]);
    expect(captionsFrom(early)[0].startTime).toBe(0);
  });
});
