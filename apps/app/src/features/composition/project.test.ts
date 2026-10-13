import { describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { imageElement } from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import {
  allTracksOf,
  compositionExtentMs,
  compositionIdOf,
  compositionOfElement,
  isProjectTemplateId,
  projectTemplateId,
  referencedCompositionIds,
  savedProject,
  type ProjectTimelines,
} from "./project";

const tpl = (templateId: string) =>
  ({
    ...createTemplateElement({
      templateId,
      name: "T",
      durationMs: 1000,
      size: { w: 1, h: 1 },
      frame: { w: 1, h: 1 },
    }),
    trackId: "v",
  }) as TemplateElementType;

const comp = (id: string, trackId: string) => ({
  id,
  name: id,
  size: { w: 1, h: 1 },
  tracks: [createTrack(trackId, "video", 0)],
  elements: {} as Timeline,
});

describe("project template ids", () => {
  it("round-trip", () => {
    expect(projectTemplateId("c1")).toBe("project:c1");
    expect(compositionIdOf("project:c1")).toBe("c1");
    expect(isProjectTemplateId("project:c1")).toBe(true);
  });

  it("reject everything that is not one", () => {
    for (const id of ["neon", "project:", "projectc1", "", null, 3, undefined]) {
      expect(isProjectTemplateId(id)).toBe(false);
      expect(compositionIdOf(id)).toBeNull();
    }
  });

  it("are read only off a template element", () => {
    expect(compositionOfElement(tpl("project:c1"))).toBe("c1");
    expect(compositionOfElement(tpl("neon"))).toBeNull();
    expect(
      compositionOfElement({ ...imageElement(), templateId: "project:c1" } as never),
    ).toBeNull();
    expect(compositionOfElement(undefined)).toBeNull();
  });
});

describe("referencedCompositionIds", () => {
  it("collects each named composition once", () => {
    const ids = referencedCompositionIds({
      a: tpl("project:c1"),
      b: tpl("project:c1"),
      c: tpl("project:c2"),
      d: tpl("neon"),
      e: imageElement(),
    } as unknown as Timeline);
    expect([...ids].sort()).toEqual(["c1", "c2"]);
  });
});

describe("compositionExtentMs", () => {
  it("is the end of the last clip, and zero for nothing", () => {
    expect(compositionExtentMs({})).toBe(0);
    expect(
      compositionExtentMs({
        a: imageElement({ startTime: 0, duration: 1000 }),
        b: imageElement({ startTime: 2500, duration: 500 }),
      } as Timeline),
    ).toBe(3000);
  });
});

describe("savedProject", () => {
  const project = (): ProjectTimelines => ({
    main: {
      tracks: [createTrack("v", "video", 0)],
      elements: { a: tpl("project:keep") } as unknown as Timeline,
    },
    compositions: { keep: comp("keep", "k"), orphan: comp("orphan", "o") },
  });

  it("leaves out a composition nothing names", () => {
    expect(Object.keys(savedProject(project()).compositions)).toEqual(["keep"]);
  });

  it("returns its input by identity when everything is named", () => {
    const p = project();
    delete (p.compositions as any).orphan;
    expect(savedProject(p)).toBe(p);
  });
});

describe("allTracksOf", () => {
  it("lists main's rows, then each composition's in id order", () => {
    const p: ProjectTimelines = {
      main: { tracks: [createTrack("m", "video", 0)], elements: {} },
      compositions: { z: comp("z", "zt"), a: comp("a", "at") },
    };
    expect(allTracksOf(p).map((t) => t.id)).toEqual(["m", "at", "zt"]);
  });
});
