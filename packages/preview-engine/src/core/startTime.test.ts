import { describe, it, expect } from "vitest";
import { resolveStartTime } from "./startTime";
import type { RenderTimeline } from "../model/timeline.types";

describe("resolveStartTime", () => {
  const timeline: RenderTimeline = {
    clip: { filetype: "video", startTime: 2000 },
    caption: { filetype: "text", startTime: 500, parentKey: "clip" },
    loose: { filetype: "text", startTime: 500, parentKey: "standalone" },
    orphan: { filetype: "text", startTime: 500, parentKey: "missing" },
    img: { filetype: "image", startTime: 500, parentKey: "clip" },
  };

  it("returns the element's own startTime for non-text elements", () => {
    expect(resolveStartTime(timeline.clip, timeline)).toBe(2000);
  });

  it("offsets a parented text element by its parent's startTime", () => {
    expect(resolveStartTime(timeline.caption, timeline)).toBe(2500);
  });

  it("leaves a standalone text element alone", () => {
    expect(resolveStartTime(timeline.loose, timeline)).toBe(500);
  });

  it("only parents text — an image with a parentKey is unaffected", () => {
    expect(resolveStartTime(timeline.img, timeline)).toBe(500);
  });

  it("treats a dangling parentKey as a zero offset rather than throwing", () => {
    expect(resolveStartTime(timeline.orphan, timeline)).toBe(500);
  });

  it("defaults a missing startTime to 0", () => {
    expect(resolveStartTime({ filetype: "image" }, {})).toBe(0);
  });
});
