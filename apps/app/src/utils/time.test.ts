import { describe, it, expect } from "vitest";
import {
  isTimeInRange,
  millisecondsToPx,
  pxToMilliseconds,
  formatSeconds,
} from "./time";

describe("isTimeInRange", () => {
  it("includes the start and excludes the end", () => {
    expect(isTimeInRange(0, 0, 100)).toBe(true);
    expect(isTimeInRange(99, 0, 100)).toBe(true);
    expect(isTimeInRange(100, 0, 100)).toBe(false);
    expect(isTimeInRange(-1, 0, 100)).toBe(false);
  });

  it("is empty when the range has no width", () => {
    // Half-open ranges make back-to-back clips meet without overlapping, which
    // is why a zero-length clip is never visible.
    expect(isTimeInRange(5, 5, 5)).toBe(false);
  });
});

describe("millisecondsToPx / pxToMilliseconds", () => {
  it("round-trips a time through the timeline scale", () => {
    for (const range of [1, 4, 9]) {
      expect(pxToMilliseconds(millisecondsToPx(5000, range), range)).toBe(5000);
    }
  });

  it("scales with the timeline range", () => {
    // Zooming in doubles the pixels a given duration occupies.
    expect(millisecondsToPx(1000, 8)).toBe(millisecondsToPx(1000, 4) * 2);
  });

  it("clamps negative and zero positions to the left edge", () => {
    expect(millisecondsToPx(-1000, 4)).toBe(0);
    expect(millisecondsToPx(0, 4)).toBe(0);
  });

  it("rounds to whole pixels", () => {
    expect(Number.isInteger(millisecondsToPx(1234, 4))).toBe(true);
  });
});

describe("formatSeconds", () => {
  it("splits seconds into minutes and remainder", () => {
    expect(formatSeconds(0)).toBe("0m 0s");
    expect(formatSeconds(59)).toBe("0m 59s");
    expect(formatSeconds(60)).toBe("1m 0s");
    expect(formatSeconds(125)).toBe("2m 5s");
  });
});
