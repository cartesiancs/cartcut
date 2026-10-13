import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { imageElement } from "../renderer/testing";
import { createTrack } from "../timeline/tracks";
import { compositionTemplateData } from "./templateData";

/**
 * The renderer memoizes on the identity of what `templateFor` answers, so the
 * answer for a composition must be the same object until its content changes,
 * and a new one the moment it does.
 */

const meta = { id: "c1", name: "Intro", size: { w: 640, h: 360 } };
const content = () => ({
  tracks: [createTrack("t", "video", 0)],
  elements: {
    a: imageElement({
      trackId: "t",
      startTime: 500,
      duration: 1500,
      replaceable: { slotId: "hero" },
    }),
  } as Timeline,
});

describe("compositionTemplateData", () => {
  it("answers what the template renderer reads", () => {
    const c = content();
    const data = compositionTemplateData(meta, c);
    expect(data.id).toBe("project:c1");
    expect(data.name).toBe("Intro");
    expect(data.size).toEqual({ w: 640, h: 360 });
    expect(data.durationMs).toBe(2000);
    expect(data.elements).toBe(c.elements);
    expect(data.tracks).toBe(c.tracks);
    expect(data.slots.map((s) => s.slotId)).toEqual(["hero"]);
  });

  it("answers the same object for the same content", () => {
    const c = content();
    expect(compositionTemplateData(meta, c)).toBe(compositionTemplateData(meta, c));
    expect(compositionTemplateData(meta, { ...c })).toBe(
      compositionTemplateData(meta, c),
    );
  });

  it("answers a new object once the content or the name changes", () => {
    const c = content();
    const first = compositionTemplateData(meta, c);
    expect(
      compositionTemplateData(meta, { ...c, elements: { ...c.elements } }),
    ).not.toBe(first);
    expect(compositionTemplateData({ ...meta, name: "Outro" }, c)).not.toBe(first);
    expect(
      compositionTemplateData(meta, { ...c, tracks: [...c.tracks] }),
    ).not.toBe(first);
  });
});
