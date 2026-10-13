import { describe, expect, it } from "vitest";
import type {
  TemplateElementType,
  Timeline,
  TimelineElement,
} from "../../@types/timeline";
import {
  groupElement,
  imageElement,
  keys,
  points,
  textElement,
  transitionElement,
  videoElement,
} from "../renderer/testing";
import { bakeTrack } from "../animation/keyframes";
import { composeTemplate, type TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import { createTemplateElement } from "../timeline/templateOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../timeline/tracks";
import { forkTemplate } from "./fork";
import { projectTemplateId, type ProjectTimelines } from "./project";
import { compositionTemplateData } from "./templateData";

/**
 * Expanding a template copies it into the project. Three claims carry it:
 *
 *  - **The copy is what the clip showed.** Its fills are baked in, and drawn
 *    through the same template renderer the copy looks the same as the
 *    original did.
 *  - **The copy has no id in common with anything.** Two forks of one template
 *    share none, so nothing keyed by id outside the document can mix them.
 *  - **Every reference survives the new ids.** A parent, a link and a
 *    transition all still name the right element, and `normalizeDocument`
 *    keeps every one of them.
 */

const OLD_IDS = ["g", "child", "a", "b", "cut", "title", "inner", "trk-v", "trk-t"];

function templateData(over: Partial<TemplateData> = {}): TemplateData {
  const elements = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("trk-t", "text", 0), createTrack("trk-v", "video", 1)],
    elements: {
      g: groupElement({ key: "g", trackId: "trk-v", startTime: 0, duration: 4000 }),
      child: imageElement({
        key: "child",
        trackId: "trk-v",
        startTime: 4000,
        duration: 1000,
        parentId: "g",
        link: {
          opacity: {
            from: { elementId: "g", property: "rotation" },
            in: [0, 90],
            out: [100, 0],
          },
        },
      } as never),
      a: videoElement({
        key: "a",
        trackId: "trk-v",
        startTime: 5000,
        duration: 2000,
        trim: { startTime: 0, endTime: 2000 },
        sourceDuration: 4000,
        localpath: "file:///lib/a.mp4",
        replaceable: { slotId: "hero" },
      }),
      b: videoElement({
        key: "b",
        trackId: "trk-v",
        startTime: 7000,
        duration: 2000,
        trim: { startTime: 1000, endTime: 3000 },
        sourceDuration: 4000,
        localpath: "file:///lib/b.mp4",
      }),
      cut: transitionElement({
        key: "cut",
        trackId: "trk-v",
        startTime: 6500,
        duration: 1000,
        fromId: "a",
        toId: "b",
      }),
      title: textElement({
        key: "title",
        trackId: "trk-t",
        startTime: 0,
        duration: 9000,
        text: "YOUR NAME",
        replaceable: { slotId: "name" },
      }),
      inner: {
        ...createTemplateElement({
          templateId: "other",
          name: "Other",
          durationMs: 1000,
          size: { w: 10, h: 10 },
          frame: { w: 10, h: 10 },
        }),
        key: "inner",
        trackId: "trk-t",
        startTime: 9000,
      } as TemplateElementType,
    } as unknown as Timeline,
  });
  return {
    id: "neon",
    name: "Neon Intro",
    size: { w: 1080, h: 1920 },
    durationMs: 10_000,
    elements: elements.elements,
    tracks: elements.tracks,
    slots: slotsOf(elements.elements),
    ...over,
  };
}

function placed(over: Partial<TemplateElementType> = {}): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: "neon",
      name: "My Intro",
      durationMs: 10_000,
      size: { w: 1080, h: 1920 },
      frame: { w: 1920, h: 1080 },
    }),
    key: "tpl",
    trackId: "main-v",
    startTime: 2000,
    ...over,
  } as TemplateElementType;
}

function project(element: TimelineElement = placed()): ProjectTimelines {
  return {
    main: {
      tracks: [createTrack("main-v", "video", 0)],
      elements: { tpl: element } as Timeline,
    },
    compositions: {},
  };
}

function counter(prefix = "n") {
  let next = 0;
  return () => `${prefix}${next++}`;
}

const options = (over = {}) => ({
  compositionId: "c1",
  idGen: counter(),
  ...over,
});

describe("forkTemplate", () => {
  it("makes a composition and points the clip at it", () => {
    const before = project(
      placed({ fills: { name: { kind: "text", text: "Ada" } } }),
    );
    const after = forkTemplate(before, "tpl", templateData(), options());

    const clip = after.main.elements.tpl as TemplateElementType;
    expect(clip.templateId).toBe(projectTemplateId("c1"));
    expect(clip.fills).toEqual({});
    expect(clip.startTime).toBe(2000);
    expect(clip.duration).toBe(10_000);

    const composition = after.compositions.c1;
    expect(composition.name).toBe("My Intro");
    expect(composition.size).toEqual({ w: 1080, h: 1920 });
    expect(composition.source).toEqual({ templateId: "neon", name: "Neon Intro" });
  });

  it("bakes the clip's fills into the copy", () => {
    const after = forkTemplate(
      project(
        placed({
          fills: {
            name: { kind: "text", text: "Ada" },
            hero: {
              kind: "media",
              localpath: "file:///me/mine.mp4",
              offsetMs: 1000,
              sourceDurationMs: 9000,
              hasAudio: false,
            },
          },
        }),
      ),
      "tpl",
      templateData(),
      options(),
    );
    const elements = Object.values(after.compositions.c1.elements) as any[];
    expect(elements.find((e) => e.filetype === "text").text).toBe("Ada");
    const hero = elements.find((e) => e.localpath === "file:///me/mine.mp4");
    expect(hero.trim).toEqual({ startTime: 1000, endTime: 3000 });
    expect(hero.isExistAudio).toBe(false);
    // The slot marks stay, so a duplicate of the clip can be filled again.
    expect(slotsOf(after.compositions.c1.elements).map((s) => s.slotId).sort()).toEqual([
      "hero",
      "name",
    ]);
  });

  it("turns a photo filled into a video slot into a still in the copy", () => {
    const after = forkTemplate(
      project(
        placed({
          fills: {
            hero: {
              kind: "media",
              localpath: "file:///me/photo.jpg",
              offsetMs: 0,
              sourceDurationMs: 0,
            },
          },
        }),
      ),
      "tpl",
      templateData(),
      options(),
    );
    const hero = Object.values(after.compositions.c1.elements).find(
      (e: any) => e.localpath === "file:///me/photo.jpg",
    ) as any;
    expect(hero.filetype).toBe("image");
    expect(hero.trim).toBeUndefined();
  });

  it("shares no element or track id with the template", () => {
    const after = forkTemplate(project(), "tpl", templateData(), options());
    const text = JSON.stringify(after.compositions.c1);
    for (const id of OLD_IDS) {
      expect(text).not.toContain(`"${id}"`);
    }
  });

  it("shares no id between two forks of one template", () => {
    const twice: ProjectTimelines = {
      main: {
        tracks: [createTrack("main-v", "video", 0)],
        elements: {
          one: placed({ key: "one" }),
          two: placed({ key: "two", startTime: 20_000 }),
        } as Timeline,
      },
      compositions: {},
    };
    const idGen = counter();
    const first = forkTemplate(twice, "one", templateData(), {
      compositionId: "c1",
      idGen,
    });
    const both = forkTemplate(first, "two", templateData(), {
      compositionId: "c2",
      idGen,
    });
    const ids = (c: any) => [
      ...Object.keys(c.elements),
      ...c.tracks.map((t: any) => t.id),
    ];
    const a = new Set(ids(both.compositions.c1));
    for (const id of ids(both.compositions.c2)) {
      expect(a.has(id)).toBe(false);
    }
  });

  it("keeps every parent, link and transition under the new ids", () => {
    const after = forkTemplate(project(), "tpl", templateData(), options());
    const elements = after.compositions.c1.elements as Record<string, any>;
    const byText = (filetype: string) =>
      Object.entries(elements).filter(([, e]) => e.filetype === filetype);

    const [groupId] = byText("group")[0];
    const [, child] = byText("image")[0];
    expect(child.parentId).toBe(groupId);
    expect(child.link.opacity.from.elementId).toBe(groupId);

    const [, cut] = byText("transition")[0];
    expect(elements[cut.fromId].localpath).toBe("file:///lib/a.mp4");
    expect(elements[cut.toId].localpath).toBe("file:///lib/b.mp4");

    // Already normalized, so normalizing again changes nothing: no reference
    // was left for `repairHierarchy` or `repairTransitions` to drop.
    const again = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: after.compositions.c1.tracks,
      elements: after.compositions.c1.elements,
    });
    expect(Object.keys(again.elements).sort()).toEqual(
      Object.keys(elements).sort(),
    );
    expect(again.elements[Object.keys(elements)[0]]).toEqual(
      elements[Object.keys(elements)[0]],
    );
  });

  it("leaves the nested template out", () => {
    const after = forkTemplate(project(), "tpl", templateData(), options());
    expect(
      Object.values(after.compositions.c1.elements).some(
        (e) => e.filetype === "template",
      ),
    ).toBe(false);
    expect(Object.keys(after.compositions.c1.elements)).toHaveLength(6);
  });

  it("puts every clip on a row of its own document", () => {
    const after = forkTemplate(project(), "tpl", templateData(), options());
    const rows = new Set(after.compositions.c1.tracks.map((t) => t.id));
    for (const element of Object.values(after.compositions.c1.elements)) {
      expect(rows.has(element.trackId)).toBe(true);
    }
  });

  it("gives rows to the clips of a template that carried none", () => {
    const data = templateData({ tracks: [] });
    const after = forkTemplate(project(), "tpl", data, options());
    const { tracks, elements } = after.compositions.c1;
    expect(tracks.length).toBeGreaterThan(0);
    const rows = new Set(tracks.map((t) => t.id));
    for (const element of Object.values(elements)) {
      expect(rows.has(element.trackId)).toBe(true);
    }
    // And the transition rides with its outgoing clip, so it survives.
    const cut = Object.values(elements).find(
      (e) => e.filetype === "transition",
    ) as any;
    expect(cut).toBeDefined();
    expect(elements[cut.fromId].trackId).toBe(cut.trackId);
  });

  it("draws, through the template renderer, what the clip drew", () => {
    // Compared through `composeTemplate`, the map the renderer paints, so a
    // fork that dropped, moved or re-ordered anything would differ here.
    const fills = {
      name: { kind: "text" as const, text: "Ada" },
      hero: {
        kind: "media" as const,
        localpath: "file:///me/mine.mp4",
        offsetMs: 500,
        sourceDurationMs: 9000,
      },
    };
    const data = templateData();
    const clip = placed({ fills });
    const after = forkTemplate(project(clip), "tpl", data, options());

    const before = composeTemplate(data, "tpl", clip);
    const forked = composeTemplate(
      compositionTemplateData(after.compositions.c1, after.compositions.c1),
      "tpl",
      after.main.elements.tpl as TemplateElementType,
    );

    const shape = (map: Timeline) =>
      Object.values(map)
        .map((e: any) => ({
          filetype: e.filetype,
          startTime: e.startTime,
          duration: e.duration,
          localpath: e.localpath,
          text: e.text,
          trim: e.trim,
          priority: e.priority,
          opacity: e.opacity,
        }))
        .sort((x, y) => x.priority - y.priority);
    expect(shape(forked)).toEqual(shape(before));
  });

  it("re-bakes the copy's lanes at the project's rate", () => {
    const data = templateData();
    const animatedKey = Object.keys(data.elements).find(
      (k) => data.elements[k].filetype === "image",
    )!;
    const animated = {
      ...data.elements[animatedKey],
      animation: {
        ...(data.elements[animatedKey] as any).animation,
        opacity: {
          isActivate: true,
          x: keys([0, 0], [1000, 100]),
          ax: points([0, 0], [1000, 100]),
        },
      },
    } as TimelineElement;
    const withLane = {
      ...data,
      elements: { ...data.elements, [animatedKey]: animated },
    };
    const after = forkTemplate(project(), "tpl", withLane, options({ bakeHz: 120 }));
    const copy = Object.values(after.compositions.c1.elements).find(
      (e: any) => e.animation?.opacity?.isActivate,
    ) as any;
    expect(copy.animation.opacity.ax).toEqual(
      bakeTrack(copy.animation.opacity.x, 120),
    );
  });

  it("does not touch the template's own document", () => {
    const data = templateData();
    const snapshot = JSON.stringify(data.elements);
    forkTemplate(
      project(placed({ fills: { name: { kind: "text", text: "Ada" } } })),
      "tpl",
      data,
      options(),
    );
    expect(JSON.stringify(data.elements)).toBe(snapshot);
  });

  describe("declines, by identity,", () => {
    it("for an element that is not a template", () => {
      const p = project(imageElement({ key: "tpl" }) as TimelineElement);
      expect(forkTemplate(p, "tpl", templateData(), options())).toBe(p);
    });

    it("for an element that is not there", () => {
      const p = project();
      expect(forkTemplate(p, "ghost", templateData(), options())).toBe(p);
    });

    it("for a clip that already names a composition", () => {
      const p = project(placed({ templateId: projectTemplateId("c0") }));
      expect(forkTemplate(p, "tpl", templateData(), options())).toBe(p);
    });

    it("for a template other than the one it was handed", () => {
      const p = project(placed({ templateId: "other" }));
      expect(forkTemplate(p, "tpl", templateData(), options())).toBe(p);
    });

    it("for a composition id that is empty or already taken", () => {
      const p = project();
      expect(
        forkTemplate(p, "tpl", templateData(), options({ compositionId: "" })),
      ).toBe(p);
      const taken = forkTemplate(p, "tpl", templateData(), options());
      const again: ProjectTimelines = {
        ...taken,
        main: {
          ...taken.main,
          elements: { ...taken.main.elements, tpl2: placed({ key: "tpl2" }) },
        },
      };
      expect(forkTemplate(again, "tpl2", templateData(), options())).toBe(again);
    });
  });
});
