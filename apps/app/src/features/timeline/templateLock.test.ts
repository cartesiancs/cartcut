import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import { detachAudioFrom } from "./audioOps";
import { splitAt, trimEnd, trimStart } from "./clipEdit";
import { splitAtPlayhead, splitClip, trimClipEnd, trimClipStart } from "./clipOps";
import { isDurationLocked, spanLength } from "./geometry";
import { hitTest, layoutTimeline } from "./layout";
import { canMergeClips, mergeClips } from "./mergeOps";
import { canRasterize } from "./rasterize";
import { setClipSpeed } from "./speedOps";
import { createTemplateElement } from "./templateOps";
import { createTrack, SCHEMA_VERSION, type TimelineDocument } from "./tracks";

/**
 * **A template's length belongs to its author.** That is the whole of this
 * suite: every operation that would change one declines by identity, so
 * `withCheckpoint` records no undo step and a user who tries costs themselves
 * nothing.
 *
 * Two of these are real hazards rather than tidiness, and both would have been
 * silent. `splitAt` takes its non-dynamic branch for anything without a `trim`,
 * so it would happily cut a template into two halves that each render the whole
 * thing. And `mergeOps#canJoin` decides two clips share a source by comparing
 * `localpath` — every template carries the same `"TEMPLATE"` sentinel, so two
 * *different* templates sitting next to each other looked like two halves of
 * one cut.
 */

function template(over: Record<string, any> = {}) {
  return {
    ...createTemplateElement({
      templateId: "neon",
      name: "Neon Intro",
      durationMs: 6000,
      size: { w: 1920, h: 1080 },
      frame: { w: 1920, h: 1080 },
    }),
    trackId: "v1",
    key: "tpl",
    ...over,
  };
}

function doc(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
    elements,
  } as TimelineDocument;
}

describe("the primitives in clipEdit", () => {
  it("splitAt refuses a template", () => {
    expect(splitAt(template() as any, 3000)).toBeNull();
  });

  it("splitAt still cuts an ordinary clip, so the guard is not a blanket", () => {
    expect(splitAt(videoElement({ duration: 4000 }), 2000)).not.toBeNull();
  });

  it("trimStart returns the element by identity", () => {
    const element = template() as any;
    expect(trimStart(element, 500)).toBe(element);
  });

  it("trimEnd returns the element by identity", () => {
    const element = template() as any;
    expect(trimEnd(element, -500)).toBe(element);
  });
});

describe("the document ops", () => {
  it("splitClip declines", () => {
    const before = doc({ tpl: template() });
    expect(splitClip(before, "tpl", 3000, "new")).toBe(before);
  });

  it("splitAtPlayhead declines, and adds no element", () => {
    const before = doc({ tpl: template() });
    const after = splitAtPlayhead(before, ["tpl"], 3000, () => "new");
    expect(after).toBe(before);
    expect(Object.keys(after.elements)).toEqual(["tpl"]);
  });

  it("trimClipStart declines", () => {
    const before = doc({ tpl: template() });
    expect(trimClipStart(before, "tpl", 500)).toBe(before);
  });

  it("trimClipEnd declines", () => {
    const before = doc({ tpl: template() });
    expect(trimClipEnd(before, "tpl", -500)).toBe(before);
  });

  it("setClipSpeed declines", () => {
    const before = doc({ tpl: template() });
    expect(setClipSpeed(before, "tpl", 2)).toBe(before);
  });

  it("detachAudioFrom declines", () => {
    const before = doc({ tpl: template() });
    expect(detachAudioFrom(before, ["tpl"], () => "new")).toBe(before);
  });

  it("canRasterize is false", () => {
    expect(canRasterize(template() as any)).toBe(false);
  });
});

describe("merging", () => {
  it("refuses two adjacent templates that only look alike", () => {
    // Both carry `localpath: "TEMPLATE"` and `filetype: "template"`, which is
    // every test `canJoin` used to apply. Merged, one would vanish and the
    // other would claim its span while still rendering its own six seconds.
    const before = doc({
      a: template({ key: "a", startTime: 0, duration: 6000 }),
      b: template({
        key: "b",
        templateId: "other",
        name: "Other",
        startTime: 6000,
        duration: 6000,
      }),
    });
    expect(canMergeClips(before, ["a", "b"])).toBe(false);
    expect(mergeClips(before, ["a", "b"])).toBe(before);
  });

  it("refuses two adjacent instances of the very same template", () => {
    const before = doc({
      a: template({ key: "a", startTime: 0, duration: 6000 }),
      b: template({ key: "b", startTime: 6000, duration: 6000 }),
    });
    expect(canMergeClips(before, ["a", "b"])).toBe(false);
  });
});

describe("what a template may still do", () => {
  it("reports a span like any other clip", () => {
    // The guard is on changing the length, not on knowing it. Layout, overlap
    // and placement all ask.
    expect(spanLength(template() as any)).toBe(6000);
  });

  it("is static rather than an unlisted filetype", () => {
    // `utils/element.ts` warns that an unlisted filetype answers "undefined",
    // which is neither dynamic nor static, and that call sites testing for
    // "static" explicitly would drop it silently.
    expect(isDurationLocked(template() as any)).toBe(true);
  });
});

describe("the timeline offers no trim handles", () => {
  it("reports every part of a template's bar as body", () => {
    // The rule the context menu already keeps, applied to a drag affordance:
    // an offer that could only decline is not made. A trim handle is worse
    // than a dead menu item, because it also changes the cursor and swallows
    // the drag that would have moved the clip.
    const layout = layoutTimeline({
      doc: doc({ tpl: template({ startTime: 0, duration: 6000 }) }),
      range: 1,
      hScroll: 0,
      vScroll: 0,
      viewportW: 2000,
      viewportH: 400,
    });

    const clip = layout.clips.find((c) => c.elementId === "tpl");
    expect(clip?.lockedDuration).toBe(true);

    const y = clip!.y + clip!.h / 2;
    for (const x of [clip!.x + 1, clip!.x + clip!.w / 2, clip!.x + clip!.w - 1]) {
      const hit = hitTest(layout, x, y);
      expect(hit.kind).toBe("clip");
      expect(hit.kind === "clip" && hit.zone).toBe("body");
    }
  });

  it("still offers them on an ordinary clip", () => {
    const layout = layoutTimeline({
      doc: doc({ v: { ...videoElement({ duration: 6000 }), trackId: "v1" } }),
      range: 1,
      hScroll: 0,
      vScroll: 0,
      viewportW: 2000,
      viewportH: 400,
    });
    const clip = layout.clips.find((c) => c.elementId === "v");
    expect(clip?.lockedDuration).toBeUndefined();
    const hit = hitTest(layout, clip!.x + 1, clip!.y + clip!.h / 2);
    expect(hit.kind === "clip" && hit.zone).toBe("trimStart");
  });
});
