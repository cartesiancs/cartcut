import { describe, it, expect } from "vitest";
import {
  MAX_CORNER_RADIUS,
  ROUNDABLE_FILETYPES,
  coerceCornerRadius,
  cornerRadiusAt,
  cornerRadiusOf,
  isRoundable,
  setCornerRadius,
  setCornerRadiusMany,
} from "./cornerOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
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
    },
  });
}

/** A live radius track holding these baked `[clip ms, value]` samples. */
function track(ax: number[][], isActivate = true) {
  return { isActivate, x: [], ax };
}

describe("ROUNDABLE_FILETYPES", () => {
  it("is exactly image and video", () => {
    expect([...ROUNDABLE_FILETYPES].sort()).toEqual(["image", "video"]);
  });

  it("isRoundable agrees with the list", () => {
    for (const [id, element] of Object.entries(doc().elements)) {
      expect(isRoundable(element), id).toBe(
        (ROUNDABLE_FILETYPES as readonly string[]).includes(element.filetype),
      );
    }
  });
});

describe("cornerRadiusOf", () => {
  it("reads absent as square", () => {
    expect(cornerRadiusOf(imageElement())).toBe(0);
    expect(cornerRadiusOf(null)).toBe(0);
  });

  it("reads what is stored", () => {
    expect(cornerRadiusOf(imageElement({ cornerRadius: 24 }))).toBe(24);
    expect(cornerRadiusOf(videoElement({ cornerRadius: 12.5 }))).toBe(12.5);
  });

  it("floors a negative and reads junk as square, never throwing", () => {
    // A negative radius reaching `roundRect` is a RangeError in Chromium.
    expect(cornerRadiusOf(imageElement({ cornerRadius: -5 }))).toBe(0);
    expect(cornerRadiusOf(imageElement({ cornerRadius: Number.NaN }))).toBe(0);
    expect(cornerRadiusOf(imageElement({ cornerRadius: Infinity }))).toBe(0);
    expect(cornerRadiusOf(imageElement({ cornerRadius: "24" } as any))).toBe(0);
  });

  it("caps at the stored maximum", () => {
    expect(cornerRadiusOf(imageElement({ cornerRadius: 1e9 }))).toBe(
      MAX_CORNER_RADIUS,
    );
  });

  it("reads nothing off a type that cannot be rounded", () => {
    // A hand-edited project could put the key anywhere; only image and video
    // are drawn with it, so only they may report it.
    expect(cornerRadiusOf(shapeElement({ cornerRadius: 24 } as any))).toBe(0);
    expect(cornerRadiusOf(textElement({ cornerRadius: 24 } as any))).toBe(0);
  });
});

describe("coerceCornerRadius", () => {
  it("clamps a number into range", () => {
    expect(coerceCornerRadius(30)).toBe(30);
    expect(coerceCornerRadius(-1)).toBe(0);
    expect(coerceCornerRadius(MAX_CORNER_RADIUS + 1)).toBe(MAX_CORNER_RADIUS);
  });

  it("refuses what is not a number", () => {
    expect(coerceCornerRadius("30")).toBeNull();
    expect(coerceCornerRadius(Number.NaN)).toBeNull();
    expect(coerceCornerRadius(undefined)).toBeNull();
  });
});

describe("setCornerRadius", () => {
  it("rounds an image and a video", () => {
    let d = setCornerRadius(doc(), "image", 24);
    d = setCornerRadius(d, "video", 40);
    expect(d.elements.image).toMatchObject({ cornerRadius: 24 });
    expect(d.elements.video).toMatchObject({ cornerRadius: 40 });
  });

  it("clamps what it stores", () => {
    const d = setCornerRadius(doc(), "image", -10);
    // Clamped to 0, which on a clip with no radius is no change at all.
    expect(d.elements.image).not.toHaveProperty("cornerRadius");
    expect(setCornerRadius(doc(), "image", 1e9).elements.image).toMatchObject({
      cornerRadius: MAX_CORNER_RADIUS,
    });
  });

  it("deletes the key at 0, so the clip is byte-identical to one never rounded", () => {
    const original = doc();
    const cleared = setCornerRadius(
      setCornerRadius(original, "image", 24),
      "image",
      0,
    );
    expect(cleared.elements.image).not.toHaveProperty("cornerRadius");
    expect(JSON.stringify(cleared.elements.image)).toBe(
      JSON.stringify(original.elements.image),
    );
  });

  it("declines by identity for the radius a clip already has", () => {
    const rounded = setCornerRadius(doc(), "image", 24);
    expect(setCornerRadius(rounded, "image", 24)).toBe(rounded);
  });

  it("declines by identity when clearing a clip that was never rounded", () => {
    const d = doc();
    expect(setCornerRadius(d, "image", 0)).toBe(d);
  });

  it("declines by identity for a type that cannot be rounded", () => {
    const d = doc();
    for (const id of ["shape", "text", "gif", "sound", "group"]) {
      expect(setCornerRadius(d, id, 24), id).toBe(d);
    }
  });

  it("declines by identity for a missing id and a non-number", () => {
    const d = doc();
    expect(setCornerRadius(d, "nope", 24)).toBe(d);
    expect(setCornerRadius(d, "image", Number.NaN)).toBe(d);
  });

  it("clears a junk stored value when asked for 0", () => {
    const d = doc();
    const junk = {
      ...d,
      elements: {
        ...d.elements,
        image: { ...d.elements.image, cornerRadius: "x" } as any,
      },
    };
    expect(setCornerRadius(junk, "image", 0).elements.image).not.toHaveProperty(
      "cornerRadius",
    );
  });
});

describe("setCornerRadiusMany", () => {
  it("rounds what it can and skips the rest", () => {
    const d = setCornerRadiusMany(doc(), ["image", "video", "shape"], 16);
    expect(d.elements.image).toMatchObject({ cornerRadius: 16 });
    expect(d.elements.video).toMatchObject({ cornerRadius: 16 });
    expect(d.elements.shape).not.toHaveProperty("cornerRadius");
  });

  it("declines by identity when nothing in the selection changes", () => {
    const d = doc();
    expect(setCornerRadiusMany(d, ["shape", "text"], 16)).toBe(d);
  });
});

describe("cornerRadiusAt", () => {
  const animated = (over: Record<string, unknown> = {}) =>
    imageElement({
      startTime: 1000,
      cornerRadius: 10,
      animation: {
        ...imageElement().animation,
        // Baked lanes are dense samples, read by lookup rather than
        // interpolated, so the middle is a sample of its own.
        cornerRadius: track([
          [0, 0],
          [500, 25],
          [1000, 50],
        ]),
      },
      ...over,
    } as any);

  it("answers the static field with no track", () => {
    expect(cornerRadiusAt(imageElement({ cornerRadius: 24 }), 0)).toBe(24);
  });

  it("samples a live track, which replaces the field", () => {
    expect(cornerRadiusAt(animated(), 1000)).toBe(0);
    expect(cornerRadiusAt(animated(), 1500)).toBe(25);
    expect(cornerRadiusAt(animated(), 2000)).toBe(50);
  });

  it("answers the field before the clip starts", () => {
    expect(cornerRadiusAt(animated(), 500)).toBe(10);
  });

  it("ignores a track that is switched off", () => {
    const off = animated();
    (off as any).animation.cornerRadius.isActivate = false;
    expect(cornerRadiusAt(off, 2000)).toBe(10);
  });

  it("floors an overshooting curve at the read", () => {
    const under = animated();
    (under as any).animation.cornerRadius = track([
      [0, -30],
      [1000, -30],
    ]);
    expect(cornerRadiusAt(under, 1500)).toBe(0);
  });

  it("answers 0 for a type that cannot be rounded, track or not", () => {
    const shape = shapeElement({
      animation: {
        ...shapeElement().animation,
        cornerRadius: track([[0, 40]]),
      },
    } as any);
    expect(cornerRadiusAt(shape, 0)).toBe(0);
  });
});
