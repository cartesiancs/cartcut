import { describe, it, expect } from "vitest";
import {
  SCRUB_COARSE,
  SCRUB_FINE,
  SCRUB_MAX_STEP_PX,
  SCRUB_THRESHOLD_PX,
  SWEEP_PX,
  beginScrub,
  decimalsFor,
  modifiersOf,
  sweepSpec,
  nudgeValue,
  scrubFactor,
  scrubMove,
  scrubValueOf,
  type ScrubOptions,
  type ScrubState,
} from "./numberScrub";

const NONE = {};

describe("decimalsFor", () => {
  it("counts the places a grid needs", () => {
    expect(decimalsFor(1)).toBe(0);
    expect(decimalsFor(10)).toBe(0);
    expect(decimalsFor(0.1)).toBe(1);
    expect(decimalsFor(0.05)).toBe(2);
    expect(decimalsFor(3.6)).toBe(1);
    expect(decimalsFor(0.015)).toBe(3);
  });

  it("caps a derived step's float noise at four", () => {
    expect(decimalsFor(1 / 300)).toBe(4);
    expect(decimalsFor(1e-7)).toBe(4);
  });

  it("falls back to the scrub default for a step that is not a grid", () => {
    expect(decimalsFor(0)).toBe(2);
    expect(decimalsFor(-1)).toBe(2);
    expect(decimalsFor(Number.NaN)).toBe(2);
  });
});

describe("sweepSpec", () => {
  it("spreads the whole range across the same travel whatever its units", () => {
    for (const [min, max] of [
      [0, 1],
      [0, 100],
      [0, 360],
      [-500, 500],
    ]) {
      const spec = sweepSpec(min, max, 1);
      expect(spec.sensitivity * SWEEP_PX).toBeCloseTo(max - min);
      expect(spec.min).toBe(min);
      expect(spec.max).toBe(max);
    }
  });

  it("snaps to the step and rounds to its places", () => {
    const spec = sweepSpec(0, 1, 0.01);
    expect(spec.step).toBe(0.01);
    expect(spec.decimals).toBe(2);
    expect(sweepSpec(0, 100, 1).decimals).toBe(0);
  });

  it("reaches the ceiling and stops there", () => {
    const spec = sweepSpec(0, 100, 1);
    let state = beginScrub(50, spec);
    state = scrubMove(state, SCRUB_THRESHOLD_PX, NONE, spec);
    for (let i = 0; i < 10; i++) {
      state = scrubMove(state, SCRUB_MAX_STEP_PX, NONE, spec);
    }
    expect(scrubValueOf(state, spec)).toBe(100);
  });

  it("still moves on a range with no width", () => {
    expect(sweepSpec(5, 5, 1).sensitivity).toBeGreaterThan(0);
    expect(sweepSpec(5, 5, 0).sensitivity).toBeGreaterThan(0);
  });
});

/** The defaults `number-input` ships with: 0.3 units a pixel, snapped to tenths. */
const opts = (over: Partial<ScrubOptions> = {}): ScrubOptions => ({
  sensitivity: 0.3,
  step: 0.1,
  ...over,
});

/** Drag `px` in one event, having already engaged. */
function engaged(start: number, options: ScrubOptions): ScrubState {
  // Exactly the threshold engages the drag and spends all of its travel.
  return scrubMove(beginScrub(start), SCRUB_THRESHOLD_PX, NONE, options);
}

describe("scrubFactor", () => {
  it("is 1 unmodified, 10 with shift, 0.1 with meta or control", () => {
    expect(scrubFactor(NONE)).toBe(1);
    expect(scrubFactor({ shift: true })).toBe(SCRUB_COARSE);
    expect(scrubFactor({ meta: true })).toBe(SCRUB_FINE);
    expect(scrubFactor({ ctrl: true })).toBe(SCRUB_FINE);
  });

  it("lets fine beat coarse — holding both asks to slow down", () => {
    expect(scrubFactor({ shift: true, meta: true })).toBe(SCRUB_FINE);
  });

  it("reads a DOM event's modifier flags", () => {
    expect(modifiersOf({ shiftKey: true })).toEqual({
      shift: true,
      meta: false,
      ctrl: false,
    });
  });
});

describe("scrubMove — recognising the drag", () => {
  it("does not engage below the threshold, and shows the starting value", () => {
    const options = opts();
    let state = beginScrub(50);
    for (let i = 0; i < SCRUB_THRESHOLD_PX - 1; i += 1) {
      state = scrubMove(state, 1, NONE, options);
    }
    expect(state.dragging).toBe(false);
    expect(scrubValueOf(state, options)).toBe(50);
  });

  it("returns its input by identity when the pointer did not move", () => {
    const state = beginScrub(50);
    expect(scrubMove(state, 0, NONE, opts())).toBe(state);
    expect(scrubMove(state, NaN, NONE, opts())).toBe(state);
  });

  it("does not jump at the instant it engages", () => {
    const options = opts();
    const state = engaged(50, options);
    expect(state.dragging).toBe(true);
    // The travel that recognised the drag was spent recognising it.
    expect(scrubValueOf(state, options)).toBe(50);
  });

  it("engages on a single large move and keeps only the excess", () => {
    const options = opts();
    const state = scrubMove(beginScrub(0), 104, NONE, options);
    expect(state.dragging).toBe(true);
    expect(scrubValueOf(state, options)).toBe((104 - SCRUB_THRESHOLD_PX) * 0.3);
  });

  it("engages in the negative direction too", () => {
    const options = opts();
    const state = scrubMove(beginScrub(0), -14, NONE, options);
    expect(state.dragging).toBe(true);
    expect(scrubValueOf(state, options)).toBe(-3);
  });
});

describe("scrubMove — accumulation", () => {
  it("does not drift: a hundred small moves equal one big one", () => {
    const options = opts();
    let many = beginScrub(0);
    for (let i = 0; i < 100; i += 1) {
      many = scrubMove(many, 1, NONE, options);
    }
    const once = scrubMove(beginScrub(0), 100, NONE, options);
    expect(scrubValueOf(many, options)).toBe(scrubValueOf(once, options));
  });

  it("clamps one event's travel, so a lock-entry warp cannot fling the value", () => {
    const options = opts({ sensitivity: 1, step: 1 });
    const huge = scrubMove(beginScrub(0), 100000, NONE, options);
    expect(scrubValueOf(huge, options)).toBe(SCRUB_MAX_STEP_PX - SCRUB_THRESHOLD_PX);
  });

  it("leaves no float dust behind the quantizer", () => {
    const options = opts();
    let state = engaged(0, options);
    for (let i = 0; i < 3; i += 1) {
      state = scrubMove(state, 1, NONE, options);
    }
    // 3 * 0.3 = 0.8999999999999999 before rounding.
    expect(scrubValueOf(state, options)).toBe(0.9);
  });
});

describe("scrubMove — modifiers", () => {
  it("multiplies travel by the held modifier", () => {
    const options = opts({ sensitivity: 1, step: 1 });
    const plain = scrubMove(engaged(0, options), 10, NONE, options);
    const coarse = scrubMove(engaged(0, options), 10, { shift: true }, options);
    const fine = scrubMove(engaged(0, options), 100, { meta: true }, options);
    expect(scrubValueOf(plain, options)).toBe(10);
    expect(scrubValueOf(coarse, options)).toBe(100);
    expect(scrubValueOf(fine, options)).toBe(10);
  });

  it("does not rescale travel already made when a modifier is pressed mid-drag", () => {
    const options = opts({ sensitivity: 1, step: 1 });
    let state = engaged(0, options);
    state = scrubMove(state, 10, NONE, options); // 10 units
    state = scrubMove(state, 10, { shift: true }, options); // + 100 units
    expect(scrubValueOf(state, options)).toBe(110);
  });
});

describe("scrubMove — bounds", () => {
  it("clamps the accumulator rather than only the reading", () => {
    const options = opts({ sensitivity: 1, step: 1, min: 0, max: 100 });
    let state = engaged(50, options);
    state = scrubMove(state, 1000, NONE, options); // far past the ceiling
    expect(scrubValueOf(state, options)).toBe(100);

    // No windup: coming back ten pixels comes back ten units.
    state = scrubMove(state, -10, NONE, options);
    expect(scrubValueOf(state, options)).toBe(90);
  });

  it("declines by identity once pinned against a bound", () => {
    const options = opts({ sensitivity: 1, step: 1, max: 100 });
    const pinned = scrubMove(engaged(100, options), 10, NONE, options);
    expect(scrubMove(pinned, 10, NONE, options)).toBe(pinned);
  });

  it("keeps the reading inside the bounds when the snap steps over one", () => {
    const options = opts({ sensitivity: 1, step: 3, min: 0, max: 100 });
    const state = scrubMove(engaged(99, options), 1000, NONE, options);
    expect(scrubValueOf(state, options)).toBeLessThanOrEqual(100);
  });
});

describe("scrubValueOf — quantization", () => {
  it("snaps to the step", () => {
    const state = { startValue: 0, raw: 7.31, armed: 0, dragging: true };
    expect(scrubValueOf(state, opts({ step: 1 }))).toBe(7);
    expect(scrubValueOf(state, opts({ step: 2 }))).toBe(8);
    expect(scrubValueOf(state, opts({ step: 0.1 }))).toBe(7.3);
  });

  it("does not snap at all when the step is zero", () => {
    const state = { startValue: 0, raw: 7.31, armed: 0, dragging: true };
    expect(scrubValueOf(state, opts({ step: 0 }))).toBe(7.31);
  });
});

describe("nudgeValue", () => {
  it("moves by one step, and by the modifier multiple", () => {
    const options = opts({ sensitivity: 1, step: 1, min: 0, max: 100 });
    expect(nudgeValue(10, 1, NONE, options)).toBe(11);
    expect(nudgeValue(10, -1, NONE, options)).toBe(9);
    expect(nudgeValue(10, 1, { shift: true }, options)).toBe(20);
    expect(nudgeValue(10, 1, { meta: true }, options)).toBe(10.1);
  });

  it("respects the bounds", () => {
    const options = opts({ sensitivity: 1, step: 1, min: 0, max: 100 });
    expect(nudgeValue(100, 1, NONE, options)).toBe(100);
    expect(nudgeValue(0, -1, NONE, options)).toBe(0);
  });
});
