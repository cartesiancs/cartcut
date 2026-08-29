import { describe, it, expect } from "vitest";
import { createShapeElement, shapePoints } from "./shapeElement";

describe("shapePoints", () => {
  it("gives a rectangle its four corners in the 0-100 box", () => {
    expect(shapePoints("rectangle")).toEqual([
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
    ]);
  });

  it("gives a triangle three points", () => {
    expect(shapePoints("triangle")).toHaveLength(3);
  });

  it("approximates an ellipse inside the box", () => {
    const points = shapePoints("ellipse", 24);
    expect(points).toHaveLength(24);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(-0.001);
      expect(x).toBeLessThanOrEqual(100.001);
      expect(y).toBeGreaterThanOrEqual(-0.001);
      expect(y).toBeLessThanOrEqual(100.001);
    }
  });

  it("closes the ellipse: the last point leads back to the first", () => {
    const points = shapePoints("ellipse", 8);
    // Every point is the same distance from the centre.
    for (const [x, y] of points) {
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50);
    }
  });
});

describe("createShapeElement", () => {
  it("leaves the track and paint rank for placeNewElement", () => {
    const element = createShapeElement({});
    expect(element.trackId).toBe("");
    expect(element.priority).toBe(0);
  });

  it("records the authoring box as oWidth/oHeight, not the drawn size", () => {
    // The name of this test was always right and the assertion was not.
    // `renderShape` paints `point * (width / oWidth)`, so recording the drawn
    // size makes that ratio 1 and the polygon comes out 100x100 whatever was
    // asked for — a full-width lower-third bar drew as a small square.
    const element = createShapeElement({ width: 320, height: 240 });
    expect(element.oWidth).toBe(100);
    expect(element.oHeight).toBe(100);
    // `ratio` is the drawn aspect and stays that.
    expect(element.ratio).toBeCloseTo(320 / 240);
  });

  it("scales the authored points to the size that was asked for", () => {
    const element = createShapeElement({ width: 1_920, height: 200 });
    // What `renderShape` will multiply each authored point by.
    expect(element.width / element.oWidth).toBe(19.2);
    expect(element.height / element.oHeight).toBe(2);
  });

  it("carries an animation block, since a shape animates opacity", () => {
    const element = createShapeElement({});
    expect(element.animation?.opacity).toBeDefined();
    expect(element.animation.opacity.isActivate).toBe(false);
  });

  it("takes explicit points over a kind", () => {
    const points = [
      [0, 0],
      [50, 100],
      [100, 0],
    ];
    expect(createShapeElement({ shape: points, kind: "ellipse" }).shape).toBe(points);
  });

  it("defaults to a white 100x100 rectangle a second long", () => {
    const element = createShapeElement({});
    expect(element.option.fillColor).toBe("#ffffff");
    expect(element.duration).toBe(1000);
    expect(element.opacity).toBe(100);
    expect(element.rotation).toBe(0);
    expect(element.shape).toHaveLength(4);
  });

  it("takes the transform it is given", () => {
    const element = createShapeElement({
      locationX: 40,
      locationY: 60,
      opacity: 55,
      rotation: 30,
      fillColor: "#ff0000",
      startTime: 2_000,
      duration: 3_000,
    });
    expect(element.location).toEqual({ x: 40, y: 60 });
    expect(element.opacity).toBe(55);
    expect(element.rotation).toBe(30);
    expect(element.option.fillColor).toBe("#ff0000");
    expect(element.startTime).toBe(2_000);
    expect(element.duration).toBe(3_000);
  });
});
