import { describe, it, expect } from "vitest";
import { displayPosition, isPositionAnimated } from "./elementPosition";
import { bakeTrack, sampleTrackXY } from "../animation/keyframes";
import { imageElement, keys, shapeElement } from "../renderer/testing";

const START = 1000;

/** An image that travels from (0, 0) to (400, 200) over its first second. */
function moving(over: Record<string, any> = {}) {
  const base = imageElement();
  const x = keys([0, 0], [1000, 400]);
  const y = keys([0, 0], [1000, 200]);
  return imageElement({
    startTime: START,
    duration: 3000,
    location: { x: 7, y: 9 },
    animation: {
      ...(base.animation as any),
      position: {
        isActivate: true,
        x,
        ax: bakeTrack(x),
        y,
        ay: bakeTrack(y),
        ...over,
      },
    } as any,
  });
}

describe("displayPosition", () => {
  it("is the static location when the track is off", () => {
    const still = moving({ isActivate: false });
    expect(displayPosition(still, START + 500)).toEqual({ x: 7, y: 9 });
  });

  it("is the static location before the element starts", () => {
    // `sampleTrackXY`'s own guard: there is nothing to animate yet.
    expect(displayPosition(moving(), START - 1)).toEqual({ x: 7, y: 9 });
  });

  it("is the sampled position once the element has started", () => {
    const at = displayPosition(moving(), START + 1000);
    expect(at.x).toBeCloseTo(400, 0);
    expect(at.y).toBeCloseTo(200, 0);
  });

  // The bug this module exists for: `_handleMouseDown` hit-tested and took its
  // drag origin from `element.location`, while `drawCanvas` sampled the track.
  // Any cursor position where the animation had displaced the element made
  // those two disagree, so grabbing the element missed its real rectangle and
  // the drag was offset by `animated − static` — which `_handleMouseUp` then
  // wrote into a keyframe. The element jumped.
  it("agrees with what the renderer samples, and differs from location", () => {
    const element = moving();
    const cursor = START + 500;

    const drawn = sampleTrackXY(
      (element as any).animation.position,
      element.startTime,
      cursor,
      element.location.x,
      element.location.y,
    );

    expect(displayPosition(element, cursor)).toEqual(drawn);
    expect(displayPosition(element, cursor)).not.toEqual(element.location);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an element with no animation block", { location: { x: 3, y: 4 } }],
    ["an element with no location", { animation: {} }],
  ])("survives %s", (_name, element) => {
    expect(displayPosition(element as any, 0)).toEqual(
      // The two cases that carry a location report it; the rest fall back to 0.
      (element as any)?.location ?? { x: 0, y: 0 },
    );
  });

  // A shape's animation block carries `opacity` alone, so a nominal type would
  // have rejected the very callers that need this.
  it("accepts an element whose type declares no position track", () => {
    const shape = shapeElement({ location: { x: 11, y: 12 } } as any);
    expect(displayPosition(shape as any, 5000)).toEqual({ x: 11, y: 12 });
  });

  it("falls back when the track is active but nothing is baked", () => {
    const empty = moving({ ax: [], ay: [] });
    expect(displayPosition(empty, START + 500)).toEqual({ x: 7, y: 9 });
  });
});

describe("isPositionAnimated", () => {
  it.each([
    ["an active track", moving(), true],
    ["an inactive track", moving({ isActivate: false }), false],
    ["no position track", shapeElement(), false],
    ["nothing at all", null, false],
  ])("is %s", (_name, element, expected) => {
    expect(isPositionAnimated(element as any)).toBe(expected);
  });
});
