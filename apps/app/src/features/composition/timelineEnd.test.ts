import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { imageElement } from "../renderer/testing";
import { MAIN_TIMELINE } from "./project";
import { nullLengthOf, timelineEndOf, timelineScrollEndOf } from "./timelineEnd";

const content = {
  a: imageElement({ startTime: 1000, duration: 2500 }),
} as Timeline;

describe("where the timeline being edited ends", () => {
  it("is the project's length on main", () => {
    expect(timelineEndOf(MAIN_TIMELINE, content, 10)).toBe(10_000);
    expect(timelineScrollEndOf(MAIN_TIMELINE, content, 10)).toBe(10_000);
    expect(nullLengthOf(MAIN_TIMELINE, content, 10)).toBe(10_000);
  });

  it("is the template's own length in a template", () => {
    expect(timelineEndOf("c1", content, 10)).toBe(3500);
  });

  it("scrolls past a short template, so it can be made longer", () => {
    expect(timelineScrollEndOf("c1", content, 10)).toBe(10_000);
    expect(timelineScrollEndOf("c1", content, 2)).toBe(3500);
  });

  it("gives a null the template's length, or the project's for an empty one", () => {
    expect(nullLengthOf("c1", content, 10)).toBe(3500);
    expect(nullLengthOf("c1", {}, 10)).toBe(10_000);
  });
});
