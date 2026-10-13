import { describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { imageElement, videoElement } from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import { projectTemplateId, type ProjectTimelines } from "./project";
import { reconcileTemplateSpans } from "./reconcile";

/**
 * A template clip follows its composition's length, inside the edit that
 * changed it, and never by moving anything else.
 */

function clip(over: Partial<TemplateElementType> = {}): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: projectTemplateId("c1"),
      name: "T",
      durationMs: 3000,
      size: { w: 100, h: 100 },
      frame: { w: 100, h: 100 },
    }),
    trackId: "v1",
    startTime: 1000,
    ...over,
  } as TemplateElementType;
}

function composition(endMs: number) {
  return {
    id: "c1",
    name: "T",
    size: { w: 100, h: 100 },
    tracks: [createTrack("cv", "video", 0)],
    elements: (endMs > 0
      ? { x: imageElement({ trackId: "cv", startTime: 0, duration: endMs }) }
      : {}) as Timeline,
  };
}

function project(
  elements: Record<string, unknown>,
  endMs: number,
): ProjectTimelines {
  return {
    main: {
      tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
      elements: elements as Timeline,
    },
    compositions: { c1: composition(endMs) },
  };
}

const durationOf = (p: ProjectTimelines, id: string) =>
  p.main.elements[id].duration;

describe("reconcileTemplateSpans", () => {
  it("returns the project by identity when no composition changed", () => {
    const p = project({ t: clip() }, 5000);
    expect(reconcileTemplateSpans(p, [])).toBe(p);
  });

  it("returns the project by identity when the clip is already the right length", () => {
    const p = project({ t: clip() }, 3000);
    expect(reconcileTemplateSpans(p, ["c1"])).toBe(p);
  });

  it("ignores a composition nobody names, and a clip naming another", () => {
    const p = project(
      { t: clip({ templateId: projectTemplateId("c9") }), i: clip({ templateId: "neon" }) },
      5000,
    );
    expect(reconcileTemplateSpans(p, ["c1"])).toBe(p);
  });

  it("grows a clip into free space", () => {
    const p = project({ t: clip() }, 5000);
    expect(durationOf(reconcileTemplateSpans(p, ["c1"]), "t")).toBe(5000);
  });

  it("shrinks a clip", () => {
    const p = project({ t: clip() }, 1200);
    expect(durationOf(reconcileTemplateSpans(p, ["c1"]), "t")).toBe(1200);
  });

  it("stops at the next clip on the row, and never moves it", () => {
    const next = videoElement({ trackId: "v1", startTime: 5000, duration: 1000 });
    const p = project({ t: clip(), next }, 9000);
    const after = reconcileTemplateSpans(p, ["c1"]);
    expect(durationOf(after, "t")).toBe(4000);
    expect(after.main.elements.next).toBe(next);
  });

  it("is not stopped by a clip on another row", () => {
    const other = videoElement({ trackId: "v2", startTime: 5000, duration: 1000 });
    const p = project({ t: clip(), other }, 9000);
    expect(durationOf(reconcileTemplateSpans(p, ["c1"]), "t")).toBe(9000);
  });

  it("is not stopped by a clip that ends where it starts", () => {
    const before = videoElement({ trackId: "v1", startTime: 0, duration: 1000 });
    const p = project({ before, t: clip() }, 6000);
    expect(durationOf(reconcileTemplateSpans(p, ["c1"]), "t")).toBe(6000);
  });

  it("leaves a clip alone when its composition is empty", () => {
    // A zero-length bar is one nothing can right-click to open again.
    const p = project({ t: clip() }, 0);
    expect(reconcileTemplateSpans(p, ["c1"])).toBe(p);
  });

  it("grows two clips of one composition on one row without overlapping", () => {
    const p = project(
      { first: clip({ startTime: 0 }), second: clip({ startTime: 4000 }) },
      6000,
    );
    const after = reconcileTemplateSpans(p, ["c1"]);
    expect(durationOf(after, "first")).toBe(4000);
    expect(durationOf(after, "second")).toBe(6000);
  });

  it("does not touch the input", () => {
    const t = clip();
    const p = project({ t }, 5000);
    reconcileTemplateSpans(p, ["c1"]);
    expect(t.duration).toBe(3000);
  });
});
