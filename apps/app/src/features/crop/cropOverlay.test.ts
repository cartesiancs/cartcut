import { describe, it, expect } from "vitest";
import {
  cropHandlePoints,
  CROP_CURSORS,
  CROP_HANDLE_ZONES,
  CROP_THIRDS,
  frameOfLocal,
  grabOf,
  localOfFrame,
  localRectOfFrame,
} from "./cropOverlay";
import { FULL_CROP } from "../timeline/cropOps";
import type { CropRect } from "../../@types/timeline";

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

describe("localOfFrame and frameOfLocal", () => {
  it("map the frame onto the box for an uncropped clip", () => {
    const box = { width: 200, height: 100 };
    expect(localOfFrame({ x: 0, y: 0 }, FULL_CROP, box)).toEqual({ x: 0, y: 0 });
    expect(localOfFrame({ x: 1, y: 1 }, FULL_CROP, box)).toEqual({
      x: 200,
      y: 100,
    });
  });

  it("put the frame's corner outside the box for a cropped one", () => {
    // The box holds the middle half, so the frame is twice as wide and starts a
    // box-width to the left of the box's own corner.
    const box = { width: 100, height: 100 };
    const crop = rect(0.25, 0, 0.5, 1);
    expect(localOfFrame({ x: 0, y: 0 }, crop, box)).toEqual({ x: -50, y: 0 });
    expect(localOfFrame({ x: 1, y: 1 }, crop, box)).toEqual({ x: 150, y: 100 });
    // And the crop's own corners land exactly on the box's.
    expect(localOfFrame({ x: 0.25, y: 0 }, crop, box)).toEqual({ x: 0, y: 0 });
    expect(localOfFrame({ x: 0.75, y: 1 }, crop, box)).toEqual({ x: 100, y: 100 });
  });

  it("round trip, at several crops and boxes", () => {
    const cases: Array<[CropRect, { width: number; height: number }]> = [
      [FULL_CROP, { width: 200, height: 100 }],
      [rect(0.25, 0, 0.5, 1), { width: 100, height: 100 }],
      [rect(0.1, 0.7, 0.3, 0.3), { width: 640, height: 360 }],
      [rect(0.9, 0.9, 0.1, 0.1), { width: 16, height: 9 }],
    ];
    for (const [crop, box] of cases) {
      for (const point of [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
        { x: 0.13, y: 0.87 },
      ]) {
        const back = frameOfLocal(localOfFrame(point, crop, box), crop, box);
        expect(back.x, JSON.stringify([crop, box, point])).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it("answers the crop's own origin rather than dividing by a box with none", () => {
    const crop = rect(0.2, 0.3, 0.5, 0.5);
    const out = frameOfLocal({ x: 10, y: 10 }, crop, { width: 0, height: 0 });
    expect(out).toEqual({ x: 0.2, y: 0.3 });
  });
});

describe("localRectOfFrame", () => {
  it("returns the box itself for the crop the box was made from", () => {
    const box = { width: 100, height: 60 };
    const crop = rect(0.25, 0.1, 0.5, 0.4);
    expect(localRectOfFrame(crop, crop, box)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 60,
    });
  });

  it("returns the whole frame for a full rect over a cropped clip", () => {
    const box = { width: 100, height: 100 };
    const crop = rect(0.25, 0, 0.5, 1);
    expect(localRectOfFrame(FULL_CROP, crop, box)).toEqual({
      x: -50,
      y: 0,
      width: 200,
      height: 100,
    });
  });
});

describe("grabOf", () => {
  it("gives a band that is the same pixel size on both axes", () => {
    const box = { width: 400, height: 100 };
    const grab = grabOf(20, FULL_CROP, box);
    expect(grab.x).toBeCloseTo(0.05, 9);
    expect(grab.y).toBeCloseTo(0.2, 9);
    // Which is the point: 0.05 of 400 and 0.2 of 100 are both 20 pixels.
    expect(grab.x * box.width).toBeCloseTo(20, 9);
    expect(grab.y * box.height).toBeCloseTo(20, 9);
  });

  it("measures against the whole frame, not the cropped box", () => {
    const box = { width: 100, height: 100 };
    const grab = grabOf(20, rect(0.25, 0, 0.5, 1), box);
    expect(grab.x).toBeCloseTo(0.1, 9);
    expect(grab.y).toBeCloseTo(0.2, 9);
  });

  it("answers zero rather than infinity for a box with no extent", () => {
    expect(grabOf(20, FULL_CROP, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("cropHandlePoints", () => {
  it("puts eight grips at the corners and the edge midpoints", () => {
    const points = cropHandlePoints(rect(0.2, 0.4, 0.4, 0.2));
    expect(points).toHaveLength(8);
    const at = Object.fromEntries(points.map((h) => [h.zone, h.point]));
    expect(at.stretchNW).toEqual({ x: 0.2, y: 0.4 });
    expect(at.stretchNE).toEqual({ x: 0.6000000000000001, y: 0.4 });
    expect(at.stretchSW).toEqual({ x: 0.2, y: 0.6000000000000001 });
    expect(at.stretchN).toEqual({ x: 0.4, y: 0.4 });
    expect(at.stretchS).toEqual({ x: 0.4, y: 0.6000000000000001 });
    expect(at.stretchW).toEqual({ x: 0.2, y: 0.5 });
  });

  it("covers every zone the drawer iterates, and each exactly once", () => {
    const zones = cropHandlePoints(rect(0, 0, 1, 1)).map((h) => h.zone);
    expect(zones).toEqual([...CROP_HANDLE_ZONES]);
    expect(new Set(zones).size).toBe(8);
  });

  it("has a cursor for every grip, and for the body", () => {
    for (const zone of CROP_HANDLE_ZONES) {
      expect(CROP_CURSORS[zone], zone).toBeTruthy();
    }
    expect(CROP_CURSORS.inside).toBe("move");
  });

  it("collapses onto one point for a rectangle with no extent", () => {
    const points = cropHandlePoints(rect(0.5, 0.5, 0, 0));
    for (const { point } of points) {
      expect(point).toEqual({ x: 0.5, y: 0.5 });
    }
  });
});

describe("CROP_THIRDS", () => {
  it("is the two interior lines, not the edges", () => {
    expect(CROP_THIRDS).toHaveLength(2);
    expect(CROP_THIRDS[0]).toBeCloseTo(1 / 3, 12);
    expect(CROP_THIRDS[1]).toBeCloseTo(2 / 3, 12);
  });
});
