import { describe, expect, it } from "vitest";
import { pinchRange } from "../timeline/zoom";
import {
  previewPinchDeltaY,
  timelinePinchDeltaY,
  timelineTouchMode,
} from "./timelineTouch";

const clip = (elementId: string) =>
  ({ kind: "clip", elementId, trackId: "t", zone: "body" }) as const;

describe("timelineTouchMode", () => {
  it("drags only what is already selected", () => {
    expect(timelineTouchMode(clip("a"), ["a"])).toBe("mouse");
    expect(timelineTouchMode({ ...clip("a"), zone: "trimEnd" }, ["a"])).toBe(
      "mouse",
    );
    expect(timelineTouchMode(clip("a"), ["b"])).toBe("pan");
    expect(timelineTouchMode(clip("a"), [])).toBe("pan");
  });

  it("treats transitions like clips and everything else as a pan", () => {
    const transition = {
      kind: "transition",
      transitionId: "x",
      trackId: "t",
      zone: "body",
    } as const;
    expect(timelineTouchMode(transition, ["x"])).toBe("mouse");
    expect(timelineTouchMode(transition, [])).toBe("pan");
    expect(timelineTouchMode({ kind: "none" }, ["a"])).toBe("pan");
    expect(timelineTouchMode({ kind: "track", trackId: "t" }, ["a"])).toBe(
      "pan",
    );
    expect(
      timelineTouchMode(
        { kind: "cut", trackId: "t", fromId: "a", toId: "b", atMs: 0 },
        ["a"],
      ),
    ).toBe("pan");
  });
});

describe("pinch deltas", () => {
  it("scales the timeline range by the finger spread", () => {
    // Within the clamp, so the inversion is exact.
    expect(pinchRange(10, timelinePinchDeltaY(2), 60)).toBeCloseTo(20, 9);
    expect(pinchRange(10, timelinePinchDeltaY(0.5), 60)).toBeCloseTo(5, 9);
    expect(timelinePinchDeltaY(1)).toBe(0);
  });

  it("scales the preview zoom by the finger spread", () => {
    const zoomAfter = (scale: number) =>
      Math.exp(-previewPinchDeltaY(scale) * 0.01);
    expect(zoomAfter(2)).toBeCloseTo(2, 9);
    expect(zoomAfter(0.25)).toBeCloseTo(0.25, 9);
  });
});
