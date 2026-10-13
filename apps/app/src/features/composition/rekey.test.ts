import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import {
  groupElement,
  imageElement,
  transitionElement,
  videoElement,
} from "../renderer/testing";
import { createTrack } from "../timeline/tracks";
import { adoptOrphans, rekeyContent } from "./rekey";

function counter() {
  let n = 0;
  return () => `id${n++}`;
}

describe("rekeyContent", () => {
  const content = () => ({
    tracks: [createTrack("t1", "video", 0)],
    elements: {
      g: groupElement({ key: "g", trackId: "t1" }),
      kid: imageElement({
        key: "kid",
        trackId: "t1",
        parentId: "g",
        link: {
          opacity: {
            from: { elementId: "g", property: "rotation" },
            in: [0, 1],
            out: [0, 1],
          },
        },
      } as never),
      stray: imageElement({ key: "stray", trackId: "t1", parentId: "elsewhere" }),
      a: videoElement({ key: "a", trackId: "t1" }),
      b: videoElement({ key: "b", trackId: "t1" }),
      cut: transitionElement({ key: "cut", trackId: "t1", fromId: "a", toId: "b" }),
    } as unknown as Timeline,
  });

  it("renames every element, its key, its row, and every row", () => {
    const next = rekeyContent(content(), counter());
    expect(next.tracks.map((t) => t.id)).toEqual(["id0"]);
    for (const [id, element] of Object.entries(next.elements)) {
      expect(id.startsWith("id")).toBe(true);
      expect(element.key).toBe(id);
      expect(element.trackId).toBe("id0");
    }
    expect(Object.keys(next.elements)).toHaveLength(6);
  });

  it("follows every reference to its new name", () => {
    const next = rekeyContent(content(), counter()).elements as any;
    const find = (pred: (e: any) => boolean): [string, any] =>
      (Object.entries(next) as Array<[string, any]>).find(([, e]) => pred(e))!;
    const [groupId] = find((e) => e.filetype === "group");
    const [, kid] = find((e) => e.parentId === groupId);
    expect(kid.link.opacity.from.elementId).toBe(groupId);
    const [, cut] = find((e) => e.filetype === "transition");
    expect(next[cut.fromId].filetype).toBe("video");
    expect(next[cut.toId].filetype).toBe("video");
    expect(cut.fromId).not.toBe(cut.toId);
  });

  it("drops a parent that names something outside the document", () => {
    const next = rekeyContent(content(), counter()).elements as any;
    const stray = Object.values(next).find(
      (e: any) => e.filetype === "image" && e.link == null,
    ) as any;
    expect("parentId" in stray).toBe(false);
  });

  it("leaves no old id anywhere", () => {
    const text = JSON.stringify(rekeyContent(content(), counter()));
    for (const id of ["g", "kid", "stray", "a", "b", "cut", "t1"]) {
      expect(text).not.toContain(`"${id}"`);
    }
  });
});

describe("adoptOrphans", () => {
  it("returns its input by identity when every clip has a row", () => {
    const content = {
      tracks: [createTrack("t1", "video", 0)],
      elements: { a: imageElement({ trackId: "t1" }) } as Timeline,
    };
    expect(adoptOrphans(content, counter())).toBe(content);
  });

  it("gives overlapping orphans rows that do not collide", () => {
    const content = {
      tracks: [],
      elements: {
        a: imageElement({ trackId: "gone", startTime: 0, duration: 2000 }),
        b: imageElement({ trackId: "gone", startTime: 1000, duration: 2000 }),
      } as Timeline,
    };
    const next = adoptOrphans(content, counter());
    expect(next.tracks).toHaveLength(2);
    expect(next.elements.a.trackId).not.toBe(next.elements.b.trackId);
  });

  it("keeps the order the template painted in", () => {
    // `paintOrder` puts the later of two trackless clips in front, so after
    // adoption the later one's row is above (lower index).
    const content = {
      tracks: [],
      elements: {
        back: imageElement({ trackId: "", startTime: 0, duration: 2000 }),
        front: imageElement({ trackId: "", startTime: 500, duration: 2000 }),
      } as Timeline,
    };
    const next = adoptOrphans(content, counter());
    const index = (id: string) =>
      next.tracks.find((t) => t.id === next.elements[id].trackId)!.index;
    // Priority 1 is the back of the composite.
    expect(next.elements.back.priority).toBeLessThan(next.elements.front.priority);
    expect(index("front")).toBeLessThan(index("back"));
  });
});
