import { describe, it, expect } from "vitest";
import {
  animatableProperties,
  canAnimate,
  isVisualTimelineElement,
} from "./timeline";
import {
  imageElement,
  videoElement,
  gifElement,
  textElement,
  shapeElement,
  audioElement,
} from "../features/renderer/testing";

/**
 * The renderer walks the whole timeline, so this guard is what keeps audio —
 * the one element with no width, height or position — out of the drawing path
 * and off the canvas.
 */
describe("isVisualTimelineElement", () => {
  it("accepts every element kind that has pixels", () => {
    expect(isVisualTimelineElement(imageElement())).toBe(true);
    expect(isVisualTimelineElement(videoElement())).toBe(true);
    expect(isVisualTimelineElement(gifElement())).toBe(true);
    expect(isVisualTimelineElement(textElement())).toBe(true);
    expect(isVisualTimelineElement(shapeElement())).toBe(true);
  });

  it("rejects audio", () => {
    expect(isVisualTimelineElement(audioElement())).toBe(false);
  });

  it("narrows the type so visual-only fields become reachable", () => {
    const element = imageElement({ width: 320, height: 180 });
    if (isVisualTimelineElement(element)) {
      // A compile-time assertion as much as a runtime one: `width` does not
      // exist on the union until the guard narrows it.
      expect(element.width).toBe(320);
      expect(element.height).toBe(180);
    } else {
      throw new Error("image should be visual");
    }
  });
});

describe("canAnimate / animatableProperties", () => {
  it("includes the element types that carry an animation block", () => {
    expect(canAnimate(imageElement({}))).toBe(true);
    expect(canAnimate(videoElement({}))).toBe(true);
    expect(canAnimate(textElement({}))).toBe(true);
    expect(canAnimate(shapeElement({}))).toBe(true);
  });

  it("excludes GIF and audio, which have no animation field", () => {
    // The old gate was "static and not text", which let GIF in — it has no
    // `animation` at all — and kept video out, which does.
    expect(canAnimate(gifElement({}))).toBe(false);
    expect(canAnimate(audioElement({}))).toBe(false);
  });

  it("offers all four properties where the type supports them", () => {
    expect(animatableProperties(imageElement({}))).toEqual([
      "position",
      "opacity",
      "scale",
      "rotation",
    ]);
  });

  it("offers only opacity for a shape, which is all its type has", () => {
    expect(animatableProperties(shapeElement({}))).toEqual(["opacity"]);
  });

  it("offers nothing for an element that cannot animate", () => {
    expect(animatableProperties(gifElement({}))).toEqual([]);
    expect(animatableProperties(audioElement({}))).toEqual([]);
  });
});
