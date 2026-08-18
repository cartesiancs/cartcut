import { describe, it, expect } from "vitest";
import {
  isElementVisibleAtTime,
  getVisibleElementIds,
} from "./visibility";
import { resolveStartTime } from "./startTime";
import type { RenderTimeline } from "../model/timeline.types";

describe("resolveStartTime", () => {
  it("uses the element's own startTime by default", () => {
    const tl: RenderTimeline = { a: { filetype: "image", startTime: 500 } };
    expect(resolveStartTime(tl.a, tl)).toBe(500);
  });
  it("adds the parent's start for parented text", () => {
    const tl: RenderTimeline = {
      vid: { filetype: "video", startTime: 1000 },
      t: { filetype: "text", parentKey: "vid", startTime: 200 },
    };
    expect(resolveStartTime(tl.t, tl)).toBe(1200);
  });
  it("does not offset standalone text", () => {
    const tl: RenderTimeline = {
      t: { filetype: "text", parentKey: "standalone", startTime: 200 },
    };
    expect(resolveStartTime(tl.t, tl)).toBe(200);
  });
});

describe("isElementVisibleAtTime", () => {
  it("windows static elements on [start, start+duration)", () => {
    const tl: RenderTimeline = {
      a: { filetype: "image", startTime: 1000, duration: 500 },
    };
    expect(isElementVisibleAtTime(tl.a, tl, 999)).toBe(false);
    expect(isElementVisibleAtTime(tl.a, tl, 1000)).toBe(true);
    expect(isElementVisibleAtTime(tl.a, tl, 1499)).toBe(true);
    expect(isElementVisibleAtTime(tl.a, tl, 1500)).toBe(false);
  });

  it("scales dynamic (video) duration by speed and applies trim", () => {
    const tl: RenderTimeline = {
      v: {
        filetype: "video",
        startTime: 0,
        duration: 1000,
        speed: 2, // effective duration 500
        trim: { startTime: 100, endTime: 400 },
      },
    };
    // within duration/speed but outside trim -> hidden
    expect(isElementVisibleAtTime(tl.v, tl, 50)).toBe(false);
    // inside trim window
    expect(isElementVisibleAtTime(tl.v, tl, 100)).toBe(true);
    expect(isElementVisibleAtTime(tl.v, tl, 399)).toBe(true);
    // trim end excluded
    expect(isElementVisibleAtTime(tl.v, tl, 400)).toBe(false);
  });

  it("never shows audio (no visual)", () => {
    const tl: RenderTimeline = {
      a: { filetype: "audio", startTime: 0, duration: 5000 },
    };
    expect(isElementVisibleAtTime(tl.a, tl, 100)).toBe(false);
  });

  it("honours parented text start offset", () => {
    const tl: RenderTimeline = {
      p: { filetype: "video", startTime: 1000, duration: 5000 },
      t: {
        filetype: "text",
        parentKey: "p",
        startTime: 0,
        duration: 500,
      },
    };
    expect(isElementVisibleAtTime(tl.t, tl, 900)).toBe(false);
    expect(isElementVisibleAtTime(tl.t, tl, 1000)).toBe(true);
    expect(isElementVisibleAtTime(tl.t, tl, 1499)).toBe(true);
    expect(isElementVisibleAtTime(tl.t, tl, 1500)).toBe(false);
  });
});

describe("getVisibleElementIds", () => {
  it("collects visible non-audio ids", () => {
    const tl: RenderTimeline = {
      a: { filetype: "image", startTime: 0, duration: 1000 },
      b: { filetype: "image", startTime: 2000, duration: 1000 },
      music: { filetype: "audio", startTime: 0, duration: 10000 },
    };
    expect(getVisibleElementIds(tl, 500)).toEqual(["a"]);
    expect(getVisibleElementIds(tl, 2500)).toEqual(["b"]);
    expect(getVisibleElementIds(tl, 5000)).toEqual([]);
  });
});
