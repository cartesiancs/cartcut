import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import {
  audioElement,
  effectElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { isReplaceableFiletype, slotsOf } from "./slots";

/**
 * `slotsOf` is the only thing that decides what a template offers to fill, and
 * it decides it by walking the document. There is no slot list in
 * `template.json` on purpose: two sources would drift, and the one that drifted
 * would be the one nobody was looking at.
 */

function doc(elements: Record<string, any>): Timeline {
  return elements as Timeline;
}

describe("what may be a slot", () => {
  it("takes video, image, gif and text", () => {
    const slots = slotsOf(
      doc({
        v: videoElement({ replaceable: { slotId: "a" } }),
        i: imageElement({ replaceable: { slotId: "b" } }),
        g: gifElement({ replaceable: { slotId: "c" } }),
        t: textElement({ replaceable: { slotId: "d" } }),
      }),
    );
    expect(slots.map((slot) => slot.slotId)).toEqual(["a", "b", "c", "d"]);
    expect(slots.map((slot) => slot.kind)).toEqual([
      "media",
      "media",
      "media",
      "text",
    ]);
  });

  it("ignores the mark on a filetype that cannot carry a replacement", () => {
    // A shape's fill, an effect's parameters and a group's transform are
    // settings rather than sources. The field cannot be written on them
    // through `setReplaceable`, so anything here came from a hand-edited file.
    const slots = slotsOf(
      doc({
        s: { ...shapeElement(), replaceable: { slotId: "a" } },
        e: { ...effectElement(), replaceable: { slotId: "b" } },
        gr: { ...groupElement(), replaceable: { slotId: "c" } },
        au: { ...audioElement(), replaceable: { slotId: "d" } },
      }),
    );
    expect(slots).toEqual([]);
  });

  it("ignores an unmarked document entirely", () => {
    expect(slotsOf(doc({ v: videoElement(), t: textElement() }))).toEqual([]);
  });

  it("ignores a mark with no usable slotId", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({ replaceable: { slotId: "" } }),
        b: videoElement({ replaceable: { slotId: "   " } }),
        c: { ...videoElement(), replaceable: { slotId: 7 } },
        d: { ...videoElement(), replaceable: {} },
        e: { ...videoElement(), replaceable: "yes" },
      }),
    );
    expect(slots).toEqual([]);
  });

  it("survives a malformed element without throwing", () => {
    expect(() =>
      slotsOf(doc({ a: null, b: undefined, c: 3, d: "x" })),
    ).not.toThrow();
    expect(slotsOf(doc({ a: null } as any))).toEqual([]);
  });

  it("agrees with isReplaceableFiletype", () => {
    expect(isReplaceableFiletype("video")).toBe(true);
    expect(isReplaceableFiletype("image")).toBe(true);
    expect(isReplaceableFiletype("gif")).toBe(true);
    expect(isReplaceableFiletype("text")).toBe(true);
    expect(isReplaceableFiletype("shape")).toBe(false);
    expect(isReplaceableFiletype("audio")).toBe(false);
    expect(isReplaceableFiletype("template")).toBe(false);
  });
});

describe("one slot, many elements", () => {
  it("groups every element sharing a slotId into one slot", () => {
    // The point of `slotId` not being the element key: the same shot cut in
    // twice is one thing to replace, not two.
    const slots = slotsOf(
      doc({
        first: videoElement({
          startTime: 0,
          replaceable: { slotId: "hero" },
        }),
        second: videoElement({
          startTime: 8000,
          replaceable: { slotId: "hero" },
        }),
      }),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].elementKeys).toEqual(["first", "second"]);
  });

  it("keeps elementKeys sorted so the result cannot go hash-dependent", () => {
    const slots = slotsOf(
      doc({
        zeta: videoElement({ replaceable: { slotId: "one" } }),
        alpha: videoElement({ replaceable: { slotId: "one" } }),
        mid: videoElement({ replaceable: { slotId: "one" } }),
      }),
    );
    expect(slots[0].elementKeys).toEqual(["alpha", "mid", "zeta"]);
  });

  it("takes its kind from the first member and drops members that disagree", () => {
    // Authoring cannot produce this — the context menu mints a fresh slotId —
    // so it is a hand-edited file. Excluding the odd member leaves it holding
    // its placeholder, which is visible and correct; taking it into a slot
    // whose fill has the wrong kind would put text into a video.
    const slots = slotsOf(
      doc({
        a: videoElement({ replaceable: { slotId: "mixed" } }),
        b: textElement({ replaceable: { slotId: "mixed" } }),
      }),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe("media");
    expect(slots[0].elementKeys).toEqual(["a"]);
  });
});

describe("what a slot reports about itself", () => {
  it("takes its span and box from its first member", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({
          duration: 2500,
          width: 640,
          height: 360,
          replaceable: { slotId: "hero" },
        }),
      }),
    );
    expect(slots[0].durationMs).toBe(2500);
    expect(slots[0].width).toBe(640);
    expect(slots[0].height).toBe(360);
  });

  it("prefers the author's label", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({
          replaceable: { slotId: "hero", label: "Opening shot" },
        }),
      }),
    );
    expect(slots[0].label).toBe("Opening shot");
  });

  it("falls back to the source filename for a media slot", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({
          localpath: "file:///tmp/clips/sunset%23final.mp4",
          replaceable: { slotId: "hero" },
        }),
      }),
    );
    // Decoded, because `functions/path.ts#encode` escapes `#` and nothing else.
    expect(slots[0].label).toBe("sunset#final.mp4");
  });

  it("falls back to the text itself for a text slot, on one line", () => {
    const slots = slotsOf(
      doc({
        a: textElement({
          text: "Hello\n  there",
          replaceable: { slotId: "title" },
        }),
      }),
    );
    expect(slots[0].label).toBe("Hello there");
  });

  it("falls back to the slotId when there is nothing else to say", () => {
    const slots = slotsOf(
      doc({
        a: textElement({ text: "   ", replaceable: { slotId: "title" } }),
      }),
    );
    expect(slots[0].label).toBe("title");
  });

  it("takes the first label offered among members sharing a slot", () => {
    const slots = slotsOf(
      doc({
        b: videoElement({ replaceable: { slotId: "hero" } }),
        a: videoElement({ replaceable: { slotId: "hero", label: "Named" } }),
      }),
    );
    expect(slots[0].label).toBe("Named");
  });
});

describe("the order slots are offered in", () => {
  it("reads the template front to back", () => {
    // The panel lists slots in the order they appear on screen, which is the
    // order someone filling them in will meet them.
    const slots = slotsOf(
      doc({
        late: videoElement({
          startTime: 9000,
          replaceable: { slotId: "outro" },
        }),
        early: videoElement({
          startTime: 0,
          replaceable: { slotId: "intro" },
        }),
        mid: textElement({
          startTime: 4000,
          replaceable: { slotId: "title" },
        }),
      }),
    );
    expect(slots.map((slot) => slot.slotId)).toEqual([
      "intro",
      "title",
      "outro",
    ]);
  });

  it("breaks a tie on slotId so the order is deterministic", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({ startTime: 0, replaceable: { slotId: "zebra" } }),
        b: videoElement({ startTime: 0, replaceable: { slotId: "apple" } }),
      }),
    );
    expect(slots.map((slot) => slot.slotId)).toEqual(["apple", "zebra"]);
  });

  it("dates a slot by its earliest member", () => {
    const slots = slotsOf(
      doc({
        a: videoElement({ startTime: 9000, replaceable: { slotId: "hero" } }),
        b: videoElement({ startTime: 1000, replaceable: { slotId: "hero" } }),
        c: videoElement({ startTime: 5000, replaceable: { slotId: "other" } }),
      }),
    );
    expect(slots.map((slot) => slot.slotId)).toEqual(["hero", "other"]);
  });
});
