import { describe, it, expect } from "vitest";
import {
  GAP_MS,
  MAX_CHARS,
  MAX_MS,
  confidenceFromLogProb,
  groupWords,
  segmentWords,
  type TranscriptWord,
} from "./segments";

/** Words laid end to end, `gapMs` apart, 200ms each. */
function run(
  texts: string[],
  options: { from?: number; gapMs?: number; speaker?: string; confidence?: number } = {},
): TranscriptWord[] {
  const gap = options.gapMs ?? 50;
  let at = options.from ?? 0;
  return texts.map((word) => {
    const entry: TranscriptWord = {
      word,
      startMs: at,
      endMs: at + 200,
      ...(options.speaker != null ? { speaker: options.speaker } : {}),
      ...(options.confidence != null ? { confidence: options.confidence } : {}),
    };
    at += 200 + gap;
    return entry;
  });
}

describe("segmentWords", () => {
  it("joins a short run into one line", () => {
    const segments = segmentWords(run(["one", "two", "three"]));
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("one two three");
  });

  it("spans the first word's start to the last word's end", () => {
    const words = run(["one", "two"]);
    const [segment] = segmentWords(words);
    expect(segment.startMs).toBe(words[0].startMs);
    expect(segment.endMs).toBe(words[1].endMs);
  });

  it("breaks on a long pause", () => {
    const first = run(["hello", "there"]);
    const second = run(["and", "then"], {
      from: first[first.length - 1].endMs + GAP_MS,
    });
    expect(segmentWords([...first, ...second])).toHaveLength(2);
  });

  it("breaks after sentence-final punctuation", () => {
    const segments = segmentWords(run(["done.", "next", "thing"]));
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("done.");
  });

  it("breaks when a line gets too long", () => {
    const segments = segmentWords(run(new Array(12).fill("abcdefg")));
    expect(segments.length).toBeGreaterThan(1);
  });

  it("returns nothing for no words", () => {
    expect(segmentWords([])).toEqual([]);
  });

  describe("speakers", () => {
    it("breaks when the speaker changes, however well the line fits", () => {
      // The whole run is short, close together and unpunctuated: only the
      // speaker change can split it.
      const a = run(["yes", "exactly"], { speaker: "SPEAKER_00" });
      const b = run(["I", "disagree"], {
        from: a[a.length - 1].endMs + 50,
        speaker: "SPEAKER_01",
      });

      const segments = segmentWords([...a, ...b]);
      expect(segments).toHaveLength(2);
      expect(segments[0].speaker).toBe("SPEAKER_00");
      expect(segments[1].speaker).toBe("SPEAKER_01");
      expect(segments[1].text).toBe("I disagree");
    });

    it("leaves the speaker off entirely when nothing is diarised", () => {
      const [segment] = segmentWords(run(["no", "labels"]));
      expect(segment.speaker).toBeUndefined();
      expect("speaker" in segment).toBe(false);
    });
  });

  describe("confidence", () => {
    it("averages the words it grouped", () => {
      const words = run(["a", "b"]);
      words[0].confidence = 0.9;
      words[1].confidence = 0.5;

      expect(segmentWords(words)[0].confidence).toBeCloseTo(0.7, 5);
    });

    it("ignores words that carry no score rather than counting them as zero", () => {
      // A back end that scores some words and not others must not drag the
      // line's confidence down for the ones it stayed quiet about.
      const words = run(["a", "b"]);
      words[0].confidence = 0.8;

      expect(segmentWords(words)[0].confidence).toBeCloseTo(0.8, 5);
    });

    it("leaves it off when no word carries one", () => {
      const [segment] = segmentWords(run(["a", "b"]));
      expect("confidence" in segment).toBe(false);
    });
  });
});

describe("confidenceFromLogProb", () => {
  it("exponentiates a log probability", () => {
    expect(confidenceFromLogProb(0)).toBe(1);
    expect(confidenceFromLogProb(Math.log(0.5))).toBeCloseTo(0.5, 2);
  });

  it("clamps a positive log probability to 1", () => {
    expect(confidenceFromLogProb(5)).toBe(1);
  });

  it("is undefined for anything that is not a finite number", () => {
    expect(confidenceFromLogProb(undefined)).toBeUndefined();
    expect(confidenceFromLogProb(null)).toBeUndefined();
    expect(confidenceFromLogProb("-0.3")).toBeUndefined();
    expect(confidenceFromLogProb(NaN)).toBeUndefined();
    expect(confidenceFromLogProb(-Infinity)).toBeUndefined();
  });
});

/**
 * `groupWords` directly, rather than through `segmentWords`.
 *
 * It was covered only transitively, which left the property the auto-caption
 * panel actually depends on unasserted: the panel shows one clickable chip per
 * word and seeks to `word.start`, so it needs the **words**, not the joined
 * text. `segmentWords` throws them away on the next line
 * (`groupWords(...).map(toSegment)`), so no existing case could have noticed
 * grouping that dropped, duplicated or reordered one.
 *
 * Each break reason is exercised alone. `breaksBefore` is a disjunction of
 * five, so a case that trips two of them proves nothing about either.
 */
describe("groupWords", () => {
  /** Single-character words, so `chars` grows slowly enough to isolate `MAX_MS`. */
  function slow(count: number): TranscriptWord[] {
    return Array.from({ length: count }, (_, index) => ({
      word: "a",
      startMs: index * 800,
      endMs: index * 800 + 700,
    }));
  }

  it("answers an empty list for no words", () => {
    expect(groupWords([])).toEqual([]);
  });

  it("keeps the very word objects it was given", () => {
    // Identity, not equality. The panel reads `word.start`/`word.end` off these
    // to seek, and `lines.ts` partitions them by midpoint on a split.
    const words = run(["one", "two", "three"]);
    const flattened = groupWords(words).flat();

    expect(flattened).toHaveLength(words.length);
    words.forEach((word, index) => expect(flattened[index]).toBe(word));
  });

  it("never emits an empty group", () => {
    // `linesFromWordGroups` filters empty groups defensively, and `splitLineAt`
    // would read `words[0].start` off one. Nothing here should ever produce one
    // — including at a break, where `current` is pushed before being reset.
    const cases = [
      run(["Hi.", "there.", "again."]),
      [...run(["a"], { speaker: "A" }), ...run(["b"], { from: 400, speaker: "B" })],
      slow(10),
      run([]),
    ];

    for (const words of cases) {
      for (const group of groupWords(words)) {
        expect(group.length).toBeGreaterThan(0);
      }
    }
  });

  it("puts a lone word in a line of its own", () => {
    expect(groupWords(run(["alone"]))).toEqual([run(["alone"])]);
  });

  it("breaks on a change of speaker, however well the line would fit", () => {
    const words = [
      ...run(["we", "agree"], { speaker: "A" }),
      ...run(["and", "so"], { from: 600, speaker: "B" }),
    ];
    const groups = groupWords(words);

    expect(groups.map((g) => g.map((w) => w.word))).toEqual([
      ["we", "agree"],
      ["and", "so"],
    ]);
  });

  it("breaks when a speaker label appears partway through", () => {
    // `word.speaker !== previous.speaker` compares undefined too, so an
    // unlabelled word followed by a labelled one is a change.
    const words = [...run(["hello"]), ...run(["there"], { from: 400, speaker: "A" })];

    expect(groupWords(words)).toHaveLength(2);
  });

  it("does not break when neither word carries a speaker", () => {
    expect(groupWords(run(["no", "labels", "here"]))).toHaveLength(1);
  });

  it("breaks on a pause of exactly GAP_MS, and not just below it", () => {
    const head = run(["hello", "there"]);
    const endOfHead = head[head.length - 1].endMs;

    const atTheLimit = [...head, ...run(["and"], { from: endOfHead + GAP_MS })];
    const justUnder = [...head, ...run(["and"], { from: endOfHead + GAP_MS - 1 })];

    expect(groupWords(atTheLimit)).toHaveLength(2);
    expect(groupWords(justUnder)).toHaveLength(1);
  });

  it("breaks on length, counting each word plus its space", () => {
    // `chars` is measured over the line so far, before the new word joins it:
    // 4-letter words contribute 5 each, so the 10th word is the first one
    // considered with 45 >= MAX_CHARS already banked.
    const groups = groupWords(run(Array.from({ length: 12 }, () => "word")));

    expect(groups.map((g) => g.length)).toEqual([9, 3]);
    expect(9 * "word".length + 9).toBeGreaterThanOrEqual(MAX_CHARS);
    expect(8 * "word".length + 8).toBeLessThan(MAX_CHARS);
  });

  it("breaks on duration once the line would span MAX_MS", () => {
    // Single-character words keep `chars` at 2 apiece, so this is the duration
    // rule firing alone: the 8th word would carry the line to 6300ms.
    const groups = groupWords(slow(10));

    expect(groups.map((g) => g.length)).toEqual([7, 3]);
    expect(7 * 800 + 700).toBeGreaterThanOrEqual(MAX_MS);
    expect(6 * 800 + 700).toBeLessThan(MAX_MS);
  });

  it("breaks after sentence-final punctuation, including the CJK marks", () => {
    for (const terminator of [".", "!", "?", "\u3002", "\uff1f", "\uff01"]) {
      const groups = groupWords(run([`done${terminator}`, "next"]));
      expect(groups.map((g) => g.length)).toEqual([1, 1]);
    }
  });

  it("does not break on punctuation inside a word", () => {
    // The test is anchored to the end of the previous word, so an abbreviation
    // mid-word or a comma does not end a line.
    expect(groupWords(run(["e.g", "this", "stays"]))).toHaveLength(1);
    expect(groupWords(run(["first,", "second"]))).toHaveLength(1);
  });

  it("groups exactly as segmentWords does", () => {
    // `segmentWords` is `groupWords(...).map(toSegment)`, and the panel and the
    // agent must not disagree about where a caption breaks. Pinned so the two
    // cannot be given separate rules later.
    const words = [
      ...run(["the", "first", "line", "ends", "here."]),
      ...run(["and", "the", "second"], { from: 2000 }),
      ...run(["third"], { from: 4000, speaker: "B" }),
    ];
    const groups = groupWords(words);
    const segments = segmentWords(words);

    expect(segments).toHaveLength(groups.length);
    groups.forEach((group, index) => {
      expect(segments[index].startMs).toBe(group[0].startMs);
      expect(segments[index].endMs).toBe(group[group.length - 1].endMs);
      expect(segments[index].text).toBe(group.map((w) => w.word).join(" "));
    });
  });
});
