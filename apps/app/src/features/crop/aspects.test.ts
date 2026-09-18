import { describe, it, expect } from "vitest";
import { centreOf, CROP_ASPECTS, ratioOf, rectOfAspect } from "./aspects";
import { FULL_CROP, MIN_CROP } from "../timeline/cropOps";
import type { CropRect } from "../../@types/timeline";

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

const SQUARE = { width: 100, height: 100 };
const WIDE = { width: 1920, height: 1080 };
const TALL = { width: 1080, height: 1920 };
const CENTRE = { x: 0.5, y: 0.5 };

describe("CROP_ASPECTS", () => {
  it("leads with Free and Original, which are not ratios", () => {
    expect(CROP_ASPECTS[0].id).toBe("free");
    expect(CROP_ASPECTS[0].ratio).toBeNull();
    expect(CROP_ASPECTS[1].id).toBe("original");
    expect(CROP_ASPECTS[1].ratio).toBe("frame");
  });

  it("has unique ids and a label for each", () => {
    const ids = CROP_ASPECTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const aspect of CROP_ASPECTS) {
      expect(aspect.label, aspect.id).toBeTruthy();
    }
  });

  it("states every numeric ratio as a positive number", () => {
    for (const aspect of CROP_ASPECTS) {
      if (typeof aspect.ratio === "number") {
        expect(aspect.ratio, aspect.id).toBeGreaterThan(0);
        expect(Number.isFinite(aspect.ratio)).toBe(true);
      }
    }
  });

  it("pairs each landscape ratio with its portrait inverse", () => {
    const byId = Object.fromEntries(CROP_ASPECTS.map((a) => [a.id, a.ratio]));
    expect((byId["16:9"] as number) * (byId["9:16"] as number)).toBeCloseTo(1, 12);
    expect((byId["4:3"] as number) * (byId["3:4"] as number)).toBeCloseTo(1, 12);
  });
});

describe("ratioOf", () => {
  it("is null for Free", () => {
    expect(ratioOf(CROP_ASPECTS[0], WIDE)).toBeNull();
    expect(ratioOf(null, WIDE)).toBeNull();
    expect(ratioOf(undefined, WIDE)).toBeNull();
  });

  it("reads Original off the frame rather than off the source file", () => {
    expect(ratioOf(CROP_ASPECTS[1], WIDE)).toBeCloseTo(16 / 9, 12);
    expect(ratioOf(CROP_ASPECTS[1], TALL)).toBeCloseTo(9 / 16, 12);
    // A clip the user has stretched: Original follows what is on screen.
    expect(ratioOf(CROP_ASPECTS[1], { width: 300, height: 100 })).toBeCloseTo(3, 12);
  });

  it("is null for Original on a frame with no shape", () => {
    expect(ratioOf(CROP_ASPECTS[1], { width: 0, height: 100 })).toBeNull();
    expect(ratioOf(CROP_ASPECTS[1], { width: 100, height: 0 })).toBeNull();
  });

  it("passes a numeric ratio through", () => {
    const square = CROP_ASPECTS.find((a) => a.id === "1:1")!;
    expect(ratioOf(square, WIDE)).toBe(1);
  });
});

describe("rectOfAspect", () => {
  it("returns the whole frame for Original, at any frame shape", () => {
    for (const frame of [SQUARE, WIDE, TALL, { width: 300, height: 100 }]) {
      const ratio = ratioOf(CROP_ASPECTS[1], frame)!;
      const out = rectOfAspect(ratio, frame, CENTRE);
      expect(out.width, JSON.stringify(frame)).toBeCloseTo(1, 9);
      expect(out.height).toBeCloseTo(1, 9);
      expect(out.x).toBeCloseTo(0, 9);
      expect(out.y).toBeCloseTo(0, 9);
    }
  });

  it("gives the largest rect of that drawn ratio that fits", () => {
    for (const frame of [SQUARE, WIDE, TALL]) {
      for (const aspect of CROP_ASPECTS) {
        const ratio = ratioOf(aspect, frame);
        if (ratio == null) continue;
        const out = rectOfAspect(ratio, frame, CENTRE);

        const drawn = (out.width * frame.width) / (out.height * frame.height);
        expect(drawn, `${aspect.id} on ${frame.width}x${frame.height}`).toBeCloseTo(
          ratio,
          6,
        );
        // Largest: one side is flush against the frame.
        expect(Math.max(out.width, out.height)).toBeCloseTo(1, 9);
        expect(out.width).toBeLessThanOrEqual(1 + 1e-12);
        expect(out.height).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it("centres on the point it is given", () => {
    const out = rectOfAspect(1, SQUARE, { x: 0.5, y: 0.5 });
    expect(out.x + out.width / 2).toBeCloseTo(0.5, 9);
    expect(out.y + out.height / 2).toBeCloseTo(0.5, 9);
  });

  it("slides back inside the frame rather than hanging over an edge", () => {
    const out = rectOfAspect(1, { width: 200, height: 100 }, { x: 0.95, y: 0.5 });
    // A drawn 1:1 on a 2:1 frame is half the frame wide, so a centre at 0.95
    // is unreachable and the rect rests against the right edge.
    expect(out.width).toBeCloseTo(0.5, 9);
    expect(out.x).toBeCloseTo(0.5, 9);
    expect(out.x + out.width).toBeCloseTo(1, 9);
  });

  it("stays inside the frame for every preset at every corner", () => {
    for (const frame of [SQUARE, WIDE, TALL]) {
      for (const aspect of CROP_ASPECTS) {
        const ratio = ratioOf(aspect, frame);
        if (ratio == null) continue;
        for (const centre of [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
          { x: 1, y: 0 },
          { x: -5, y: 5 },
        ]) {
          const out = rectOfAspect(ratio, frame, centre);
          const where = `${aspect.id} @ ${JSON.stringify(centre)}`;
          expect(out.x, where).toBeGreaterThanOrEqual(-1e-12);
          expect(out.y, where).toBeGreaterThanOrEqual(-1e-12);
          expect(out.x + out.width, where).toBeLessThanOrEqual(1 + 1e-9);
          expect(out.y + out.height, where).toBeLessThanOrEqual(1 + 1e-9);
          expect(out.width).toBeGreaterThanOrEqual(MIN_CROP);
          expect(out.height).toBeGreaterThanOrEqual(MIN_CROP);
        }
      }
    }
  });

  it("falls back to the whole frame for a ratio that is not one", () => {
    for (const bad of [null, 0, -1, NaN, Infinity]) {
      expect(rectOfAspect(bad as any, SQUARE, CENTRE)).toEqual(FULL_CROP);
    }
  });

  it("falls back to the whole frame when the frame has no shape", () => {
    expect(rectOfAspect(1, { width: 0, height: 100 }, CENTRE)).toEqual(FULL_CROP);
  });
});

describe("centreOf", () => {
  it("is the middle of the rectangle", () => {
    expect(centreOf(rect(0.2, 0.4, 0.4, 0.2))).toEqual({ x: 0.4, y: 0.5 });
    expect(centreOf(FULL_CROP)).toEqual({ x: 0.5, y: 0.5 });
  });
});
