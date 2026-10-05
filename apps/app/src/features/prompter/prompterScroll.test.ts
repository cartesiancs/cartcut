import { describe, expect, it } from "vitest";

import {
  BASE_LINES_PER_SECOND,
  DEFAULT_PROMPTER_SPEED,
  MAX_FRAME_MS,
  MAX_PROMPTER_SPEED,
  MIN_PROMPTER_SPEED,
  advance,
  clampOffset,
  coerceSpeed,
  maxOffset,
  nudge,
  stepSpeed,
} from "./prompterScroll";

describe("coerceSpeed", () => {
  it("keeps a speed in range, to one decimal", () => {
    expect(coerceSpeed(1.5)).toBe(1.5);
    expect(coerceSpeed(1.2999999)).toBe(1.3);
  });

  it("clamps to the bounds rather than refusing", () => {
    expect(coerceSpeed(0)).toBe(MIN_PROMPTER_SPEED);
    expect(coerceSpeed(99)).toBe(MAX_PROMPTER_SPEED);
  });

  it("falls back to the default for anything that is not a number", () => {
    expect(coerceSpeed(Number.NaN)).toBe(DEFAULT_PROMPTER_SPEED);
    expect(coerceSpeed(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PROMPTER_SPEED);
    expect(coerceSpeed("2")).toBe(DEFAULT_PROMPTER_SPEED);
    expect(coerceSpeed(null)).toBe(DEFAULT_PROMPTER_SPEED);
    expect(coerceSpeed(undefined)).toBe(DEFAULT_PROMPTER_SPEED);
  });
});

describe("stepSpeed", () => {
  it("moves by a tenth without floating-point drift", () => {
    let speed = DEFAULT_PROMPTER_SPEED;
    for (let i = 0; i < 7; i += 1) {
      speed = stepSpeed(speed, 1);
    }
    expect(speed).toBe(1.7);
    expect(stepSpeed(0.3, 1)).toBe(0.4);
    expect(stepSpeed(1, -1)).toBe(0.9);
  });

  it("declines at either bound by returning the speed it was given", () => {
    expect(stepSpeed(MIN_PROMPTER_SPEED, -1)).toBe(MIN_PROMPTER_SPEED);
    expect(stepSpeed(MAX_PROMPTER_SPEED, 1)).toBe(MAX_PROMPTER_SPEED);
  });
});

describe("maxOffset", () => {
  it("is how much taller the text is than the stage", () => {
    expect(maxOffset(1500, 400)).toBe(1100);
  });

  it("is zero, never negative, when the text fits", () => {
    expect(maxOffset(300, 400)).toBe(0);
  });
});

describe("clampOffset", () => {
  it("keeps the offset inside [0, max]", () => {
    expect(clampOffset(-5, 100)).toBe(0);
    expect(clampOffset(50, 100)).toBe(50);
    expect(clampOffset(150, 100)).toBe(100);
  });

  it("reads a negative max as zero", () => {
    expect(clampOffset(10, -20)).toBe(0);
  });
});

describe("advance", () => {
  const line = 40;

  it("moves BASE_LINES_PER_SECOND lines a second at 1.0x", () => {
    // Ten 100ms frames make one second.
    let offset = 0;
    for (let i = 0; i < 10; i += 1) {
      offset = advance(offset, 100, 1, line, 10_000);
    }
    expect(offset).toBeCloseTo(BASE_LINES_PER_SECOND * line, 9);
  });

  it("moves exactly twice as far at 2.0x", () => {
    const one = advance(0, 50, 1, line, 10_000);
    const two = advance(0, 50, 2, line, 10_000);
    expect(two).toBeCloseTo(one * 2, 9);
    expect(one).toBeGreaterThan(0);
  });

  it("scales with the line, so a wider window reads the same words a second", () => {
    const narrow = advance(0, 50, 1, 30, 10_000);
    const wide = advance(0, 50, 1, 60, 10_000);
    expect(wide / narrow).toBeCloseTo(2, 9);
  });

  it("accounts for no more than MAX_FRAME_MS of a stalled frame", () => {
    const stalled = advance(0, 5_000, 1, line, 10_000);
    const capped = advance(0, MAX_FRAME_MS, 1, line, 10_000);
    expect(stalled).toBe(capped);
  });

  it("never moves backwards on a clock that went back", () => {
    expect(advance(30, -16, 1, line, 10_000)).toBe(30);
  });

  it("stops at the end", () => {
    expect(advance(99.9, 100, 3, line, 100)).toBe(100);
  });
});

describe("nudge", () => {
  it("moves by the wheel's delta, inside the bounds", () => {
    expect(nudge(100, 30, 500)).toBe(130);
    expect(nudge(100, -300, 500)).toBe(0);
    expect(nudge(480, 100, 500)).toBe(500);
  });
});
