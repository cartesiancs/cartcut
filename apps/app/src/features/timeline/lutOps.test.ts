import { describe, expect, it } from "vitest";

import { lutOf } from "../renderer/lut";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { addEffect } from "./effectOps";
import {
  GRADABLE_FILETYPES,
  isGradable,
  lutRefOf,
  setClipLut,
  setClipLutIntensity,
  setClipLutIntensityMany,
  setClipLutMany,
} from "./lutOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

/**
 * One clip of every type, on rows that can hold them.
 *
 * Built through `normalizeDocument` so `priority` and the track links are the
 * ones the renderer would actually see — a hand-built map would let an op pass
 * here and fail against a real document.
 */
function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v0", "video", 0),
      createTrack("a0", "audio", 1),
      createTrack("g0", "video", 2),
    ],
    elements: {
      video: videoElement({ trackId: "v0", startTime: 0, duration: 4000 }),
      image: imageElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
      gif: gifElement({ trackId: "v0", startTime: 5000, duration: 1000 }),
      shape: shapeElement({ trackId: "v0", startTime: 6000, duration: 1000 }),
      text: textElement({ trackId: "v0", startTime: 7000, duration: 1000 }),
      sound: audioElement({ trackId: "a0", startTime: 0, duration: 4000 }),
      group: groupElement({ trackId: "g0", startTime: 0, duration: 4000 }),
    },
  });
}

const CLIPS = ["video", "image", "gif", "shape", "text"] as const;

describe("GRADABLE_FILETYPES", () => {
  it("is exactly the types that paint themselves as a layer", () => {
    expect([...GRADABLE_FILETYPES].sort()).toEqual([
      "gif",
      "image",
      "shape",
      "text",
      "video",
    ]);
  });

  it("recognises each of them, and nothing else", () => {
    const d = doc();
    for (const id of CLIPS) {
      expect(isGradable(d.elements[id])).toBe(true);
    }
    for (const id of ["sound", "group"]) {
      expect(isGradable(d.elements[id])).toBe(false);
    }
    expect(isGradable(undefined)).toBe(false);
    expect(isGradable(null)).toBe(false);
  });
});

describe("setClipLut", () => {
  it.each(CLIPS)("grades a %s clip at full strength by default", (id) => {
    const next = setClipLut(doc(), id, "com.cartcut.lut.kodak");
    expect(lutRefOf(next, id)).toEqual({
      presetId: "com.cartcut.lut.kodak",
      intensity: 100,
    });
  });

  it("takes an explicit intensity", () => {
    const next = setClipLut(doc(), "video", "a", 42);
    expect(lutRefOf(next, "video")?.intensity).toBe(42);
  });

  it("clamps an intensity outside 0..100", () => {
    expect(lutRefOf(setClipLut(doc(), "video", "a", -5), "video")?.intensity).toBe(0);
    expect(lutRefOf(setClipLut(doc(), "video", "a", 900), "video")?.intensity).toBe(
      100,
    );
  });

  // Trying five LUTs at 40% should compare five LUTs at 40%.
  it("carries an existing intensity across a change of LUT", () => {
    const dimmed = setClipLut(doc(), "video", "a", 30);
    const swapped = setClipLut(dimmed, "video", "b");
    expect(lutRefOf(swapped, "video")).toEqual({ presetId: "b", intensity: 30 });
  });

  it("does not touch any other clip", () => {
    const next = setClipLut(doc(), "video", "a");
    for (const id of CLIPS.filter((c) => c !== "video")) {
      expect(lutRefOf(next, id)).toBeNull();
    }
  });

  // A LUT id names a file that may be installed on one machine and not
  // another. Refusing to store it would lose the grade on every round trip
  // through a computer that lacks the LUT.
  it("stores a preset id nothing has heard of", () => {
    const next = setClipLut(doc(), "video", "not-installed-anywhere");
    expect(lutRefOf(next, "video")?.presetId).toBe("not-installed-anywhere");
  });
});

describe("setClipLut — clearing", () => {
  it("removes the key rather than storing a null", () => {
    const graded = setClipLut(doc(), "video", "a");
    const cleared = setClipLut(graded, "video", null);
    expect(lutRefOf(cleared, "video")).toBeNull();
    // The saved project must match the one in memory, and `JSON.stringify`
    // drops an `undefined` — so the key has to be gone, not blanked.
    expect("lut" in cleared.elements.video).toBe(false);
    expect(JSON.parse(JSON.stringify(cleared)).elements.video.lut).toBeUndefined();
  });

  it("leaves an ungraded project byte-identical to one written before the feature", () => {
    const before = doc();
    const after = setClipLut(setClipLut(before, "video", "a"), "video", null);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe("setClipLut — declining", () => {
  // `withCheckpoint` reads identity to mean "nothing happened" and records no
  // undo step, so every one of these costs the user nothing.
  it("declines by identity for an id that is not in the document", () => {
    const d = doc();
    expect(setClipLut(d, "nope", "a")).toBe(d);
  });

  it.each(["sound", "group"])("declines by identity for a %s", (id) => {
    const d = doc();
    expect(setClipLut(d, id, "a")).toBe(d);
  });

  it("declines by identity for an effect element", () => {
    // An adjustment layer carries its LUT as its `presetId`, not as a `lut`
    // field — grading a grade would be a field nothing reads.
    const d = addEffect(doc(), "fx", "com.cartcut.lut.kodak", 0, 1000, "e0", {});
    expect(setClipLut(d, "fx", "a")).toBe(d);
  });

  it("declines when the clip already has exactly that grade", () => {
    const graded = setClipLut(doc(), "video", "a", 60);
    expect(setClipLut(graded, "video", "a", 60)).toBe(graded);
  });

  it("declines when clearing a clip that has no grade", () => {
    const d = doc();
    expect(setClipLut(d, "video", null)).toBe(d);
  });

  it("does not decline when only the intensity differs", () => {
    const graded = setClipLut(doc(), "video", "a", 60);
    expect(setClipLut(graded, "video", "a", 61)).not.toBe(graded);
  });
});

describe("setClipLutIntensity", () => {
  it("changes the strength and keeps the LUT", () => {
    const graded = setClipLut(doc(), "video", "a");
    const dimmed = setClipLutIntensity(graded, "video", 25);
    expect(lutRefOf(dimmed, "video")).toEqual({ presetId: "a", intensity: 25 });
  });

  it("allows zero, which is a stored A/B rather than a clear", () => {
    const off = setClipLutIntensity(setClipLut(doc(), "video", "a"), "video", 0);
    expect(lutRefOf(off, "video")).toEqual({ presetId: "a", intensity: 0 });
  });

  it("declines by identity on a clip with no grade", () => {
    const d = doc();
    expect(setClipLutIntensity(d, "video", 50)).toBe(d);
  });

  it("declines by identity when the strength is unchanged", () => {
    const graded = setClipLut(doc(), "video", "a", 70);
    expect(setClipLutIntensity(graded, "video", 70)).toBe(graded);
  });
});

describe("the many-clip forms", () => {
  it("grade every listed clip in one document", () => {
    const next = setClipLutMany(doc(), [...CLIPS], "a", 80);
    for (const id of CLIPS) {
      expect(lutRefOf(next, id)).toEqual({ presetId: "a", intensity: 80 });
    }
  });

  it("skip the ids that cannot be graded and still change the rest", () => {
    const next = setClipLutMany(doc(), ["video", "sound", "group", "text"], "a");
    expect(lutRefOf(next, "video")?.presetId).toBe("a");
    expect(lutRefOf(next, "text")?.presetId).toBe("a");
    expect("lut" in next.elements.sound).toBe(false);
    expect("lut" in next.elements.group).toBe(false);
  });

  // One call naming only impossible ids has to come back identical, or it
  // records an undo step that undoes nothing.
  it("decline by identity when nothing in the list can be graded", () => {
    const d = doc();
    expect(setClipLutMany(d, ["sound", "group", "nope"], "a")).toBe(d);
    expect(setClipLutMany(d, [], "a")).toBe(d);
  });

  it("decline by identity when every clip already has that grade", () => {
    const graded = setClipLutMany(doc(), [...CLIPS], "a", 80);
    expect(setClipLutMany(graded, [...CLIPS], "a", 80)).toBe(graded);
  });

  it("change the strength across a selection", () => {
    const graded = setClipLutMany(doc(), ["video", "image"], "a");
    const dimmed = setClipLutIntensityMany(graded, ["video", "image"], 10);
    expect(lutRefOf(dimmed, "video")?.intensity).toBe(10);
    expect(lutRefOf(dimmed, "image")?.intensity).toBe(10);
  });

  it("clear a selection", () => {
    const graded = setClipLutMany(doc(), [...CLIPS], "a");
    const cleared = setClipLutMany(graded, [...CLIPS], null);
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(doc()));
  });
});

describe("what the renderer reads back", () => {
  it("sees exactly what the op stored", () => {
    const graded = setClipLut(doc(), "video", "a", 33);
    expect(lutOf(graded.elements.video)).toEqual({ presetId: "a", intensity: 33 });
  });

  it("survives a round trip through JSON, as a .ngt does", () => {
    const graded = setClipLut(doc(), "video", "a", 33);
    const reread = JSON.parse(JSON.stringify(graded)) as TimelineDocument;
    expect(lutOf(reread.elements.video)).toEqual({ presetId: "a", intensity: 33 });
  });

  it("survives normalizeDocument", () => {
    const graded = normalizeDocument(setClipLut(doc(), "video", "a", 33));
    expect(lutOf(graded.elements.video)).toEqual({ presetId: "a", intensity: 33 });
  });
});
