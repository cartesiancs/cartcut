import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { bakeTrack } from "../animation/keyframes";
import { audioElement, imageElement, keys, points } from "../renderer/testing";
import { createTrack } from "../timeline/tracks";
import type { ProjectTimelines } from "./project";
import { rebakeProject } from "./rebake";

const animated = () => {
  const base = imageElement();
  return imageElement({
    trackId: "t",
    animation: {
      ...(base.animation as any),
      opacity: {
        isActivate: true,
        x: keys([0, 0], [1000, 100]),
        ax: points([0, 0], [1000, 100]),
      },
    } as any,
  });
};

const project = (mainEl: unknown, compEl: unknown): ProjectTimelines => ({
  main: {
    tracks: [createTrack("t", "video", 0)],
    elements: { m: mainEl } as Timeline,
  },
  compositions: {
    c1: {
      id: "c1",
      name: "c",
      size: { w: 1, h: 1 },
      tracks: [createTrack("t", "video", 0)],
      elements: { x: compEl } as Timeline,
    },
  },
});

describe("rebakeProject", () => {
  it("returns the project by identity when nothing is animated", () => {
    const p = project(audioElement({ trackId: "t" }), audioElement({ trackId: "t" }));
    expect(rebakeProject(p, 120)).toBe(p);
  });

  it("re-bakes a parked composition as well as main", () => {
    const p = project(animated(), animated());
    const next = rebakeProject(p, 120);
    const lane = (e: any) => e.animation.opacity;
    expect(lane(next.main.elements.m).ax).toEqual(bakeTrack(lane(p.main.elements.m).x, 120));
    expect(lane(next.compositions.c1.elements.x).ax).toEqual(
      bakeTrack(lane(p.compositions.c1.elements.x).x, 120),
    );
    expect(rebakeProject(next, 120)).toBe(next);
  });

  it("leaves an untouched composition by reference", () => {
    const p = project(animated(), audioElement({ trackId: "t" }));
    const next = rebakeProject(p, 120);
    expect(next.compositions.c1).toBe(p.compositions.c1);
    expect(next.compositions).toBe(p.compositions);
  });
});
