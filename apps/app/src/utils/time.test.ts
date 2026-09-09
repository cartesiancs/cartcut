import { describe, it, expect } from "vitest";
import {
  isTimeInRange,
  maxTimelineScroll,
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

describe("maxTimelineScroll", () => {
  it("stops where the viewport's right edge meets the end of the project", () => {
    // Not `millisecondsToPx(duration)` — that is where the *left* edge would
    // sit, a full viewport past the last frame, showing nothing.
    const range = 4;
    const contentPx = millisecondsToPx(10_000, range);
    expect(maxTimelineScroll(10_000, range, 500)).toBe(contentPx - 500);
  });

  it("is zero when the project already fits", () => {
    const range = 4;
    const contentPx = millisecondsToPx(10_000, range);
    expect(maxTimelineScroll(10_000, range, contentPx)).toBe(0);
    expect(maxTimelineScroll(10_000, range, contentPx + 1000)).toBe(0);
    expect(maxTimelineScroll(0, range, 500)).toBe(0);
  });

  it("agrees with the scrollbar thumb the bottom bar draws", () => {
    // The bar sizes its thumb as `viewport / content` of the track. So the
    // fraction of the track left for the thumb to travel has to equal the
    // fraction of the content that can be scrolled, or the thumb reaches the
    // right edge before — or after — the scroll reaches its end.
    const range = 9;
    const durationMs = 30_000;
    const viewport = 700;
    const contentPx = millisecondsToPx(durationMs, range);

    const thumbFraction = viewport / contentPx;
    const travelFraction = 1 - thumbFraction;

    expect(maxTimelineScroll(durationMs, range, viewport) / contentPx).toBeCloseTo(
      travelFraction,
      10,
    );
  });

  it("grows as the timeline is zoomed in", () => {
    expect(maxTimelineScroll(10_000, 8, 500)).toBeGreaterThan(
      maxTimelineScroll(10_000, 4, 500),
    );
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
