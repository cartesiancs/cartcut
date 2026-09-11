import { describe, expect, it } from "vitest";

import type { ColorAdjustments, TimelineElement } from "../../@types/timeline";
import { adjustOf } from "../renderer/adjust";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import {
  ADJUSTABLE_FILETYPES,
  adjustmentsOf,
  isAdjustable,
  resetClipAdjust,
  resetClipAdjustMany,
  setClipAdjust,
  setClipAdjustMany,
} from "./adjustOps";
import { pasteClips, splitClip } from "./clipOps";
import { GRADABLE_FILETYPES } from "./lutOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

/** One clip of every type, through `normalizeDocument` as the renderer sees them. */
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

const stored = (d: TimelineDocument, id: string) =>
  (d.elements[id] as TimelineElement & { adjust?: ColorAdjustments }).adjust;

describe("ADJUSTABLE_FILETYPES", () => {
  it("is exactly the types that paint themselves as a layer — the same five as a LUT", () => {
    expect([...ADJUSTABLE_FILETYPES].sort()).toEqual([...GRADABLE_FILETYPES].sort());
  });

  it("isAdjustable agrees with it and refuses the rest", () => {
    const d = doc();
    for (const id of CLIPS) expect(isAdjustable(d.elements[id])).toBe(true);
    expect(isAdjustable(d.elements.sound)).toBe(false);
    expect(isAdjustable(d.elements.group)).toBe(false);
    expect(isAdjustable(undefined)).toBe(false);
    expect(isAdjustable({ ...imageElement({}), filetype: "effect" } as unknown as TimelineElement)).toBe(false);
    expect(isAdjustable({ ...imageElement({}), filetype: "transition" } as unknown as TimelineElement)).toBe(false);
    expect(isAdjustable({ ...imageElement({}), filetype: "template" } as unknown as TimelineElement)).toBe(false);
  });
});

describe("setClipAdjust", () => {
  it("stores a slider on every adjustable type", () => {
    for (const id of CLIPS) {
      const after = setClipAdjust(doc(), id, { exposure: 20 });
      expect(stored(after, id)).toEqual({ exposure: 20 });
    }
  });

  it("merges: keys absent from the patch are left alone", () => {
    const one = setClipAdjust(doc(), "video", { exposure: 20, contrast: 10 });
    const two = setClipAdjust(one, "video", { saturation: -30 });
    expect(stored(two, "video")).toEqual({ saturation: -30, exposure: 20, contrast: 10 });
  });

  it("a zero removes that key rather than storing it", () => {
    const one = setClipAdjust(doc(), "video", { exposure: 20, contrast: 10 });
    const two = setClipAdjust(one, "video", { exposure: 0 });
    expect(stored(two, "video")).toEqual({ contrast: 10 });
    expect("exposure" in stored(two, "video")!).toBe(false);
  });

  it("removes the field outright when the last slider returns to zero", () => {
    const before = doc();
    const set = setClipAdjust(before, "image", { vignette: 40 });
    const back = setClipAdjust(set, "image", { vignette: 0 });
    expect("adjust" in back.elements.image).toBe(false);
    // The persistence promise, stated as bytes.
    expect(JSON.stringify(back.elements)).toBe(JSON.stringify(before.elements));
  });

  it("stores the canonical form: clamped, in key order, unknown keys dropped", () => {
    const after = setClipAdjust(doc(), "video", {
      vignette: 10,
      exposure: 500,
      sharpen: -10,
      glow: 3,
    } as ColorAdjustments);
    expect(stored(after, "video")).toEqual({ exposure: 100, vignette: 10 });
    expect(Object.keys(stored(after, "video")!)).toEqual(["exposure", "vignette"]);
  });

  it("touches nothing but the one clip and the one field", () => {
    const before = doc();
    const after = setClipAdjust(before, "video", { exposure: 20 });
    for (const id of Object.keys(before.elements)) {
      if (id === "video") continue;
      expect(after.elements[id]).toBe(before.elements[id]);
    }
    const { adjust: _adjust, ...rest } = after.elements.video as TimelineElement & {
      adjust?: ColorAdjustments;
    };
    expect(rest).toEqual(before.elements.video);
    expect(after.tracks).toBe(before.tracks);
  });

  it("leaves the clip's LUT and blend exactly as they were", () => {
    const before = doc();
    const graded = {
      ...before,
      elements: {
        ...before.elements,
        video: {
          ...before.elements.video,
          lut: { presetId: "x", intensity: 40 },
          blend: "screen",
        } as TimelineElement,
      },
    };
    const after = setClipAdjust(graded, "video", { tint: 5 });
    expect((after.elements.video as any).lut).toEqual({ presetId: "x", intensity: 40 });
    expect((after.elements.video as any).blend).toBe("screen");
  });
});

describe("declining — returns the document by identity", () => {
  it("for a missing id", () => {
    const d = doc();
    expect(setClipAdjust(d, "nope", { exposure: 10 })).toBe(d);
    expect(resetClipAdjust(d, "nope")).toBe(d);
  });

  it("for audio and for a group", () => {
    const d = doc();
    expect(setClipAdjust(d, "sound", { exposure: 10 })).toBe(d);
    expect(setClipAdjust(d, "group", { exposure: 10 })).toBe(d);
    expect(resetClipAdjust(d, "group")).toBe(d);
  });

  it("for an effect element — an adjustment layer is not a clip", () => {
    const d = doc();
    const withEffect = {
      ...d,
      elements: {
        ...d.elements,
        fx: { ...imageElement({ trackId: "v0" }), filetype: "effect" } as unknown as TimelineElement,
      },
    };
    expect(setClipAdjust(withEffect, "fx", { exposure: 10 })).toBe(withEffect);
  });

  it("for the value the clip already has", () => {
    const d = setClipAdjust(doc(), "video", { exposure: 10 });
    expect(setClipAdjust(d, "video", { exposure: 10 })).toBe(d);
    // Clamped to what is already stored is the same value too.
    const full = setClipAdjust(doc(), "video", { exposure: 100 });
    expect(setClipAdjust(full, "video", { exposure: 300 })).toBe(full);
  });

  it("for an empty patch, and for zeros on a clip that has nothing", () => {
    const d = doc();
    expect(setClipAdjust(d, "video", {})).toBe(d);
    expect(setClipAdjust(d, "video", { exposure: 0, fade: 0 })).toBe(d);
  });

  it("for a reset with nothing to reset", () => {
    const d = doc();
    expect(resetClipAdjust(d, "video")).toBe(d);
    expect(resetClipAdjust(d, "video", "effects")).toBe(d);
    const colourOnly = setClipAdjust(d, "video", { temperature: 20 });
    expect(resetClipAdjust(colourOnly, "video", "lightness")).toBe(colourOnly);
  });
});

describe("resetClipAdjust", () => {
  const everything: ColorAdjustments = {
    temperature: 10,
    tint: -10,
    exposure: 20,
    shadows: 30,
    sharpen: 40,
    vignette: -20,
  };

  it("with no group clears the field entirely", () => {
    const d = setClipAdjust(doc(), "video", everything);
    const after = resetClipAdjust(d, "video");
    expect("adjust" in after.elements.video).toBe(false);
  });

  it("clears one group and leaves the others", () => {
    const d = setClipAdjust(doc(), "video", everything);
    expect(stored(resetClipAdjust(d, "video", "color"), "video")).toEqual({
      exposure: 20,
      shadows: 30,
      sharpen: 40,
      vignette: -20,
    });
    expect(stored(resetClipAdjust(d, "video", "lightness"), "video")).toEqual({
      temperature: 10,
      tint: -10,
      sharpen: 40,
      vignette: -20,
    });
    expect(stored(resetClipAdjust(d, "video", "effects"), "video")).toEqual({
      temperature: 10,
      tint: -10,
      exposure: 20,
      shadows: 30,
    });
  });

  it("removes the field when the reset group was the only one set", () => {
    const d = setClipAdjust(doc(), "video", { sharpen: 30 });
    expect("adjust" in resetClipAdjust(d, "video", "effects").elements.video).toBe(false);
  });
});

describe("many clips at once", () => {
  it("sets every adjustable clip and skips the rest", () => {
    const after = setClipAdjustMany(doc(), [...CLIPS, "sound", "group"], { fade: 25 });
    for (const id of CLIPS) expect(stored(after, id)).toEqual({ fade: 25 });
    expect(stored(after, "sound")).toBeUndefined();
    expect(stored(after, "group")).toBeUndefined();
  });

  it("returns its input when nothing it names can change", () => {
    const d = doc();
    expect(setClipAdjustMany(d, ["sound", "group", "nope"], { fade: 25 })).toBe(d);
    expect(setClipAdjustMany(d, [], { fade: 25 })).toBe(d);
    expect(resetClipAdjustMany(d, [...CLIPS])).toBe(d);
  });

  it("resets many as one document", () => {
    const set = setClipAdjustMany(doc(), [...CLIPS], { exposure: 10, sharpen: 10 });
    const after = resetClipAdjustMany(set, [...CLIPS], "effects");
    for (const id of CLIPS) expect(stored(after, id)).toEqual({ exposure: 10 });
  });
});

describe("the read model", () => {
  it("adjustmentsOf is {} for a clip with none and the canonical form otherwise", () => {
    const d = doc();
    expect(adjustmentsOf(d, "video")).toEqual({});
    expect(adjustmentsOf(d, "nope")).toEqual({});
    const after = setClipAdjust(d, "video", { tint: 3 });
    expect(adjustmentsOf(after, "video")).toEqual({ tint: 3 });
  });
});

describe("carried by the document", () => {
  it("survives a JSON round trip and normalizeDocument", () => {
    const set = setClipAdjust(doc(), "video", { exposure: 15, vignette: 30 });
    const reloaded = normalizeDocument(JSON.parse(JSON.stringify(set)));
    expect(adjustOf(reloaded.elements.video)).toEqual({ exposure: 15, vignette: 30 });
  });

  it("travels to both halves of a split", () => {
    const set = setClipAdjust(doc(), "video", { clarity: 40 });
    const split = splitClip(set, "video", 2000, "right");
    expect(split).not.toBe(set);
    expect(adjustOf(split.elements.video)).toEqual({ clarity: 40 });
    expect(adjustOf(split.elements.right)).toEqual({ clarity: 40 });
  });

  it("travels with a pasted copy", () => {
    const set = setClipAdjust(doc(), "image", { saturation: -50 });
    let n = 0;
    const pasted = pasteClips(
      set,
      { image: structuredClone(set.elements.image) },
      20_000,
      () => `copy-${n++}`,
    );
    expect(adjustOf(pasted.elements["copy-0"])).toEqual({ saturation: -50 });
  });
});
