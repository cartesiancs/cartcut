import { describe, it, expect } from "vitest";
import { sortIdsByPriority, sortTimelineByPriority } from "./priority";
import type { RenderTimeline } from "../model/timeline.types";

const tl: RenderTimeline = {
  a: { priority: 3 },
  b: { priority: 1 },
  c: { priority: 2 },
};

describe("sortIdsByPriority", () => {
  it("orders ids ascending by priority", () => {
    expect(sortIdsByPriority(tl)).toEqual(["b", "c", "a"]);
  });
  it("sorts a provided id subset", () => {
    expect(sortIdsByPriority(tl, ["a", "b"])).toEqual(["b", "a"]);
  });
  it("treats missing priority as 0", () => {
    const t: RenderTimeline = { x: {}, y: { priority: -1 } };
    expect(sortIdsByPriority(t)).toEqual(["y", "x"]);
  });
});

describe("sortTimelineByPriority", () => {
  it("returns a new key-ordered object", () => {
    expect(Object.keys(sortTimelineByPriority(tl))).toEqual(["b", "c", "a"]);
  });
});
