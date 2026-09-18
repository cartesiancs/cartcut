import { describe, it, expect } from "vitest";
import {
  coerceCrop,
  cropOf,
  CROPPABLE_FILETYPES,
  frameBoxOf,
  FULL_CROP,
  isCropped,
  isCroppable,
  MIN_CROP,
  recroppedBox,
  resetClipCrop,
  sameCrop,
  setClipCrop,
} from "./cropOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { worldCornersOf, applyPoint, worldMatrixOf } from "./transform";
import type { CropRect } from "../../@types/timeline";
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

/** A document holding one image, with whatever overrides a case needs. */
function one(over: Record<string, unknown> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      el: imageElement({
        trackId: "v0",
        startTime: 0,
        duration: 4000,
        width: 200,
        height: 100,
        location: { x: 40, y: 20 },
        ...(over as any),
      }),
    },
  });
}

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

// -------------------------------------------------------------- the type gate

describe("CROPPABLE_FILETYPES", () => {
  it("is exactly video and image", () => {
    expect([...CROPPABLE_FILETYPES].sort()).toEqual(["image", "video"]);
  });

  it("isCroppable agrees with the list, for one clip of every type", () => {
    const d = doc();
    for (const [id, element] of Object.entries(d.elements)) {
      expect(isCroppable(element), id).toBe(
        (CROPPABLE_FILETYPES as readonly string[]).includes(element.filetype),
      );
    }
  });

  it("answers false for null and undefined rather than throwing", () => {
    expect(isCroppable(null)).toBe(false);
    expect(isCroppable(undefined)).toBe(false);
  });
});

// ------------------------------------------------------------- the read guard

describe("cropOf", () => {
  it("reads an absent crop as the whole frame", () => {
    expect(cropOf(imageElement())).toEqual(FULL_CROP);
  });

  it("never throws, whatever is in the field", () => {
    const junk: unknown[] = [
      null,
      undefined,
      "0.5",
      42,
      [],
      [0, 0, 1, 1],
      {},
      { x: "a", y: {}, width: null, height: [] },
      { x: NaN, y: Infinity, width: -Infinity, height: NaN },
      true,
    ];
    for (const crop of junk) {
      const element = imageElement({ crop } as any);
      expect(() => cropOf(element), JSON.stringify(crop)).not.toThrow();
      const read = cropOf(element);
      expect(Number.isFinite(read.x), JSON.stringify(crop)).toBe(true);
      expect(Number.isFinite(read.y)).toBe(true);
      expect(read.width).toBeGreaterThanOrEqual(MIN_CROP);
      expect(read.height).toBeGreaterThanOrEqual(MIN_CROP);
    }
  });

  it("clamps a size out of range into [MIN_CROP, 1]", () => {
    expect(cropOf(imageElement({ crop: rect(0, 0, 0, 0) } as any))).toEqual(
      rect(0, 0, MIN_CROP, MIN_CROP),
    );
    expect(cropOf(imageElement({ crop: rect(0, 0, 9, 9) } as any))).toEqual(
      FULL_CROP,
    );
    expect(cropOf(imageElement({ crop: rect(0, 0, -1, -1) } as any))).toEqual(
      rect(0, 0, MIN_CROP, MIN_CROP),
    );
  });

  it("clamps an origin so the rect stays inside the frame", () => {
    expect(cropOf(imageElement({ crop: rect(0.8, 0.9, 0.5, 0.5) } as any))).toEqual(
      rect(0.5, 0.5, 0.5, 0.5),
    );
    expect(cropOf(imageElement({ crop: rect(-1, -1, 0.5, 0.5) } as any))).toEqual(
      rect(0, 0, 0.5, 0.5),
    );
  });

  it("returns a usable rect unchanged", () => {
    const crop = rect(0.25, 0.1, 0.5, 0.4);
    expect(cropOf(imageElement({ crop } as any))).toEqual(crop);
  });
});

describe("isCropped", () => {
  it("is false for the whole frame", () => {
    expect(isCropped(FULL_CROP)).toBe(false);
  });

  it("is true when any one edge has moved", () => {
    expect(isCropped(rect(0.1, 0, 0.9, 1))).toBe(true);
    expect(isCropped(rect(0, 0.1, 1, 0.9))).toBe(true);
    expect(isCropped(rect(0, 0, 0.5, 1))).toBe(true);
    expect(isCropped(rect(0, 0, 1, 0.5))).toBe(true);
  });

  it("treats a rect a hair off the frame as uncropped", () => {
    expect(isCropped(rect(1e-9, 1e-9, 1 - 1e-9, 1 - 1e-9))).toBe(false);
  });
});

describe("coerceCrop", () => {
  it("rejects anything that is not a rect", () => {
    for (const bad of [null, undefined, "x", 1, [], [0, 0, 1, 1], {}, true]) {
      expect(coerceCrop(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a non-finite or non-numeric field", () => {
    expect(coerceCrop({ x: NaN, y: 0, width: 1, height: 1 })).toBeNull();
    expect(coerceCrop({ x: 0, y: Infinity, width: 1, height: 1 })).toBeNull();
    expect(coerceCrop({ x: 0, y: 0, width: "1", height: 1 })).toBeNull();
  });

  it("rejects a rect with no extent", () => {
    expect(coerceCrop(rect(0, 0, 0, 0.5))).toBeNull();
    expect(coerceCrop(rect(0, 0, 0.5, -0.2))).toBeNull();
  });

  it("accepts and clamps one that is merely out of range", () => {
    expect(coerceCrop(rect(0.9, 0, 0.5, 2))).toEqual(rect(0.5, 0, 0.5, 1));
  });
});

describe("sameCrop", () => {
  it("compares with the same epsilon isCropped uses", () => {
    expect(sameCrop(FULL_CROP, FULL_CROP)).toBe(true);
    expect(sameCrop(FULL_CROP, rect(0, 0, 1 - 1e-9, 1))).toBe(true);
    expect(sameCrop(FULL_CROP, rect(0, 0, 0.9, 1))).toBe(false);
  });
});

describe("frameBoxOf", () => {
  it("inverts the crop, so a half-width crop implies a double-width frame", () => {
    expect(frameBoxOf({ width: 100, height: 50 }, rect(0, 0, 0.5, 0.25))).toEqual({
      width: 200,
      height: 200,
    });
  });

  it("is the identity for an uncropped clip", () => {
    expect(frameBoxOf({ width: 200, height: 100 }, FULL_CROP)).toEqual({
      width: 200,
      height: 100,
    });
  });
});

// ------------------------------------------------------------ decline by identity

describe("setClipCrop declines", () => {
  it("for an id that is not in the document", () => {
    const d = doc();
    expect(setClipCrop(d, "nope", rect(0, 0, 0.5, 0.5), 0)).toBe(d);
  });

  it.each(["gif", "shape", "text", "sound", "group"])(
    "for a %s, which cannot be cropped",
    (id) => {
      const d = doc();
      expect(setClipCrop(d, id, rect(0, 0, 0.5, 0.5), 0)).toBe(d);
    },
  );

  it("for the framing the clip already has", () => {
    const d = one({ crop: rect(0.1, 0.1, 0.5, 0.5) });
    expect(setClipCrop(d, "el", rect(0.1, 0.1, 0.5, 0.5), 0)).toBe(d);
  });

  it("for an uncropped clip asked for the whole frame", () => {
    const d = one();
    expect(setClipCrop(d, "el", FULL_CROP, 0)).toBe(d);
    expect(resetClipCrop(d, "el", 0)).toBe(d);
  });

  it("for a rect that is not a rect at all", () => {
    const d = one();
    expect(setClipCrop(d, "el", null as any, 0)).toBe(d);
    expect(setClipCrop(d, "el", { x: 0, y: 0 } as any, 0)).toBe(d);
  });

  it("for a clip with no extent, rather than dividing by its box", () => {
    const d = one({ width: 0, height: 0 });
    expect(setClipCrop(d, "el", rect(0, 0, 0.5, 0.5), 0)).toBe(d);
  });
});

// ---------------------------------------------------------------- the write

describe("setClipCrop", () => {
  it("writes the rect and shrinks the box to it", () => {
    const next = setClipCrop(one(), "el", rect(0.25, 0, 0.5, 1), 0);
    const el: any = next.elements.el;
    expect(el.crop).toEqual(rect(0.25, 0, 0.5, 1));
    expect(el.width).toBeCloseTo(100, 9);
    expect(el.height).toBeCloseTo(100, 9);
  });

  it("moves the corner so the kept picture stays where it was", () => {
    // The box was 200 wide at x = 40. Keeping the middle half means the kept
    // picture ran from 90 to 190, so the new corner is at 90.
    const el: any = setClipCrop(one(), "el", rect(0.25, 0, 0.5, 1), 0).elements.el;
    expect(el.location.x).toBeCloseTo(90, 9);
    expect(el.location.y).toBeCloseTo(20, 9);
  });

  it("deletes the key on a reset, surviving a JSON round trip", () => {
    const cropped = setClipCrop(one(), "el", rect(0.25, 0.25, 0.5, 0.5), 0);
    expect("crop" in (cropped.elements.el as any)).toBe(true);

    const back = resetClipCrop(cropped, "el", 0);
    const el: any = back.elements.el;
    expect("crop" in el).toBe(false);

    const saved = JSON.parse(JSON.stringify(el));
    expect(saved).toEqual(JSON.parse(JSON.stringify(one().elements.el)));
  });

  it("restores the box and the corner exactly on a reset", () => {
    const before: any = one().elements.el;
    const back: any = resetClipCrop(
      setClipCrop(one(), "el", rect(0.3, 0.1, 0.4, 0.6), 0),
      "el",
      0,
    ).elements.el;
    expect(back.width).toBeCloseTo(before.width, 9);
    expect(back.height).toBeCloseTo(before.height, 9);
    expect(back.location.x).toBeCloseTo(before.location.x, 9);
    expect(back.location.y).toBeCloseTo(before.location.y, 9);
  });

  it("clamps a rect below the floor rather than storing it", () => {
    const el: any = setClipCrop(one(), "el", rect(0, 0, 1e-9, 1e-9), 0).elements.el;
    expect(el.crop.width).toBe(MIN_CROP);
    expect(el.crop.height).toBe(MIN_CROP);
  });

  it("composes: two crops against the frame equal the second one alone", () => {
    const a = setClipCrop(one(), "el", rect(0.2, 0.2, 0.6, 0.6), 0);
    const ab: any = setClipCrop(a, "el", rect(0.3, 0.1, 0.4, 0.5), 0).elements.el;
    const b: any = setClipCrop(one(), "el", rect(0.3, 0.1, 0.4, 0.5), 0).elements.el;

    expect(ab.crop).toEqual(b.crop);
    expect(ab.width).toBeCloseTo(b.width, 9);
    expect(ab.height).toBeCloseTo(b.height, 9);
    expect(ab.location.x).toBeCloseTo(b.location.x, 9);
    expect(ab.location.y).toBeCloseTo(b.location.y, 9);
  });

  it("never leaves the unit square, however many crops are applied", () => {
    let d = one();
    for (const r of [
      rect(0.1, 0.1, 0.8, 0.8),
      rect(0.9, 0.9, 0.3, 0.3),
      rect(0, 0, 1, 1),
      rect(0.5, 0.5, 0.6, 0.6),
    ]) {
      d = setClipCrop(d, "el", r, 0);
      const crop = cropOf(d.elements.el);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-12);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

// ------------------------------- the property that actually proves the feature

/**
 * Where the crop rect's four corners are on the canvas, before the crop.
 *
 * Expressed in the clip's own local box and pushed through the very matrix the
 * renderer draws with, so this is the picture the user can see rather than a
 * second opinion about it.
 */
function keptCornersBefore(
  d: TimelineDocument,
  elementId: string,
  to: CropRect,
  cursor: number,
) {
  const element: any = d.elements[elementId];
  const from = cropOf(element);
  const box = { width: element.width, height: element.height };
  const frame = frameBoxOf(box, from);
  const m = worldMatrixOf(d.elements as any, elementId, cursor);
  // The kept region in box coordinates. On a flipped axis the picture is drawn
  // back to front inside the box, so the region the user is keeping is measured
  // from the far edge, the same fact `cropOps.ts#originShift` exists for, and
  // it has to be restated here rather than imported, or this helper would agree
  // with the op by construction and confirm whatever it did.
  const flipH = (element as any).flipH === true;
  const flipV = (element as any).flipV === true;
  const w = to.width * frame.width;
  const h = to.height * frame.height;
  const x0 = flipH
    ? (from.x + from.width - (to.x + to.width)) * frame.width
    : (to.x - from.x) * frame.width;
  const y0 = flipV
    ? (from.y + from.height - (to.y + to.height)) * frame.height
    : (to.y - from.y) * frame.height;
  return [
    applyPoint(m, { x: x0, y: y0 }),
    applyPoint(m, { x: x0 + w, y: y0 }),
    applyPoint(m, { x: x0 + w, y: y0 + h }),
    applyPoint(m, { x: x0, y: y0 + h }),
  ];
}

describe("the kept picture does not move", () => {
  const rotations = [0, 17, 90, 180, -45];
  const scales = [undefined, 5, 10, 23];
  const crops = [
    rect(0.25, 0, 0.5, 1),
    rect(0, 0.25, 1, 0.5),
    rect(0.1, 0.2, 0.3, 0.4),
    rect(0.6, 0.55, 0.4, 0.45),
    rect(0, 0, 0.99, 0.99),
  ];

  for (const rotation of rotations) {
    for (const scale of scales) {
      for (const to of crops) {
        it(`holds at rotation ${rotation}, scale ${scale ?? "none"}, ${JSON.stringify(to)}`, () => {
          const before = one({ rotation, ...(scale == null ? {} : { scale }) });
          const want = keptCornersBefore(before, "el", to, 0);

          const after = setClipCrop(before, "el", to, 0);
          const got = worldCornersOf(after.elements as any, "el", 0);

          for (let i = 0; i < 4; i++) {
            expect(got[i].x, `corner ${i} x`).toBeCloseTo(want[i].x, 6);
            expect(got[i].y, `corner ${i} y`).toBeCloseTo(want[i].y, 6);
          }
        });
      }
    }
  }

  it.each([
    ["flipH", { flipH: true }],
    ["flipV", { flipV: true }],
    ["both", { flipH: true, flipV: true }],
  ])("holds for a mirrored clip (%s)", (_name, flip) => {
    // The case the axis-aligned renderer suite cannot see and the app-level
    // check found: the mirror is applied *inside* the box, about a centre that
    // moves when the box shrinks, so a flipped axis anchors on the far edge.
    // Offsetting the near way slid the picture by twice the crop's inset.
    for (const rotation of [0, 37]) {
      for (const to of [
        rect(0.25, 0, 0.5, 1),
        rect(0.1, 0.2, 0.3, 0.4),
        rect(0.55, 0.6, 0.45, 0.4),
      ]) {
        const before = one({ rotation, ...flip });
        const want = keptCornersBefore(before, "el", to, 0);
        const got = worldCornersOf(
          setClipCrop(before, "el", to, 0).elements as any,
          "el",
          0,
        );
        for (let i = 0; i < 4; i++) {
          const where = `${_name} r${rotation} ${JSON.stringify(to)} corner ${i}`;
          expect(got[i].x, `${where} x`).toBeCloseTo(want[i].x, 6);
          expect(got[i].y, `${where} y`).toBeCloseTo(want[i].y, 6);
        }
      }
    }
  });

  it("moves a mirrored clip the opposite way from an unmirrored one", () => {
    // Stated as a difference rather than only as a corner match, so the test
    // fails loudly if `originShift` is ever reduced back to one branch.
    const plain: any = setClipCrop(one(), "el", rect(0.25, 0, 0.5, 1), 0)
      .elements.el;
    const flipped: any = setClipCrop(
      one({ flipH: true }),
      "el",
      rect(0.25, 0, 0.5, 1),
      0,
    ).elements.el;
    // A centred crop is symmetric, so those two agree; an off-centre one must
    // not.
    expect(flipped.location.x).toBeCloseTo(plain.location.x, 9);

    const plainLeft: any = setClipCrop(one(), "el", rect(0, 0, 0.5, 1), 0)
      .elements.el;
    const flippedLeft: any = setClipCrop(
      one({ flipH: true }),
      "el",
      rect(0, 0, 0.5, 1),
      0,
    ).elements.el;
    // Keeping the left half of the source: unmirrored it stays at the box's
    // left edge, mirrored it is drawn at the right and so the box moves there.
    expect(plainLeft.location.x).toBeCloseTo(40, 9);
    expect(flippedLeft.location.x).toBeCloseTo(140, 9);
  });

  it("holds for a clip that is already cropped", () => {
    const before = one({ rotation: 33, scale: 14, crop: rect(0.2, 0.1, 0.5, 0.7) });
    const to = rect(0.3, 0.3, 0.2, 0.2);
    const want = keptCornersBefore(before, "el", to, 0);
    const got = worldCornersOf(setClipCrop(before, "el", to, 0).elements as any, "el", 0);
    for (let i = 0; i < 4; i++) {
      expect(got[i].x).toBeCloseTo(want[i].x, 6);
      expect(got[i].y).toBeCloseTo(want[i].y, 6);
    }
  });

  it("holds for a clip inside a rotated and scaled group", () => {
    const d = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0), createTrack("g0", "video", 1)],
      elements: {
        parent: groupElement({
          key: "parent",
          trackId: "g0",
          startTime: 0,
          duration: 4000,
          width: 300,
          height: 300,
          rotation: 25,
          scale: 16,
        } as any),
        el: imageElement({
          key: "el",
          trackId: "v0",
          startTime: 0,
          duration: 4000,
          width: 200,
          height: 100,
          location: { x: 40, y: 20 },
          rotation: 11,
          parentId: "parent",
        } as any),
      },
    });

    const to = rect(0.15, 0.35, 0.5, 0.45);
    const want = keptCornersBefore(d, "el", to, 0);
    const got = worldCornersOf(setClipCrop(d, "el", to, 0).elements as any, "el", 0);
    for (let i = 0; i < 4; i++) {
      expect(got[i].x, `corner ${i} x`).toBeCloseTo(want[i].x, 6);
      expect(got[i].y, `corner ${i} y`).toBeCloseTo(want[i].y, 6);
    }
  });
});

describe("recroppedBox", () => {
  it("collapses to a plain offset for an upright, unscaled clip", () => {
    const out = recroppedBox({
      box: { width: 200, height: 100 },
      drawnAt: { x: 40, y: 20 },
      from: FULL_CROP,
      to: rect(0.25, 0.5, 0.5, 0.5),
      linear: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    });
    expect(out.width).toBeCloseTo(100, 9);
    expect(out.height).toBeCloseTo(50, 9);
    expect(out.location.x).toBeCloseTo(40 + 50, 9);
    expect(out.location.y).toBeCloseTo(20 + 50, 9);
  });

  it("is the identity when the crop does not change", () => {
    const out = recroppedBox({
      box: { width: 200, height: 100 },
      drawnAt: { x: 40, y: 20 },
      from: rect(0.2, 0.2, 0.5, 0.5),
      to: rect(0.2, 0.2, 0.5, 0.5),
      linear: { a: 0.7, b: 0.7, c: -0.7, d: 0.7, e: 0, f: 0 },
    });
    expect(out.width).toBeCloseTo(200, 9);
    expect(out.height).toBeCloseTo(100, 9);
    expect(out.location.x).toBeCloseTo(40, 9);
    expect(out.location.y).toBeCloseTo(20, 9);
  });
});

// --------------------------------------------------------------- keyframes

describe("keyframes", () => {
  function animated(tracks: Record<string, boolean>) {
    const base = imageElement({
      trackId: "v0",
      startTime: 1000,
      duration: 4000,
      width: 200,
      height: 100,
      location: { x: 40, y: 20 },
    });
    const animation: any = { ...(base as any).animation };
    for (const [property, on] of Object.entries(tracks)) {
      animation[property] = { ...animation[property], isActivate: on };
    }
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: { el: { ...(base as any), animation } },
    });
  }

  it("writes no keyframe where no track is armed", () => {
    const before = animated({});
    const after: any = setClipCrop(before, "el", rect(0, 0, 0.5, 0.5), 1500).elements.el;
    expect(after.animation.size.x).toHaveLength(0);
    expect(after.animation.position.x).toHaveLength(0);
  });

  it("writes a size keyframe at the clip's own time where size is armed", () => {
    const after: any = setClipCrop(
      animated({ size: true }),
      "el",
      rect(0, 0, 0.5, 0.5),
      1500,
    ).elements.el;
    expect(after.animation.size.x).toHaveLength(1);
    expect(after.animation.size.x[0].p[0]).toBe(500);
    expect(after.animation.size.x[0].p[1]).toBeCloseTo(100, 9);
    expect(after.animation.size.y[0].p[1]).toBeCloseTo(50, 9);
    expect(after.animation.position.x).toHaveLength(0);
  });

  it("writes a position keyframe where position is armed", () => {
    const after: any = setClipCrop(
      animated({ position: true }),
      "el",
      rect(0.5, 0, 0.5, 1),
      1500,
    ).elements.el;
    expect(after.animation.position.x).toHaveLength(1);
    expect(after.animation.position.x[0].p[0]).toBe(500);
    expect(after.animation.position.x[0].p[1]).toBeCloseTo(140, 9);
    expect(after.animation.size.x).toHaveLength(0);
  });
});

// -------------------------------------------------------------------- the mask

describe("a mask", () => {
  const maskAt = (over: Record<string, unknown> = {}) => ({
    shape: "rectangle" as const,
    location: { x: 50, y: 50 },
    size: { width: 50, height: 50 },
    rotation: 0,
    feather: 8,
    roundness: 0,
    ...over,
  });

  it("keeps the same picture pixels when the box shrinks", () => {
    // Box 200x100, mask centred and half the box: it covers local x 50..150.
    // Crop to the middle half: the box becomes 100 wide at local x 50..150, so
    // the mask now has to be the whole width, centred.
    const d = one({ mask: maskAt() });
    const after: any = setClipCrop(d, "el", rect(0.25, 0, 0.5, 1), 0).elements.el;
    expect(after.mask.location.x).toBeCloseTo(50, 9);
    expect(after.mask.size.width).toBeCloseTo(100, 9);
    expect(after.mask.location.y).toBeCloseTo(50, 9);
    expect(after.mask.size.height).toBeCloseTo(50, 9);
  });

  it("follows an off-centre crop", () => {
    // Keep the left half: the mask's centre was at local 100, which is now 100
    // in a 100-wide box, so the mask leaves the frame on the right.
    const d = one({ mask: maskAt() });
    const after: any = setClipCrop(d, "el", rect(0, 0, 0.5, 1), 0).elements.el;
    expect(after.mask.location.x).toBeCloseTo(100, 9);
    expect(after.mask.size.width).toBeCloseTo(100, 9);
  });

  it("leaves feather alone, because a crop does not change pixel scale", () => {
    const d = one({ mask: maskAt({ feather: 8 }) });
    const after: any = setClipCrop(d, "el", rect(0.25, 0, 0.5, 1), 0).elements.el;
    expect(after.mask.feather).toBe(8);
    expect(after.mask.roundness).toBe(0);
    expect(after.mask.shape).toBe("rectangle");
  });

  it("is left entirely alone when one of its tracks is armed", () => {
    const base: any = one({ mask: maskAt() }).elements.el;
    const d = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        el: {
          ...base,
          animation: {
            ...base.animation,
            maskPosition: { isActivate: true, x: [], y: [], ax: [], ay: [] },
          },
        },
      },
    });
    const after: any = setClipCrop(d, "el", rect(0.25, 0, 0.5, 1), 0).elements.el;
    expect(after.mask.location).toEqual({ x: 50, y: 50 });
    expect(after.mask.size).toEqual({ width: 50, height: 50 });
  });

  it("is not invented on a clip that has none", () => {
    const after: any = setClipCrop(one(), "el", rect(0, 0, 0.5, 0.5), 0).elements.el;
    expect("mask" in after).toBe(false);
  });
});
