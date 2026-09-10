/**
 * What a reveal shows at a given progress.
 *
 * The arithmetic is small; the interesting cases are all about *where a cut is
 * allowed to fall*. A cut inside a grapheme is the failure that looks like a
 * broken font rather than a reveal, and a `word` unit that only knows about
 * spaces is one that does nothing at all in Japanese — so those are pinned
 * here rather than left to the renderer suite, where a wrong cut would show up
 * as a slightly different pixel count and nothing more.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REVEAL_FADE,
  DEFAULT_REVEAL_PROGRESS,
  clampRevealProgress,
  coerceReveal,
  coerceRevealUnit,
  defaultReveal,
  revealOf,
  revealPlan,
  sameReveal,
  totalUnits,
  unitBoundaries,
  unitCount,
} from "./reveal";

const textClip = (over: Record<string, unknown> = {}): any => ({
  filetype: "text",
  startTime: 0,
  duration: 1000,
  ...over,
});

describe("unitBoundaries", () => {
  it("cuts between graphemes, never inside one", () => {
    // A family emoji is one ZWJ sequence of seven code points and eleven code
    // units. Cutting it anywhere produces a different, unrelated picture.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const line = `a${family}b`;
    expect(unitBoundaries(line, "character")).toEqual([
      1,
      1 + family.length,
      line.length,
    ]);
  });

  it("keeps a surrogate pair whole", () => {
    expect(unitBoundaries("\u{1F600}\u{1F601}", "character")).toEqual([2, 4]);
  });

  it("counts Hangul syllables one at a time", () => {
    expect(unitCount("안녕하세요", "character")).toBe(5);
  });

  it("gives a word its trailing space, so a cut never sits in the gap", () => {
    // "Hello " then "world!" — the space arrives with the word before it.
    expect(unitBoundaries("Hello world!", "word")).toEqual([6, 12]);
  });

  it("splits Korean on its spaces", () => {
    expect(unitBoundaries("안녕하세요 반갑습니다", "word")).toEqual([6, 11]);
  });

  it("splits Japanese, which has no spaces to split on", () => {
    // The whole point of using `Intl.Segmenter` rather than a whitespace regex:
    // a fallback would call this one word and reveal the line in one step.
    expect(unitCount("こんにちは世界", "word")).toBeGreaterThan(1);
  });

  it("treats anything before the first word as part of it", () => {
    expect(unitBoundaries('"quoted" text', "word")).toEqual([9, 13]);
  });

  it("gives a line of punctuation one unit rather than none", () => {
    expect(unitBoundaries("...", "word")).toEqual([3]);
  });

  it("counts a whole line as one unit under `line`, blank ones included", () => {
    expect(unitBoundaries("anything at all", "line")).toEqual([15]);
    // A blank line between paragraphs is a beat the author asked for.
    expect(unitBoundaries("", "line")).toEqual([0]);
  });

  it("gives a blank line no units under `character` or `word`", () => {
    expect(unitBoundaries("", "character")).toEqual([]);
    expect(unitBoundaries("", "word")).toEqual([]);
  });

  it("returns the same array for a repeated question", () => {
    // The cache is what keeps a caption from re-segmenting every line every
    // frame; identity is the only way to observe that it is being used.
    expect(unitBoundaries("cached", "character")).toBe(
      unitBoundaries("cached", "character"),
    );
  });
});

describe("revealPlan", () => {
  it("shows nothing at 0 and everything at 100", () => {
    const lines = ["one", "two"];
    expect(revealPlan(lines, "character", 0)).toEqual([
      { chars: 0, head: null },
      { chars: 0, head: null },
    ]);
    expect(revealPlan(lines, "character", 100)).toEqual([
      { chars: 3, head: null },
      { chars: 3, head: null },
    ]);
  });

  it("counts over the whole block, not per line", () => {
    // Six characters across two lines: at half, three have arrived, which is
    // the whole first line and none of the second. A per-line plan would show
    // half of each and the second line would type at twice the speed.
    expect(revealPlan(["abc", "def"], "character", 50)).toEqual([
      { chars: 3, head: null },
      { chars: 0, head: null },
    ]);
  });

  it("floors to whole units with a hard cut", () => {
    const [line] = revealPlan(["abcde"], "character", 55);
    expect(line).toEqual({ chars: 2, head: null });
  });

  it("cuts only on unit boundaries under `word`", () => {
    // Four words. At 30% the plan is 1.2 words in, so one whole word shows and
    // the fifth of a word does not — a `word` reveal never shows half a word.
    const [line] = revealPlan(["aa bb cc dd"], "word", 30);
    expect(line).toEqual({ chars: 3, head: null });
  });

  it("names the fading unit when a softness is asked for", () => {
    // Five characters, 50% is 2.5 units in: two settled, the third half way
    // through its turn. With `fade: 1` that half is the alpha directly.
    const [line] = revealPlan(["abcde"], "character", 50, 1);
    expect(line).toEqual({ chars: 2, head: { from: 2, to: 3, alpha: 0.5 } });
  });

  it("settles the head early when its fade is shorter than its turn", () => {
    // `fade: 0.25` means a unit reaches full strength a quarter of the way
    // through its turn, so at half way it is already settled and costs no
    // second draw.
    const [line] = revealPlan(["abcde"], "character", 50, 0.25);
    expect(line).toEqual({ chars: 3, head: null });
  });

  it("never names more than one fading unit", () => {
    // The bound the renderer's cost rests on: one extra clipped pass per line,
    // not one per unit in flight.
    for (let progress = 0; progress <= 100; progress += 1) {
      for (const line of revealPlan(["abcdefgh", "ijkl"], "character", progress, 1)) {
        expect(line.head === null || typeof line.head.alpha === "number").toBe(
          true,
        );
      }
    }
  });

  it("clamps an overshooting curve instead of indexing past the text", () => {
    // `overshoot` easing is *supposed* to leave the range between its
    // keyframes, and the curve editor does not clamp what a drag produces.
    expect(revealPlan(["abc"], "character", 140)).toEqual([
      { chars: 3, head: null },
    ]);
    expect(revealPlan(["abc"], "character", -40)).toEqual([
      { chars: 0, head: null },
    ]);
  });

  it("shows an empty block whole rather than dividing by zero", () => {
    expect(revealPlan(["", ""], "character", 0)).toEqual([
      { chars: 0, head: null },
      { chars: 0, head: null },
    ]);
  });

  it("advances one line at a time under `line`", () => {
    expect(revealPlan(["one", "two", "three"], "line", 50)).toEqual([
      { chars: 3, head: null },
      { chars: 0, head: null },
      { chars: 0, head: null },
    ]);
  });

  it("is monotonic in progress", () => {
    const lines = ["the quick brown", "fox jumps"];
    let previous = -1;
    for (let progress = 0; progress <= 100; progress += 1) {
      const shown = revealPlan(lines, "character", progress).reduce(
        (sum, line) => sum + line.chars,
        0,
      );
      expect(shown).toBeGreaterThanOrEqual(previous);
      previous = shown;
    }
    expect(previous).toBe(totalUnits(lines, "character"));
  });
});

describe("revealOf — the read guard", () => {
  it("answers null for a clip with no reveal", () => {
    expect(revealOf(textClip())).toBeNull();
    expect(revealOf(null)).toBeNull();
    expect(revealOf(undefined)).toBeNull();
  });

  it("refuses a unit it does not know", () => {
    expect(revealOf(textClip({ reveal: { unit: "syllable" } }))).toBeNull();
  });

  it("defaults a missing or unreadable number rather than refusing it", () => {
    expect(revealOf(textClip({ reveal: { unit: "word" } }))).toEqual({
      unit: "word",
      progress: DEFAULT_REVEAL_PROGRESS,
    });
    expect(
      revealOf(textClip({ reveal: { unit: "word", progress: NaN, fade: NaN } })),
    ).toEqual({ unit: "word", progress: DEFAULT_REVEAL_PROGRESS });
  });

  it("never throws on a shape it was not expecting", () => {
    for (const reveal of [[], 7, "character", true]) {
      expect(revealOf(textClip({ reveal }))).toBeNull();
    }
  });
});

describe("coerceReveal — the write validator", () => {
  it("refuses what the reader would only have defaulted", () => {
    // The one deliberate asymmetry between the two.
    expect(coerceReveal({ unit: "word", progress: NaN })).toBeNull();
    expect(coerceReveal({ unit: "word", fade: "half" })).toBeNull();
    expect(coerceReveal({ unit: "nope" })).toBeNull();
  });

  it("clamps a number it can read", () => {
    expect(coerceReveal({ unit: "line", progress: 400 })).toEqual({
      unit: "line",
      progress: 100,
    });
  });

  it("deletes a hard cut rather than storing a zero", () => {
    const next = coerceReveal({ unit: "character", fade: 0 });
    expect(next).not.toBeNull();
    expect("fade" in (next as object)).toBe(false);
  });

  it("keeps a softness it was given", () => {
    expect(coerceReveal({ unit: "character", fade: 0.5 })?.fade).toBe(0.5);
  });
});

describe("the small pieces", () => {
  it("coerceRevealUnit matches exactly", () => {
    expect(coerceRevealUnit("word")).toBe("word");
    expect(coerceRevealUnit("Word")).toBeNull();
    expect(coerceRevealUnit(3)).toBeNull();
  });

  it("defaultReveal is inert and freshly allocated", () => {
    expect(defaultReveal("word")).toEqual({
      unit: "word",
      progress: DEFAULT_REVEAL_PROGRESS,
    });
    expect(defaultReveal("word")).not.toBe(defaultReveal("word"));
  });

  it("clampRevealProgress falls back to fully shown, never to hidden", () => {
    // A broken curve must not eat the user's text.
    expect(clampRevealProgress(undefined)).toBe(100);
    expect(clampRevealProgress(Infinity)).toBe(100);
    expect(clampRevealProgress(30)).toBe(30);
  });

  it("sameReveal treats an absent fade and a zero one as the same", () => {
    expect(
      sameReveal(
        { unit: "word", progress: 50 },
        { unit: "word", progress: 50, fade: DEFAULT_REVEAL_FADE },
      ),
    ).toBe(true);
    expect(sameReveal(null, null)).toBe(true);
    expect(sameReveal(null, { unit: "word", progress: 50 })).toBe(false);
    expect(
      sameReveal({ unit: "word", progress: 50 }, { unit: "line", progress: 50 }),
    ).toBe(false);
  });
});
