import { describe, it, expect } from "vitest";
import { isElementVisibleAtTime } from "./time";
import type { Timeline } from "../../@types/timeline";
import {
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";

describe("isElementVisibleAtTime", () => {
  const empty: Timeline = {};

  it("covers [start, start + duration)", () => {
    const el = imageElement({ startTime: 1000, duration: 2000 });
    expect(isElementVisibleAtTime(999, empty, el)).toBe(false);
    expect(isElementVisibleAtTime(1000, empty, el)).toBe(true);
    expect(isElementVisibleAtTime(2999, empty, el)).toBe(true);
    expect(isElementVisibleAtTime(3000, empty, el)).toBe(false);
  });

  it("shortens a sped-up video and lengthens a slowed one", () => {
    const fast = videoElement({ startTime: 0, duration: 2000, speed: 2 });
    expect(isElementVisibleAtTime(999, empty, fast)).toBe(true);
    expect(isElementVisibleAtTime(1000, empty, fast)).toBe(false);

    const slow = videoElement({ startTime: 0, duration: 2000, speed: 0.5 });
    expect(isElementVisibleAtTime(3999, empty, slow)).toBe(true);
    expect(isElementVisibleAtTime(4000, empty, slow)).toBe(false);
  });

  it("ignores trim, which addresses the source file rather than the timeline", () => {
    // A clip placed at 43s whose trim starts at 71.3s inside the source file is
    // visible from 43s. Treating trim as a timeline offset used to push it out
    // to 114s and render the canvas black.
    const el = videoElement({
      startTime: 43_000,
      duration: 38_000,
      speed: 1,
      trim: { startTime: 71_300, endTime: 109_300 },
    });
    expect(isElementVisibleAtTime(43_000, empty, el)).toBe(true);
    expect(isElementVisibleAtTime(60_000, empty, el)).toBe(true);
    expect(isElementVisibleAtTime(81_000, empty, el)).toBe(false);
  });

  it("offsets a parented text element by its parent's start time", () => {
    const timeline: Timeline = {
      clip: videoElement({ startTime: 2000, duration: 5000 }),
      caption: textElement({
        startTime: 500,
        duration: 1000,
        parentKey: "clip",
      }),
    };
    const caption = timeline.caption;
    // window is [2500, 3500), not [500, 1500)
    expect(isElementVisibleAtTime(500, timeline, caption)).toBe(false);
    expect(isElementVisibleAtTime(2500, timeline, caption)).toBe(true);
    expect(isElementVisibleAtTime(3499, timeline, caption)).toBe(true);
    expect(isElementVisibleAtTime(3500, timeline, caption)).toBe(false);
  });

  it("leaves a standalone text element at its own start time", () => {
    const el = textElement({
      startTime: 500,
      duration: 1000,
      parentKey: "standalone",
    });
    expect(isElementVisibleAtTime(500, empty, el)).toBe(true);
    expect(isElementVisibleAtTime(1500, empty, el)).toBe(false);
  });

  it("only parents text — an image is unaffected by a parent clip", () => {
    const timeline: Timeline = {
      clip: videoElement({ startTime: 2000, duration: 5000 }),
      pic: imageElement({ startTime: 500, duration: 1000 }),
    };
    expect(isElementVisibleAtTime(500, timeline, timeline.pic)).toBe(true);
  });
});
