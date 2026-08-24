import { describe, expect, it } from "vitest";
import {
  MAX_RANGE,
  MIN_RANGE,
  clampRange,
  rangeFromSlider,
  sliderFromRange,
} from "./zoom";
import { framePx } from "./frames";

/** The mapping this replaces, kept here to pin what must not change. */
const legacyRange = (logit: number) => (1 / (1 + Math.E ** -logit)) * 10;

describe("rangeFromSlider", () => {
  it("spans exactly the declared bounds", () => {
    expect(rangeFromSlider(0)).toBeCloseTo(MIN_RANGE, 12);
    expect(rangeFromSlider(1)).toBeCloseTo(MAX_RANGE, 9);
  });

  it("keeps the old zoom-out floor", () => {
    // Zooming out must behave exactly as before; only the top end moved.
    expect(rangeFromSlider(0)).toBeCloseTo(legacyRange(-8), 12);
  });

  it("increases monotonically", () => {
    let previous = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const range = rangeFromSlider(i / 1000);
      expect(range).toBeGreaterThan(previous);
      previous = range;
    }
  });

  it("magnifies by a constant ratio per unit of travel", () => {
    // What an exponential buys over the sigmoid it replaces: the far end of the
    // slider is as usable as the near end. Under `sigmoid(x) * 10` the last
    // tenth of travel changed the range by almost nothing.
    // Integer steps, not an accumulating float: `t += 0.1` never lands on 1.0
    // and the final ratio would compare a clamped value against itself.
    const steps = 10;
    const ratios: number[] = [];
    for (let i = 0; i < steps; i++) {
      ratios.push(rangeFromSlider((i + 1) / steps) / rangeFromSlider(i / steps));
    }
    for (const ratio of ratios) {
      expect(ratio).toBeCloseTo(ratios[0], 6);
    }
  });

  it("clamps a slider position outside its track", () => {
    expect(rangeFromSlider(-1)).toBeCloseTo(MIN_RANGE, 12);
    expect(rangeFromSlider(2)).toBeCloseTo(MAX_RANGE, 9);
    expect(rangeFromSlider(NaN)).toBeCloseTo(MIN_RANGE, 12);
  });
});

describe("sliderFromRange", () => {
  it("inverts rangeFromSlider", () => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      expect(sliderFromRange(rangeFromSlider(t))).toBeCloseTo(t, 9);
    }
  });

  it("handles the bounds and nonsense", () => {
    expect(sliderFromRange(MIN_RANGE)).toBeCloseTo(0, 9);
    expect(sliderFromRange(MAX_RANGE)).toBeCloseTo(1, 9);
    expect(sliderFromRange(0)).toBe(0);
    expect(sliderFromRange(-5)).toBe(0);
    expect(sliderFromRange(NaN)).toBe(0);
    expect(sliderFromRange(1e6)).toBe(1);
  });
});

describe("clampRange", () => {
  it("holds the bounds", () => {
    expect(clampRange(1)).toBe(1);
    expect(clampRange(MAX_RANGE + 100)).toBe(MAX_RANGE);
    expect(clampRange(-1)).toBe(MIN_RANGE);
    expect(clampRange(0)).toBe(MIN_RANGE);
  });

  it("recovers from a non-finite range", () => {
    // The ctrl+wheel handler could previously drive `range` anywhere, because
    // it compared a range against the slider's logit bounds.
    expect(clampRange(NaN)).toBe(MIN_RANGE);
    expect(clampRange(Infinity)).toBe(MAX_RANGE);
    expect(clampRange(-Infinity)).toBe(MIN_RANGE);
  });
});

describe("the ceiling exists for frame editing", () => {
  it("gives a 60fps frame a comfortable target at full zoom", () => {
    // The old ceiling of ~9.93 left a frame 8.3px wide, which is the whole
    // reason the mapping changed. If `MAX_RANGE` is ever lowered, this says why.
    expect(framePx(MAX_RANGE, 60)).toBeGreaterThanOrEqual(40);
    expect(framePx(legacyRange(5), 60)).toBeLessThan(9);
  });
});

describe("the slider's static default", () => {
  it("matches the store's initial range", () => {
    // `elementTimelineRange` renders `value="0.571"` before the store has
    // pushed anything, and `timelineStore` starts at `range: 0.9`. If they
    // disagree the thumb jumps on the first zoom.
    expect(sliderFromRange(0.9)).toBeCloseTo(0.571, 3);
  });
});
