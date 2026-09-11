import { describe, expect, it } from "vitest";
import {
  MAX_RANGE,
  MIN_RANGE,
  clampRange,
  maxRangeForFps,
  pinchRange,
  rangeFromSlider,
  sliderFromRange,
} from "./zoom";
import { DEFAULT_FPS, framePx } from "./frames";

/** Every rate the settings panel offers, plus the two ends of the band. */
const RATES = [1, 24, 25, 30, 50, 60, 120, 240];

/**
 * What the ceiling has always encoded: at full zoom a frame is a target you can
 * hit with a mouse. `zoom.ts` states it as 50px; the assertion allows the 40 the
 * original test allowed, so it fails on a change of intent rather than on a
 * change of taste.
 */
const COMFORTABLE_FRAME_PX = 40;

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

describe("maxRangeForFps", () => {
  it("is the 60fps ceiling at 60fps, exactly", () => {
    // The whole parameterisation has to be a no-op for the rate every existing
    // project runs at, or it is a silent change to everyone's timeline.
    expect(maxRangeForFps(DEFAULT_FPS)).toBe(MAX_RANGE);
    expect(rangeFromSlider(1, DEFAULT_FPS)).toBeCloseTo(rangeFromSlider(1), 12);
    expect(clampRange(1e6, DEFAULT_FPS)).toBe(clampRange(1e6));
  });

  it("leaves a frame comfortably wide at every rate", () => {
    for (const fps of RATES) {
      expect(framePx(maxRangeForFps(fps), fps)).toBeGreaterThanOrEqual(
        COMFORTABLE_FRAME_PX,
      );
    }
  });

  it("puts a frame at exactly 50px once the rate passes 60", () => {
    for (const fps of [60, 120, 240]) {
      expect(framePx(maxRangeForFps(fps), fps)).toBeCloseTo(50, 6);
    }
  });

  it("never zooms less far than it used to", () => {
    // Scaling in both directions would put a 30fps ceiling at 30 — still a
    // 50px frame, but strictly less magnification than shipped yesterday, for
    // no gain. The floor is the regression guard.
    for (const fps of RATES) {
      expect(maxRangeForFps(fps)).toBeGreaterThanOrEqual(MAX_RANGE);
    }
  });

  it("rises with the rate, never falls", () => {
    for (let i = 1; i < RATES.length; i++) {
      expect(maxRangeForFps(RATES[i])).toBeGreaterThanOrEqual(
        maxRangeForFps(RATES[i - 1]),
      );
    }
  });

  it("guards an unusable rate", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(maxRangeForFps(bad)).toBe(MAX_RANGE);
    }
  });
});

describe("the slider mapping, at every rate", () => {
  it("spans floor to that rate's ceiling", () => {
    for (const fps of RATES) {
      expect(rangeFromSlider(0, fps)).toBeCloseTo(MIN_RANGE, 12);
      expect(rangeFromSlider(1, fps)).toBeCloseTo(maxRangeForFps(fps), 9);
    }
  });

  it("round-trips", () => {
    for (const fps of RATES) {
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        expect(sliderFromRange(rangeFromSlider(t, fps), fps)).toBeCloseTo(t, 9);
      }
    }
  });

  it("keeps a constant ratio of magnification per unit of travel", () => {
    // The reason the curve is exponential rather than logistic; raising the
    // ceiling must not pile the useful range into the last few percent.
    for (const fps of RATES) {
      const steps = 50;
      const ratios: number[] = [];
      for (let i = 0; i < steps; i++) {
        ratios.push(
          rangeFromSlider((i + 1) / steps, fps) / rangeFromSlider(i / steps, fps),
        );
      }
      for (const ratio of ratios) {
        expect(ratio).toBeCloseTo(ratios[0], 9);
      }
    }
  });
});

describe("clampRange, when the project rate changes", () => {
  it("pulls a range back under a lowered ceiling", () => {
    // 120 -> 30 is the case that matters: the timeline was zoomed to the top of
    // a 120fps slider and the project is now 30fps, whose slider ends at 60.
    const zoomedIn = maxRangeForFps(120);
    expect(clampRange(zoomedIn, 120)).toBe(zoomedIn);
    expect(clampRange(zoomedIn, 30)).toBe(maxRangeForFps(30));
  });

  it("leaves a range that is still in bounds alone", () => {
    for (const fps of RATES) {
      expect(clampRange(20, fps)).toBe(20);
    }
  });

  it("keeps the floor and the garbage handling at every rate", () => {
    for (const fps of RATES) {
      expect(clampRange(-1, fps)).toBe(MIN_RANGE);
      expect(clampRange(NaN, fps)).toBe(MIN_RANGE);
      expect(clampRange(Infinity, fps)).toBe(maxRangeForFps(fps));
      expect(clampRange(-Infinity, fps)).toBe(MIN_RANGE);
    }
  });
});

describe("pinchRange", () => {
  it("zooms in on a spread and out on a pinch", () => {
    expect(pinchRange(10, -5)).toBeGreaterThan(10);
    expect(pinchRange(10, 5)).toBeLessThan(10);
  });

  it("magnifies by a constant ratio, whatever the current range", () => {
    expect(pinchRange(2, -3) / 2).toBeCloseTo(pinchRange(20, -3) / 20, 12);
  });

  it("leaves the range alone on a zero delta", () => {
    expect(pinchRange(7, 0)).toBe(7);
  });

  it("stays inside the bounds for the project's rate", () => {
    expect(pinchRange(maxRangeForFps(120), -500, 120)).toBe(
      maxRangeForFps(120),
    );
    expect(pinchRange(MIN_RANGE, 500)).toBe(MIN_RANGE);
  });
});
