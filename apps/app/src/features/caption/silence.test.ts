import { describe, expect, it } from "vitest";
import type { TimeRange } from "../timeline/clipOps";
import { linesFromWordGroups, removeLine, type CaptionLine } from "./lines";
import {
  DEFAULT_SILENCE_OPTIONS,
  silenceCuts,
  wordGaps,
} from "./silence";

/** Words at 0-1s and 4-5s: one second of lead-in is not there, 3s sits between. */
const lines = (): CaptionLine[] =>
  linesFromWordGroups([
    [{ word: "hello", start: 1, end: 2 }],
    [{ word: "again", start: 5, end: 6 }],
  ]);

const BOUNDS: TimeRange = { startMs: 0, endMs: 8000 };

/** No breath kept and no floor, so a test can assert the raw intersection. */
const RAW = { keepMs: 0, minCutMs: 0 };

describe("wordGaps", () => {
  it("names the lead-in, the gap between words, and the lead-out", () => {
    expect(wordGaps(lines(), BOUNDS)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 5000 },
      { startMs: 6000, endMs: 8000 },
    ]);
  });

  // The lead-in and lead-out are usually the longest silences in a take, and a
  // between-words-only rule could not name either.
  it("has no lead-in when a word starts at the bound", () => {
    expect(wordGaps(lines(), { startMs: 1000, endMs: 8000 })[0]).toEqual({
      startMs: 2000,
      endMs: 5000,
    });
  });

  it("has no lead-out when the bound ends on the last word", () => {
    const gaps = wordGaps(lines(), { startMs: 0, endMs: 6000 });
    expect(gaps[gaps.length - 1]).toEqual({ startMs: 2000, endMs: 5000 });
  });

  it("clamps to the bounds rather than reporting the whole file", () => {
    for (const gap of wordGaps(lines(), { startMs: 1500, endMs: 5500 })) {
      expect(gap.startMs).toBeGreaterThanOrEqual(1500);
      expect(gap.endMs).toBeLessThanOrEqual(5500);
    }
  });

  it("counts a struck-out line's words like any other", () => {
    // Its footage is cut whole, so `cuts.ts` merges over it; leaving a spurious
    // gap here would be a second, disagreeing answer.
    expect(wordGaps(removeLine(lines(), 0), BOUNDS)).toEqual(
      wordGaps(lines(), BOUNDS),
    );
  });

  it("does not reopen a gap for a word nested inside a longer one", () => {
    const overlapping = linesFromWordGroups([
      [
        { word: "long", start: 1, end: 4 },
        { word: "in", start: 2, end: 3 },
      ],
    ]);
    expect(wordGaps(overlapping, { startMs: 0, endMs: 6000 })).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 4000, endMs: 6000 },
    ]);
  });

  it("is the whole window when nothing was said", () => {
    expect(wordGaps([], BOUNDS)).toEqual([BOUNDS]);
  });
});

describe("silenceCuts", () => {
  const gaps = () => wordGaps(lines(), BOUNDS);

  it("cuts where the signal and the words agree", () => {
    const silences = [{ startMs: 2500, endMs: 4500 }];
    expect(silenceCuts(silences, gaps(), RAW)).toEqual([
      { startMs: 2500, endMs: 4500 },
    ]);
  });

  // The half the signal contributes: a gap the transcript calls empty but that
  // carries a sound effect is not dead air, and must survive.
  it("keeps a gap the signal did not call silent", () => {
    expect(silenceCuts([], gaps(), RAW)).toEqual([]);
  });

  // The half the words contribute: a word quiet enough to dip under the
  // threshold must not be cut out of the middle of a sentence.
  it("keeps a quiet stretch that a word covers", () => {
    const underAWord = [{ startMs: 1200, endMs: 1800 }];
    expect(silenceCuts(underAWord, gaps(), RAW)).toEqual([]);
  });

  it("cuts only the overlapping part when the two disagree at the edges", () => {
    const silences = [{ startMs: 1500, endMs: 3000 }];
    expect(silenceCuts(silences, gaps(), RAW)).toEqual([
      { startMs: 2000, endMs: 3000 },
    ]);
  });

  it("leaves keepMs of silence rather than closing the gap entirely", () => {
    const silences = [{ startMs: 2000, endMs: 5000 }];
    const [cut] = silenceCuts(silences, gaps(), { keepMs: 400, minCutMs: 0 });
    expect(cut).toEqual({ startMs: 2200, endMs: 4800 });
  });

  it("declines a silence no longer than the breath it would have to keep", () => {
    const silences = [{ startMs: 2000, endMs: 2300 }];
    expect(
      silenceCuts(silences, gaps(), { keepMs: 400, minCutMs: 0 }),
    ).toEqual([]);
  });

  it("drops a cut shorter than minCutMs", () => {
    const silences = [{ startMs: 2000, endMs: 2100 }];
    expect(
      silenceCuts(silences, gaps(), { keepMs: 0, minCutMs: 150 }),
    ).toEqual([]);
  });

  it("merges one long silence that spans two gaps into ordered cuts", () => {
    const silences = [{ startMs: 0, endMs: 8000 }];
    const cuts = silenceCuts(silences, gaps(), RAW);
    expect(cuts).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 5000 },
      { startMs: 6000, endMs: 8000 },
    ]);
  });

  it("returns cuts in ascending order", () => {
    const silences = [
      { startMs: 6000, endMs: 8000 },
      { startMs: 0, endMs: 1000 },
    ];
    const cuts = silenceCuts(silences, gaps(), RAW);
    expect(cuts.map((cut) => cut.startMs)).toEqual([0, 6000]);
  });

  it("ships a breath and a floor by default", () => {
    expect(DEFAULT_SILENCE_OPTIONS.keepMs).toBeGreaterThan(0);
    expect(DEFAULT_SILENCE_OPTIONS.minCutMs).toBeGreaterThan(0);
  });
});
