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
  MAX_REVEAL_WINDOW,
  animateOf,
  clampRevealProgress,
  coerceReveal,
  coerceRevealAnimate,
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
      { chars: 0, heads: [] },
      { chars: 0, heads: [] },
    ]);
    expect(revealPlan(lines, "character", 100)).toEqual([
      { chars: 3, heads: [] },
      { chars: 3, heads: [] },
    ]);
  });

  it("counts over the whole block, not per line", () => {
    // Six characters across two lines: at half, three have arrived, which is
    // the whole first line and none of the second. A per-line plan would show
    // half of each and the second line would type at twice the speed.
    expect(revealPlan(["abc", "def"], "character", 50)).toEqual([
      { chars: 3, heads: [] },
      { chars: 0, heads: [] },
    ]);
  });

  it("floors to whole units with a hard cut", () => {
    const [line] = revealPlan(["abcde"], "character", 55);
    expect(line).toEqual({ chars: 2, heads: [] });
  });

  it("cuts only on unit boundaries under `word`", () => {
    // Four words. At 30% the plan is 1.2 words in, so one whole word shows and
    // the fifth of a word does not — a `word` reveal never shows half a word.
    const [line] = revealPlan(["aa bb cc dd"], "word", 30);
    expect(line).toEqual({ chars: 3, heads: [] });
  });

  it("names the fading unit when a softness is asked for", () => {
    // Five characters, 50% is 2.5 units in: two settled, the third half way
    // through its turn. With `fade: 1` that half is the alpha directly.
    const [line] = revealPlan(["abcde"], "character", 50, 1);
    expect(line.chars).toBe(2);
    expect(line.heads).toHaveLength(1);
    expect(line.heads[0]).toMatchObject({ from: 2, to: 3, alpha: 0.5 });
    // No animator, so nothing moves — only the alpha differs from settled.
    expect(line.heads[0].move).toBeNull();
  });

  it("settles the head early when its fade is shorter than its turn", () => {
    // `fade: 0.25` means a unit reaches full strength a quarter of the way
    // through its turn, so at half way it is already settled and costs no
    // second draw.
    const [line] = revealPlan(["abcde"], "character", 50, 0.25);
    expect(line).toEqual({ chars: 3, heads: [] });
  });

  it("never names more than one fading unit without an animator", () => {
    // The bound the renderer's cost rests on: one extra clipped pass per line,
    // not one per unit in flight. `animate.window` is the only thing that
    // lifts it, and it says what it costs.
    for (let progress = 0; progress <= 100; progress += 1) {
      for (const line of revealPlan(
        ["abcdefgh", "ijkl"],
        "character",
        progress,
        1,
      )) {
        expect(line.heads.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("clamps an overshooting curve instead of indexing past the text", () => {
    // `overshoot` easing is *supposed* to leave the range between its
    // keyframes, and the curve editor does not clamp what a drag produces.
    expect(revealPlan(["abc"], "character", 140)).toEqual([
      { chars: 3, heads: [] },
    ]);
    expect(revealPlan(["abc"], "character", -40)).toEqual([
      { chars: 0, heads: [] },
    ]);
  });

  it("shows an empty block whole rather than dividing by zero", () => {
    expect(revealPlan(["", ""], "character", 0)).toEqual([
      { chars: 0, heads: [] },
      { chars: 0, heads: [] },
    ]);
  });

  it("advances one line at a time under `line`", () => {
    expect(revealPlan(["one", "two", "three"], "line", 50)).toEqual([
      { chars: 3, heads: [] },
      { chars: 0, heads: [] },
      { chars: 0, heads: [] },
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


/**
 * The text animator.
 *
 * It is `reveal` with a movement attached rather than a second feature, so the
 * claim that matters most is the one about what it does *not* change: a reveal
 * with no animator plans exactly what it planned before. Everything else is
 * built on top of the same scalar, the same units and the same keyframe track.
 */
describe("animateOf", () => {
  it("answers null for an animator that would move nothing", () => {
    // Not a no-op object: `null` is what keeps a clip carrying `{}` on the same
    // drawing path as one carrying nothing.
    expect(animateOf(null)).toBeNull();
    expect(animateOf({})).toBeNull();
    expect(animateOf({ scale: 100, offsetX: 0, blur: 0, opacity: 0 })).toBeNull();
    // A window on its own moves nothing either — it says how long, not what.
    expect(animateOf({ window: 3 })).toBeNull();
  });

  it("reads an animator that does move something", () => {
    expect(animateOf({ scale: 140 })).toMatchObject({ scale: 140, window: 0 });
    expect(animateOf({ opacity: 100 })).toMatchObject({ opacity: 100 });
  });

  it("never throws on a hand-edited file", () => {
    for (const junk of [3, "yes", [], { scale: "big" }, { window: NaN }]) {
      expect(() => animateOf(junk)).not.toThrow();
    }
  });

  it("caps the window, so a long caption cannot ask for fifty", () => {
    expect(animateOf({ scale: 140, window: 99 })?.window).toBe(MAX_REVEAL_WINDOW);
  });
});

describe("coerceRevealAnimate", () => {
  it("drops a field it cannot read rather than defaulting it", () => {
    expect(coerceRevealAnimate({ scale: 140, offsetY: "down" })).toEqual({
      scale: 140,
    });
  });

  it("refuses an easing that is not one", () => {
    expect(coerceRevealAnimate({ scale: 140, easing: "swoosh" })).toEqual({
      scale: 140,
    });
    expect(coerceRevealAnimate({ scale: 140, easing: "ease_out" })).toEqual({
      scale: 140,
      easing: "ease_out",
    });
  });

  it("answers null for an animator with nothing in it, so the key is deleted", () => {
    expect(coerceRevealAnimate({})).toBeNull();
    expect(coerceRevealAnimate({ window: 2 })).toBeNull();
  });
});

describe("revealPlan with an animator", () => {
  const POP = { scale: 150, offsetY: 20, window: 1 };

  it("plans exactly what it planned before when there is none", () => {
    // The claim the whole design rests on. Handed the same arguments with and
    // without a `null` animator, the two must agree to the field.
    for (let progress = 0; progress <= 100; progress += 7) {
      for (const fade of [0, 0.25, 1]) {
        expect(
          revealPlan(["one two", "three"], "word", progress, fade, null),
        ).toEqual(revealPlan(["one two", "three"], "word", progress, fade));
      }
    }
  });

  it("puts several units in flight at once", () => {
    // The bound `fade` documents is lifted here and nowhere else.
    const [line] = revealPlan(["abcdef"], "character", 50, 0, {
      ...POP,
      window: 3,
    });
    expect(line.heads.length).toBeGreaterThan(1);
  });

  it("orders the heads earliest first, each further along than the next", () => {
    const [line] = revealPlan(["abcdef"], "character", 60, 0, {
      ...POP,
      window: 3,
    });
    for (let i = 1; i < line.heads.length; i += 1) {
      expect(line.heads[i].from).toBeGreaterThanOrEqual(line.heads[i - 1].to);
      // The earlier unit arrived first, so it has settled further.
      expect(line.heads[i].t).toBeLessThan(line.heads[i - 1].t);
    }
  });

  it("starts a unit at the animator's values and settles it at the clip's", () => {
    // 3% of six characters is 0.18 units in: the first is barely under way.
    const heads = revealPlan(["abcdef"], "character", 3, 0, {
      scale: 150,
      offsetY: 20,
      window: 1,
    })[0].heads;

    // The last head is the newest arrival, so the least settled.
    const arriving = heads[heads.length - 1];
    expect(arriving.t).toBeLessThan(0.2);
    expect(arriving.move!.scale).toBeGreaterThan(1.3);
    expect(arriving.move!.offsetY).toBeGreaterThan(15);
  });

  it("settles to exactly the clip's own state", () => {
    // A finished reveal must be byte-identical in the picture to one that
    // never had an animator, or a static frame would depend on the feature.
    const plan = revealPlan(["abcdef"], "character", 100, 0, POP);
    expect(plan[0]).toEqual({ chars: 6, heads: [] });
  });

  it("fades a unit in from the animator's opacity", () => {
    const at = (opacity: number) =>
      revealPlan(["abcdef"], "character", 20, 0, { ...POP, opacity })[0]
        .heads[0].alpha;

    // Starting at full opacity means no fade at all; starting at zero fades in.
    expect(at(100)).toBeCloseTo(1, 5);
    expect(at(0)).toBeLessThan(1);
  });

  it("shapes the travel with the easing it is given", () => {
    const t = (easing?: string) =>
      revealPlan(["abcdef"], "character", 25, 0, { ...POP, window: 2, easing })[0]
        .heads[0].t;

    // Handed different curves the two must disagree, or this suite would pass
    // against a plan that ignored `easing`.
    expect(t("ease_out")).toBeGreaterThan(t());
    expect(t("ease_in")).toBeLessThan(t());
  });

  it("never lets an overshooting easing produce a negative blur", () => {
    // The canvas throws on one, which in a paint loop is a blank frame.
    for (let progress = 0; progress <= 100; progress += 1) {
      for (const line of revealPlan(["abcdef"], "character", progress, 0, {
        blur: 8,
        window: 2,
        easing: "overshoot",
      })) {
        for (const head of line.heads) {
          expect(head.move!.blur).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("carries the animator through the read and write guards", () => {
    const stored = coerceReveal({
      unit: "word",
      progress: 0,
      animate: { scale: 140, window: 2 },
    });
    expect(stored?.animate).toEqual({ scale: 140, window: 2 });
    expect(revealOf({ reveal: stored } as any)?.animate).toEqual({
      scale: 140,
      window: 2,
    });
  });

  it("tells two animators apart, and two spellings of one apart", () => {
    const base = { unit: "word" as const, progress: 50 };
    expect(
      sameReveal(
        { ...base, animate: { scale: 140 } },
        { ...base, animate: { scale: 140, offsetX: 0 } },
      ),
    ).toBe(true);
    expect(
      sameReveal(
        { ...base, animate: { scale: 140 } },
        { ...base, animate: { scale: 150 } },
      ),
    ).toBe(false);
    expect(sameReveal({ ...base }, { ...base, animate: { scale: 140 } })).toBe(
      false,
    );
  });
});
