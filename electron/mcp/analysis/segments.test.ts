import { describe, it, expect } from "vitest";
import {
  GAP_MS,
  confidenceFromLogProb,
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
