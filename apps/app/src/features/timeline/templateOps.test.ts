import { describe, expect, it } from "vitest";
import type { TemplateElementType } from "../../@types/timeline";
import {
  audioElement,
  gifElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import {
  addTemplate,
  clearReplaceable,
  createTemplateElement,
  isDurationLocked,
  isReplaceable,
  replaceableOf,
  setReplaceable,
  setTemplateFill,
  setTemplateFillOffset,
} from "./templateOps";
import { createTrack, SCHEMA_VERSION, type TimelineDocument } from "./tracks";

function doc(elements: Record<string, any> = {}): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  } as TimelineDocument;
}

function template(over: Partial<TemplateElementType> = {}) {
  return createTemplateElement({
    templateId: "neon",
    name: "Neon Intro",
    durationMs: 6000,
    size: { w: 1920, h: 1080 },
    frame: { w: 1920, h: 1080 },
    ...(over as any),
  });
}

let counter = 0;
const idGen = () => `slot${counter++}`;

describe("createTemplateElement", () => {
  it("builds a template element with no fills", () => {
    const element = template();
    expect(element.filetype).toBe("template");
    expect(element.templateId).toBe("neon");
    expect(element.name).toBe("Neon Intro");
    expect(element.fills).toEqual({});
    expect(element.duration).toBe(6000);
  });

  it("carries the sentinel localpath, so no relinker looks for a file", () => {
    expect(template().localpath).toBe("TEMPLATE");
  });

  it("seeds all five animation tracks", () => {
    // The unconditional half of the keyframe contract: an element whose
    // stopwatch does nothing is worse than one that cannot be animated.
    expect(Object.keys(template().animation).sort()).toEqual([
      "opacity",
      "position",
      "rotation",
      "scale",
      "size",
    ]);
  });

  it("fills the project frame when the aspects match", () => {
    const element = template();
    expect(element.width).toBe(1920);
    expect(element.height).toBe(1080);
    expect(element.location).toEqual({ x: 0, y: 0 });
  });

  it("fits a portrait template inside a landscape project, centred", () => {
    const element = createTemplateElement({
      templateId: "t",
      name: "T",
      durationMs: 1000,
      size: { w: 1080, h: 1920 },
      frame: { w: 1920, h: 1080 },
    });
    // Contained by height: 1080/1920 = 0.5625.
    expect(element.height).toBe(1080);
    expect(element.width).toBe(607.5);
    expect(element.location.y).toBe(0);
    expect(element.location.x).toBeCloseTo((1920 - 607.5) / 2, 5);
  });

  it("survives a template claiming no size", () => {
    const element = createTemplateElement({
      templateId: "t",
      name: "T",
      durationMs: 1000,
      size: { w: 0, h: 0 },
      frame: { w: 1920, h: 1080 },
    });
    expect(element.width).toBe(1920);
    expect(element.height).toBe(1080);
  });

  it("leaves trackId and priority for placement to fill", () => {
    // The rule `createNullElement` states: a factory decides what the element
    // is, `placeNewElement` decides where it goes.
    const element = template();
    expect(element.trackId).toBe("");
    expect(element.priority).toBe(0);
  });
});

describe("addTemplate", () => {
  it("places the element on a video track", () => {
    const next = addTemplate(doc(), "tpl", template(), 0, "new-track");
    expect(next.elements.tpl).toBeDefined();
    const trackId = next.elements.tpl.trackId;
    expect(next.tracks.find((t) => t.id === trackId)?.kind).toBe("video");
  });

  it("reuses a free video track rather than adding one", () => {
    const next = addTemplate(doc(), "tpl", template(), 0, "new-track");
    expect(next.tracks).toHaveLength(1);
    expect(next.elements.tpl.trackId).toBe("v1");
  });

  it("clamps a negative start to zero", () => {
    const next = addTemplate(doc(), "tpl", template(), -500, "new-track");
    expect(next.elements.tpl.startTime).toBe(0);
  });

  it("derives a priority through normalizeDocument", () => {
    const next = addTemplate(doc(), "tpl", template(), 0, "new-track");
    expect(next.elements.tpl.priority).toBeGreaterThan(0);
  });

  it("lets two templates live in one project", () => {
    let next = addTemplate(doc(), "a", template(), 0, "t2");
    next = addTemplate(next, "b", template(), 10_000, "t3");
    expect(next.elements.a.filetype).toBe("template");
    expect(next.elements.b.filetype).toBe("template");
    expect(next.elements.b.startTime).toBe(10_000);
  });
});

describe("isDurationLocked", () => {
  it("is true for a template and false for everything else", () => {
    expect(isDurationLocked(template() as any)).toBe(true);
    for (const element of [
      videoElement(),
      imageElement(),
      gifElement(),
      textElement(),
      shapeElement(),
      audioElement(),
    ]) {
      expect(isDurationLocked(element)).toBe(false);
    }
  });

  it("answers false rather than throwing on nothing", () => {
    expect(isDurationLocked(undefined)).toBe(false);
    expect(isDurationLocked(null)).toBe(false);
  });
});

describe("setTemplateFill", () => {
  const withTemplate = () => doc({ tpl: { ...template(), key: "tpl" } });

  it("records a media fill", () => {
    const next = setTemplateFill(withTemplate(), "tpl", "hero", {
      kind: "media",
      localpath: "file:///me/mine.mp4",
      offsetMs: 0,
      sourceDurationMs: 9000,
    });
    expect((next.elements.tpl as TemplateElementType).fills.hero).toEqual({
      kind: "media",
      localpath: "file:///me/mine.mp4",
      offsetMs: 0,
      sourceDurationMs: 9000,
    });
  });

  it("records a text fill", () => {
    const next = setTemplateFill(withTemplate(), "tpl", "name", {
      kind: "text",
      text: "JUN",
    });
    expect((next.elements.tpl as TemplateElementType).fills.name).toEqual({
      kind: "text",
      text: "JUN",
    });
  });

  it("clears a fill with null, deleting the key", () => {
    const filled = setTemplateFill(withTemplate(), "tpl", "name", {
      kind: "text",
      text: "JUN",
    });
    const cleared = setTemplateFill(filled, "tpl", "name", null);
    const fills = (cleared.elements.tpl as TemplateElementType).fills;
    expect("name" in fills).toBe(false);
  });

  it("leaves other fills alone", () => {
    let next = setTemplateFill(withTemplate(), "tpl", "a", {
      kind: "text",
      text: "one",
    });
    next = setTemplateFill(next, "tpl", "b", { kind: "text", text: "two" });
    const fills = (next.elements.tpl as TemplateElementType).fills;
    expect(Object.keys(fills).sort()).toEqual(["a", "b"]);
  });

  it("does not mutate the element it replaces", () => {
    const before = withTemplate();
    const original = before.elements.tpl as TemplateElementType;
    setTemplateFill(before, "tpl", "name", { kind: "text", text: "JUN" });
    expect(original.fills).toEqual({});
  });

  describe("declines by identity", () => {
    it("on an element that does not exist", () => {
      const before = withTemplate();
      expect(
        setTemplateFill(before, "ghost", "a", { kind: "text", text: "x" }),
      ).toBe(before);
    });

    it("on an element that is not a template", () => {
      const before = doc({ v: videoElement() });
      expect(
        setTemplateFill(before, "v", "a", { kind: "text", text: "x" }),
      ).toBe(before);
    });

    it("on an empty slot id", () => {
      const before = withTemplate();
      expect(
        setTemplateFill(before, "tpl", "", { kind: "text", text: "x" }),
      ).toBe(before);
    });

    it("on clearing a slot that was never filled", () => {
      const before = withTemplate();
      expect(setTemplateFill(before, "tpl", "never", null)).toBe(before);
    });

    it("on writing the fill that is already there", () => {
      const filled = setTemplateFill(withTemplate(), "tpl", "name", {
        kind: "text",
        text: "JUN",
      });
      expect(
        setTemplateFill(filled, "tpl", "name", { kind: "text", text: "JUN" }),
      ).toBe(filled);
    });

    it("on a malformed fill", () => {
      const before = withTemplate();
      expect(setTemplateFill(before, "tpl", "a", {} as any)).toBe(before);
      expect(
        setTemplateFill(before, "tpl", "a", {
          kind: "media",
          localpath: "",
          offsetMs: 0,
          sourceDurationMs: 0,
        }),
      ).toBe(before);
    });
  });
});

describe("setTemplateFillOffset", () => {
  const filled = () =>
    setTemplateFill(doc({ tpl: { ...template(), key: "tpl" } }), "tpl", "hero", {
      kind: "media",
      localpath: "file:///me/mine.mp4",
      offsetMs: 0,
      sourceDurationMs: 30_000,
    });

  it("moves the in-point", () => {
    const next = setTemplateFillOffset(filled(), "tpl", "hero", 4000);
    const fill = (next.elements.tpl as TemplateElementType).fills.hero;
    expect(fill).toMatchObject({ offsetMs: 4000 });
  });

  it("clamps below zero", () => {
    const next = setTemplateFillOffset(filled(), "tpl", "hero", -9);
    expect(
      (next.elements.tpl as TemplateElementType).fills.hero,
    ).toMatchObject({ offsetMs: 0 });
  });

  it("clamps past the end of the source", () => {
    const next = setTemplateFillOffset(filled(), "tpl", "hero", 99_000);
    expect(
      (next.elements.tpl as TemplateElementType).fills.hero,
    ).toMatchObject({ offsetMs: 30_000 });
  });

  it("declines on a slot with no fill", () => {
    const before = filled();
    expect(setTemplateFillOffset(before, "tpl", "other", 100)).toBe(before);
  });

  it("declines on a text fill, which has no in-point", () => {
    const before = setTemplateFill(
      doc({ tpl: { ...template(), key: "tpl" } }),
      "tpl",
      "name",
      { kind: "text", text: "JUN" },
    );
    expect(setTemplateFillOffset(before, "tpl", "name", 100)).toBe(before);
  });

  it("declines on the offset it already has", () => {
    const before = filled();
    expect(setTemplateFillOffset(before, "tpl", "hero", 0)).toBe(before);
  });
});

describe("setReplaceable", () => {
  it("marks a clip with a fresh slot id", () => {
    counter = 0;
    const next = setReplaceable(doc({ v: videoElement() }), ["v"], idGen);
    expect(replaceableOf(next, "v")).toEqual({ slotId: "slot0" });
  });

  it("gives each clip in a selection its own slot", () => {
    // One mark is one thing to replace. Grouping two clips under one id is a
    // deliberate act, not what marking a multi-selection should mean.
    counter = 0;
    const next = setReplaceable(
      doc({ a: videoElement(), b: imageElement() }),
      ["a", "b"],
      idGen,
    );
    expect(replaceableOf(next, "a")?.slotId).toBe("slot0");
    expect(replaceableOf(next, "b")?.slotId).toBe("slot1");
  });

  it("records a label when one is given", () => {
    counter = 0;
    const next = setReplaceable(
      doc({ v: videoElement() }),
      ["v"],
      idGen,
      "Opening shot",
    );
    expect(replaceableOf(next, "v")).toEqual({
      slotId: "slot0",
      label: "Opening shot",
    });
  });

  it("marks text, image and gif as readily as video", () => {
    counter = 0;
    const next = setReplaceable(
      doc({ t: textElement(), i: imageElement(), g: gifElement() }),
      ["t", "i", "g"],
      idGen,
    );
    expect(replaceableOf(next, "t")).not.toBeNull();
    expect(replaceableOf(next, "i")).not.toBeNull();
    expect(replaceableOf(next, "g")).not.toBeNull();
  });

  it("marks what it can and skips what it cannot", () => {
    counter = 0;
    const next = setReplaceable(
      doc({ v: videoElement(), s: shapeElement() }),
      ["v", "s"],
      idGen,
    );
    expect(replaceableOf(next, "v")).not.toBeNull();
    expect(replaceableOf(next, "s")).toBeNull();
  });

  describe("declines by identity", () => {
    it("on an empty selection", () => {
      const before = doc({ v: videoElement() });
      expect(setReplaceable(before, [], idGen)).toBe(before);
    });

    it("on a selection of only unmarkable clips", () => {
      const before = doc({ s: shapeElement(), a: audioElement() });
      expect(setReplaceable(before, ["s", "a"], idGen)).toBe(before);
    });

    it("on an id that names nothing", () => {
      const before = doc({ v: videoElement() });
      expect(setReplaceable(before, ["ghost"], idGen)).toBe(before);
    });

    it("on a clip that is already marked", () => {
      // Re-marking must not churn the slot id: fills in a project that already
      // uses this template are keyed on it.
      counter = 0;
      const marked = setReplaceable(doc({ v: videoElement() }), ["v"], idGen);
      expect(setReplaceable(marked, ["v"], idGen)).toBe(marked);
    });

    it("on a template, which cannot itself be a slot", () => {
      const before = doc({ tpl: { ...template(), key: "tpl" } });
      expect(setReplaceable(before, ["tpl"], idGen)).toBe(before);
    });
  });
});

describe("clearReplaceable", () => {
  it("removes the mark, deleting the key", () => {
    counter = 0;
    const marked = setReplaceable(doc({ v: videoElement() }), ["v"], idGen);
    const cleared = clearReplaceable(marked, ["v"]);
    expect("replaceable" in cleared.elements.v).toBe(false);
  });

  it("clears a whole selection as one document", () => {
    counter = 0;
    const marked = setReplaceable(
      doc({ a: videoElement(), b: imageElement() }),
      ["a", "b"],
      idGen,
    );
    const cleared = clearReplaceable(marked, ["a", "b"]);
    expect(replaceableOf(cleared, "a")).toBeNull();
    expect(replaceableOf(cleared, "b")).toBeNull();
  });

  it("declines on a selection with nothing marked", () => {
    const before = doc({ v: videoElement() });
    expect(clearReplaceable(before, ["v"])).toBe(before);
  });

  it("declines on an empty selection", () => {
    const before = doc({ v: videoElement() });
    expect(clearReplaceable(before, [])).toBe(before);
  });
});

describe("isReplaceable", () => {
  it("agrees with what setReplaceable will accept", () => {
    expect(isReplaceable(videoElement())).toBe(true);
    expect(isReplaceable(imageElement())).toBe(true);
    expect(isReplaceable(gifElement())).toBe(true);
    expect(isReplaceable(textElement())).toBe(true);
    expect(isReplaceable(shapeElement())).toBe(false);
    expect(isReplaceable(audioElement())).toBe(false);
    expect(isReplaceable(template() as any)).toBe(false);
    expect(isReplaceable(undefined)).toBe(false);
  });
});
