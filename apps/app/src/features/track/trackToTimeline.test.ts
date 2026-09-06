import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { bakeTrack } from "../animation/keyframes";
import { keys, textElement, videoElement } from "../renderer/testing";
import { canvasToFramePoint, toProjectPath } from "./trackToTimeline";
import type { TrackSample } from "./tracker";

const FRAME = { frameWidth: 200, frameHeight: 100 };

function sample(sourceMs: number, x: number, y: number): TrackSample {
  return { sourceMs, x, y, confidence: 1 };
}

function elements(over: Record<string, any> = {}): Timeline {
  return { clip: videoElement(), ...over } as unknown as Timeline;
}

describe("toProjectPath", () => {
  it("maps the centre of the frame to the centre of the clip's box", () => {
    const path = toProjectPath([sample(0, 100, 50)], {
      elements: elements(),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // 100×100 box, so half of each side.
    expect(path).toEqual([{ tMs: 0, x: 50, y: 50 }]);
  });

  it("carries the clip's own placement", () => {
    const path = toProjectPath([sample(0, 100, 50)], {
      elements: elements({
        clip: videoElement({ location: { x: 30, y: 40 } }),
      }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    expect(path).toEqual([{ tMs: 0, x: 80, y: 90 }]);
  });

  it("is independent of the working resolution", () => {
    // The normalised step in the middle is what lets `frameSource.ts` decode at
    // whatever size is cheap: dividing by the size it decoded at cancels it.
    const half = toProjectPath([sample(0, 50, 25)], {
      elements: elements(),
      clipId: "clip",
      frameWidth: 100,
      frameHeight: 50,
      fps: 60,
    });

    expect(half).toEqual([{ tMs: 0, x: 50, y: 50 }]);
  });

  it("reads the box through the size track, not the static field", () => {
    // A clip whose `size` is animated has a box that changes under the cursor.
    // Reading `element.width` here would place the point correctly at t=0 and
    // progressively wrongly after it.
    const clip = videoElement({
      startTime: 0,
      duration: 4000,
      animation: {
        ...videoElement().animation,
        size: {
          isActivate: true,
          x: keys([0, 100], [1000, 200]),
          y: keys([0, 100], [1000, 100]),
          ax: bakeTrack(keys([0, 100], [1000, 200])),
          ay: bakeTrack(keys([0, 100], [1000, 100])),
        },
      },
    });

    const path = toProjectPath([sample(1000, 200, 50)], {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // Right edge of the frame, and at t=1000 the box is 200 wide.
    expect(path[0].x).toBeCloseTo(200, 4);
  });

  it("converts source time through the trim and the speed", () => {
    const clip = videoElement({
      startTime: 500,
      duration: 4000,
      speed: 2,
      trim: { startTime: 1000, endTime: 5000 },
    });

    const path = toProjectPath([sample(2000, 100, 50)], {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // 500 + (2000 − 1000) / 2
    expect(path[0].tMs).toBe(1000);
  });

  it("snaps to the frame grid", () => {
    const path = toProjectPath([sample(17, 100, 50)], {
      elements: elements(),
      clipId: "clip",
      ...FRAME,
      fps: 30,
    });

    // 33.33ms per frame at 30fps; 17ms is nearest the frame at 33.33.
    expect(path[0].tMs).toBeCloseTo(1000 / 30, 4);
  });

  it("drops samples that land outside the clip's span", () => {
    const path = toProjectPath(
      [sample(0, 100, 50), sample(9000, 100, 50)],
      { elements: elements(), clipId: "clip", ...FRAME, fps: 60 },
    );

    expect(path).toHaveLength(1);
  });

  it("declines on an element that has no source time", () => {
    expect(
      toProjectPath([sample(0, 1, 1)], {
        elements: { clip: textElement() } as unknown as Timeline,
        clipId: "clip",
        ...FRAME,
        fps: 60,
      }),
    ).toEqual([]);
  });

  it("declines on a missing clip or a degenerate frame", () => {
    const base = { elements: elements(), clipId: "clip", fps: 60 };

    expect(
      toProjectPath([sample(0, 1, 1)], { ...base, clipId: "nope", ...FRAME }),
    ).toEqual([]);
    expect(
      toProjectPath([sample(0, 1, 1)], {
        ...base,
        frameWidth: 0,
        frameHeight: 100,
      }),
    ).toEqual([]);
  });
});

describe("canvasToFramePoint", () => {
  it("scales a click on the panel's canvas into the decoded frame", () => {
    expect(
      canvasToFramePoint(
        { x: 240, y: 90 },
        { width: 480, height: 270 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 960, y: 360 });
  });

  it("answers the origin rather than dividing by zero", () => {
    expect(
      canvasToFramePoint(
        { x: 10, y: 10 },
        { width: 0, height: 0 },
        { width: 100, height: 100 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});
