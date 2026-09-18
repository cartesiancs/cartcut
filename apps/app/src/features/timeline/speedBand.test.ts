/**
 * The band drawn over a ramped clip.
 *
 * Its whole job is to be a picture of what will play, so the assertions are
 * about agreement with `speedAt` rather than about pixels: where the curve is
 * above the 1x line, the clip is running fast.
 */

import { describe, expect, it } from "vitest";
import { BAND_FRACTION, hasSpeedRamp, speedPolyline } from "./speedBand";
import { withSpeedCurve } from "./clipEdit";
import { spanLength, spanStart, speedAt } from "./geometry";
import { videoElement, imageElement } from "../renderer/testing";

const RECT = { x: 40, y: 10, w: 200, h: 60 };

function ramped(points: Array<{ t: number; v: number }>) {
  return withSpeedCurve(
    videoElement({
      trackId: "v1",
      startTime: 0,
      duration: 10_000,
      sourceDuration: 10_000,
      trim: { startTime: 0, endTime: 10_000 },
      speed: 1,
    }),
    points,
  );
}

describe("hasSpeedRamp", () => {
  it("is false for everything that plays at a constant rate", () => {
    expect(hasSpeedRamp(videoElement({}))).toBe(false);
    expect(hasSpeedRamp(videoElement({ speed: 2 }))).toBe(false);
    expect(hasSpeedRamp(imageElement({}))).toBe(false);
  });

  it("is true for a ramp", () => {
    expect(
      hasSpeedRamp(
        ramped([
          { t: 0, v: 1 },
          { t: 10_000, v: 2 },
        ]),
      ),
    ).toBe(true);
  });
});

describe("speedPolyline", () => {
  const element = ramped([
    { t: 0, v: 0.5 },
    { t: 10_000, v: 4 },
  ]);

  it("draws nothing for a clip with no ramp, so the timeline is unchanged", () => {
    expect(speedPolyline(RECT, videoElement({ speed: 2 }), 10, 1000).points).toEqual(
      [],
    );
  });

  it("spans the clip, clipped to the viewport", () => {
    const { points } = speedPolyline(RECT, element, 10, 1000);
    expect(points[0].x).toBe(RECT.x);
    expect(points[points.length - 1].x).toBe(RECT.x + RECT.w);

    const clipped = speedPolyline(RECT, element, 10, 100);
    expect(clipped.points[clipped.points.length - 1].x).toBeLessThanOrEqual(100);
  });

  it("stays inside the band", () => {
    const { points } = speedPolyline(RECT, element, 10, 1000);
    const height = RECT.h * BAND_FRACTION;
    const top = RECT.y + (RECT.h - height) / 2;
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(top - 1e-9);
      expect(point.y).toBeLessThanOrEqual(top + height + 1e-9);
    }
  });

  it("puts the curve above the 1x line exactly where the clip is running fast", () => {
    const { points, unityY } = speedPolyline(RECT, element, 10, 1000);
    const start = spanStart(element);
    const msPerPx = spanLength(element) / RECT.w;
    for (const point of points) {
      const rate = speedAt(element, start + (point.x - RECT.x) * msPerPx);
      if (rate > 1.001) {
        // Canvas y grows downwards, so faster is a smaller y.
        expect(point.y).toBeLessThan(unityY);
      } else if (rate < 0.999) {
        expect(point.y).toBeGreaterThan(unityY);
      }
    }
  });

  it("puts 1x in the middle of the band, wherever the clip sits", () => {
    const { unityY } = speedPolyline(RECT, element, 10, 1000);
    expect(unityY).toBeCloseTo(RECT.y + RECT.h / 2, 9);
  });

  it("gives a halving and a doubling the same distance from 1x", () => {
    const half = ramped([
      { t: 0, v: 0.5 },
      { t: 10_000, v: 0.5000001 },
    ]);
    const twice = ramped([
      { t: 0, v: 2 },
      { t: 10_000, v: 2.0000001 },
    ]);
    const low = speedPolyline(RECT, half, 10, 1000);
    const high = speedPolyline(RECT, twice, 10, 1000);
    expect(low.points[0].y - low.unityY).toBeCloseTo(
      high.unityY - high.points[0].y,
      6,
    );
  });

  it("declines a clip with no width rather than dividing by it", () => {
    expect(speedPolyline({ ...RECT, w: 0 }, element, 10, 1000).points).toEqual([]);
  });
});
