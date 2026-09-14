import { describe, it, expect } from "vitest";
import {
  SCALABLE_FILETYPES,
  SCALE_NEUTRAL_TENTHS,
  clampScaleTenths,
  coerceScaleTenths,
  isScalable,
  scaleTenthsOf,
  setClipScale,
} from "./scaleOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  effectElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  transitionElement,
  videoElement,
} from "../renderer/testing";

/** One clip of every type, built through `normalizeDocument` like the app. */
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
      fx: effectElement({ trackId: "g0", startTime: 0, duration: 1000 }),
      wipe: transitionElement({ trackId: "v0", startTime: 3800 }),
    },
  });
}

describe("SCALABLE_FILETYPES", () => {
  it("is exactly the seven Visual types", () => {
    expect([...SCALABLE_FILETYPES].sort()).toEqual([
      "gif",
      "group",
      "image",
      "shape",
      "template",
      "text",
      "video",
    ]);
  });

  it("isScalable agrees with the list", () => {
    const d = doc();
    for (const [id, element] of Object.entries(d.elements)) {
      expect(isScalable(element), id).toBe(
        (SCALABLE_FILETYPES as readonly string[]).includes(element.filetype),
      );
    }
  });
});

describe("scaleTenthsOf", () => {
  it("answers neutral for an absent field", () => {
    expect(scaleTenthsOf(imageElement({}))).toBe(SCALE_NEUTRAL_TENTHS);
  });

  it("answers neutral for null and undefined", () => {
    expect(scaleTenthsOf(null)).toBe(SCALE_NEUTRAL_TENTHS);
    expect(scaleTenthsOf(undefined)).toBe(SCALE_NEUTRAL_TENTHS);
  });

  it("reads the field when it is there", () => {
    expect(scaleTenthsOf(imageElement({ scale: 15 } as any))).toBe(15);
  });

  // A read guard on the paint loop. Every one of these reaches it from a
  // hand-edited project, and every one of them has to produce a number the
  // matrix can be built from rather than a frame that does not draw.
  it.each([
    ["a string", "12"],
    ["a boolean", true],
    ["null", null],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("answers neutral for %s", (_label, value) => {
    expect(scaleTenthsOf(imageElement({ scale: value } as any))).toBe(
      SCALE_NEUTRAL_TENTHS,
    );
  });

  it("floors a negative at zero rather than mirroring", () => {
    expect(scaleTenthsOf(imageElement({ scale: -12 } as any))).toBe(0);
  });
});

describe("clampScaleTenths", () => {
  it("has no ceiling", () => {
    expect(clampScaleTenths(10_000)).toBe(10_000);
  });

  it("floors at zero", () => {
    expect(clampScaleTenths(-1)).toBe(0);
    expect(clampScaleTenths(0)).toBe(0);
  });
});

describe("coerceScaleTenths", () => {
  it("takes a number and a numeric string", () => {
    expect(coerceScaleTenths(12)).toBe(12);
    expect(coerceScaleTenths("12.5")).toBe(12.5);
  });

  it("clamps rather than refusing an out-of-range number", () => {
    expect(coerceScaleTenths(-4)).toBe(0);
  });

  // `Number(true)` is 1, which would silently shrink a clip to a tenth.
  it.each([
    ["a boolean", true],
    ["an object", {}],
    ["undefined", undefined],
    ["a non-numeric string", "big"],
  ])("refuses %s", (_label, value) => {
    expect(coerceScaleTenths(value)).toBeNull();
  });
});

describe("setClipScale", () => {
  it("writes the field", () => {
    const after = setClipScale(doc(), "image", 12);
    expect((after.elements.image as any).scale).toBe(12);
  });

  it("clamps a negative to zero instead of mirroring", () => {
    const after = setClipScale(doc(), "image", -12);
    expect((after.elements.image as any).scale).toBe(0);
  });

  it("leaves every other clip and the tracks alone", () => {
    const before = doc();
    const after = setClipScale(before, "image", 12);
    expect(after.elements.video).toBe(before.elements.video);
    expect(after.tracks).toBe(before.tracks);
  });

  it("never touches the animation block", () => {
    const before = doc();
    const after = setClipScale(before, "image", 12);
    expect((after.elements.image as any).animation).toBe(
      (before.elements.image as any).animation,
    );
  });

  // The byte-identity claim `Visual.scale` makes: a clip returned to unscaled
  // has to be the same element a clip that was never scaled is, key and all.
  it("deletes the key at neutral rather than storing 10", () => {
    const before = doc();
    const scaled = setClipScale(before, "image", 12);
    const back = setClipScale(scaled, "image", SCALE_NEUTRAL_TENTHS);

    expect("scale" in (back.elements.image as any)).toBe(false);
    expect(JSON.stringify(back.elements.image)).toBe(
      JSON.stringify(before.elements.image),
    );
  });

  describe("declines by identity", () => {
    it("for the scale the clip already has", () => {
      const d = doc();
      expect(setClipScale(d, "image", SCALE_NEUTRAL_TENTHS)).toBe(d);
      const scaled = setClipScale(d, "image", 12);
      expect(setClipScale(scaled, "image", 12)).toBe(scaled);
    });

    it("for a missing id", () => {
      const d = doc();
      expect(setClipScale(d, "nope", 12)).toBe(d);
    });

    it.each(["NaN", "Infinity"])("for %s", (kind) => {
      const d = doc();
      expect(setClipScale(d, "image", kind === "NaN" ? NaN : Infinity)).toBe(d);
    });

    it.each(["sound", "fx", "wipe"])("for a %s clip", (id) => {
      const d = doc();
      expect(setClipScale(d, id, 12)).toBe(d);
    });
  });
});
