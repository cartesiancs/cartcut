import { describe, it, expect } from "vitest";

import {
  audioElement,
  imageElement,
  shapeElement,
  textElement,
} from "../renderer/testing";
import { normalizeShapeGeometry, shapeGeometryOf } from "../shape/shapeGeometry";
import { flattenOutline } from "../shape/shapeOutline";
import {
  chooseClipBackdrop,
  clearClipShapeGeometry,
  isShapeElement,
  mirrorFor,
  patchClipBackdropFx,
  setClipBackdropFx,
  setClipBackdropFxMany,
  setClipFillColor,
  setClipFillColorMany,
  setClipFillOpacity,
  setClipFillOpacityMany,
  setClipShapeGeometry,
  setClipShapeGeometryMany,
} from "./shapeOps";
import { SCHEMA_VERSION, createTrack, normalizeDocument, type TimelineDocument } from "./tracks";

/** One clip of every kind that matters here, built the way the app builds one. */
function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0), createTrack("a0", "audio", 1)],
    elements: {
      shape: shapeElement({ trackId: "v0", startTime: 0, duration: 1000 }),
      drawn: shapeElement({
        trackId: "v0",
        startTime: 1000,
        duration: 1000,
        shape: [
          [3, 4],
          [80, 10],
          [40, 90],
        ],
      }),
      picture: imageElement({ trackId: "v0", startTime: 2000, duration: 1000 }),
      title: textElement({ trackId: "v0", startTime: 3000, duration: 1000 }),
      sound: audioElement({ trackId: "a0", startTime: 0, duration: 1000 }),
    },
  });
}

const geometryOf = (d: TimelineDocument, id: string) => shapeGeometryOf(d.elements[id]);

describe("isShapeElement", () => {
  it("admits a shape and nothing else", () => {
    const d = doc();
    expect(isShapeElement(d.elements.shape)).toBe(true);
    expect(isShapeElement(d.elements.picture)).toBe(false);
    expect(isShapeElement(d.elements.sound)).toBe(false);
    expect(isShapeElement(undefined)).toBe(false);
  });
});

describe("setClipShapeGeometry", () => {
  it("gives a hand-drawn shape a recipe, and replaces its outline", () => {
    const before = doc();
    const after = setClipShapeGeometry(before, "drawn", { kind: "star" });

    expect(geometryOf(after, "drawn")).toEqual({ kind: "star" });
    // The three clicked vertices are gone: that is what "replaces the outline"
    // means, and it is the one thing the panel warns about before doing it.
    expect((after.elements.drawn as any).shape).toHaveLength(10);
  });

  it("patches one field and leaves the rest of the recipe alone", () => {
    const one = setClipShapeGeometry(doc(), "shape", { kind: "star", count: 9 });
    const two = setClipShapeGeometry(one, "shape", { radius: 6 });
    expect(geometryOf(two, "shape")).toEqual({ kind: "star", count: 9, radius: 6 });
  });

  /**
   * The pair, and the only thing that keeps it from disagreeing: one writer.
   * The mirror is rebuilt in the same transform as the recipe, never later and
   * never by anybody else.
   */
  it("rewrites the mirror in the same step, against the authoring box", () => {
    const after = setClipShapeGeometry(doc(), "shape", { kind: "polygon", count: 7 });
    const element = after.elements.shape as any;
    expect(element.shape).toEqual(
      flattenOutline(normalizeShapeGeometry("polygon", { count: 7 }), {
        width: element.oWidth,
        height: element.oHeight,
      }),
    );
    expect(mirrorFor(element)).toEqual(element.shape);
  });

  /**
   * The mirror has to be in **authoring** space, because `renderShape`
   * multiplies every stored point by `shapeDrawScale` on the way out. Built
   * against the drawn size it would be scaled twice, which is the defect
   * `SHAPE_AUTHORING_BOX`'s own comment records from the other direction.
   */
  it("mirrors against oWidth/oHeight and not the drawn size", () => {
    const base = doc();
    const stretched = {
      ...base,
      elements: {
        ...base.elements,
        shape: { ...(base.elements.shape as any), width: 400, height: 50 },
      },
    } as TimelineDocument;

    const after = setClipShapeGeometry(stretched, "shape", { kind: "rectangle" });
    // The authoring box is 100 square, so the mirror is too, however wide the
    // clip has been dragged.
    expect((after.elements.shape as any).shape).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("leaves every other clip and the tracks alone", () => {
    const before = doc();
    const after = setClipShapeGeometry(before, "shape", { kind: "star" });
    expect(after.elements.picture).toBe(before.elements.picture);
    expect(after.elements.drawn).toBe(before.elements.drawn);
    expect(after.tracks).toBe(before.tracks);
  });

  it("never touches the animation block", () => {
    const before = doc();
    const after = setClipShapeGeometry(before, "shape", { kind: "star" });
    expect((after.elements.shape as any).animation).toBe(
      (before.elements.shape as any).animation,
    );
  });

  /**
   * `maskOps`'s fourth rule, which matters most for the arrays here.
   * `clipOps#pasteClips` shares everything but the animation block between a
   * clip and its copy, so an in-place edit would change both and reach
   * backwards into every undo entry that shares the element.
   */
  it("mutates nothing it was given", () => {
    const before = doc();
    const snapshot = JSON.parse(JSON.stringify(before.elements.shape));
    setClipShapeGeometry(before, "shape", { kind: "star", count: 11, radius: 3 });
    expect(before.elements.shape).toEqual(snapshot);
  });
});

describe("clearClipShapeGeometry", () => {
  /**
   * The byte-identity claim `ShapeGeometry` makes. A shape returned to having
   * no recipe has to be the same element a shape that never had one is, key and
   * all, or `SCHEMA_VERSION` would have had to move.
   */
  it("leaves a shape byte-identical to one that never had a recipe", () => {
    const pristine = doc();
    const roundTripped = clearClipShapeGeometry(
      // The rectangle recipe mirrors to the same four points the fixture
      // already holds, so nothing but the key itself changes.
      setClipShapeGeometry(pristine, "shape", { kind: "rectangle" }),
      "shape",
    );
    expect(JSON.stringify(roundTripped.elements.shape)).toBe(
      JSON.stringify(pristine.elements.shape),
    );
    expect("geometry" in (roundTripped.elements.shape as any)).toBe(false);
  });

  /**
   * The outline stays. Dropping the recipe is "stop generating this", not
   * "delete it": the shape on screen is the one the user is looking at, and it
   * becomes an ordinary hand-made polygon from then on.
   */
  it("keeps the outline the recipe last produced", () => {
    const starred = setClipShapeGeometry(doc(), "shape", { kind: "star", count: 6 });
    const cleared = clearClipShapeGeometry(starred, "shape");
    expect((cleared.elements.shape as any).shape).toEqual(
      (starred.elements.shape as any).shape,
    );
    expect(shapeGeometryOf(cleared.elements.shape)).toBeNull();
  });
});

describe("setClipFillColor", () => {
  it("writes the colour", () => {
    const after = setClipFillColor(doc(), "shape", "#123456");
    expect((after.elements.shape as any).option.fillColor).toBe("#123456");
  });

  it("does not disturb the rest of the option block", () => {
    const before = doc();
    const after = setClipFillColor(before, "shape", "#123456");
    expect((after.elements.shape as any).option).not.toBe(
      (before.elements.shape as any).option,
    );
    expect((before.elements.shape as any).option.fillColor).not.toBe("#123456");
  });
});

describe("declining by identity", () => {
  /**
   * `withCheckpoint` reads identity to mean "nothing happened" and records no
   * undo step. Every one of these is a way the panel or an agent can ask for
   * something that changes nothing.
   */
  it.each(["picture", "title", "sound"])("on a %s clip", (id) => {
    const d = doc();
    expect(setClipShapeGeometry(d, id, { kind: "star" })).toBe(d);
    expect(setClipFillColor(d, id, "#123456")).toBe(d);
    expect(clearClipShapeGeometry(d, id)).toBe(d);
  });

  it("on a missing id", () => {
    const d = doc();
    expect(setClipShapeGeometry(d, "nope", { kind: "star" })).toBe(d);
    expect(setClipFillColor(d, "nope", "#123456")).toBe(d);
    expect(clearClipShapeGeometry(d, "nope")).toBe(d);
  });

  it("on the recipe the shape already has", () => {
    const d = setClipShapeGeometry(doc(), "shape", { kind: "star", count: 8 });
    expect(setClipShapeGeometry(d, "shape", { kind: "star", count: 8 })).toBe(d);
    // And on the default spelled out, which is the click that sets a shape to
    // what it is.
    const plain = setClipShapeGeometry(doc(), "shape", { kind: "polygon" });
    expect(setClipShapeGeometry(plain, "shape", { count: 3 })).toBe(plain);
  });

  it("on the colour the shape already has", () => {
    const d = doc();
    const colour = (d.elements.shape as any).option.fillColor;
    expect(setClipFillColor(d, "shape", colour)).toBe(d);
    expect(setClipFillColor(d, "shape", "")).toBe(d);
    expect(setClipFillColor(d, "shape", 7 as never)).toBe(d);
  });

  it("on a patch with no kind, for a shape that has no recipe", () => {
    const d = doc();
    expect(setClipShapeGeometry(d, "drawn", { radius: 8 })).toBe(d);
  });

  it("on clearing a shape that has no recipe", () => {
    const d = doc();
    expect(clearClipShapeGeometry(d, "drawn")).toBe(d);
  });

  /**
   * The panel's spinners emit a `NaN` mid-edit. The unreadable value is dropped
   * and the call then declines, rather than the number being clamped into
   * something the user never typed.
   */
  it("on a patch whose only value is unreadable", () => {
    const d = setClipShapeGeometry(doc(), "shape", { kind: "star", count: 8 });
    expect(setClipShapeGeometry(d, "shape", { count: NaN })).toBe(d);
    expect(setClipShapeGeometry(d, "shape", {})).toBe(d);
  });
});

describe("the many-folds", () => {
  it("apply to every id and keep the decline contract", () => {
    const before = doc();
    const after = setClipShapeGeometryMany(before, ["shape", "drawn"], { kind: "star" });
    expect(geometryOf(after, "shape")).toEqual({ kind: "star" });
    expect(geometryOf(after, "drawn")).toEqual({ kind: "star" });

    // Folding preserves the contract for free: nothing changed, nothing moved.
    expect(setClipShapeGeometryMany(after, ["shape", "drawn"], { kind: "star" })).toBe(after);
    expect(setClipShapeGeometryMany(before, [], { kind: "star" })).toBe(before);
  });

  it("skips the ids that cannot carry one without failing the rest", () => {
    const after = setClipFillColorMany(doc(), ["shape", "sound"], "#abcdef");
    expect((after.elements.shape as any).option.fillColor).toBe("#abcdef");
    expect(after.elements.sound).toEqual(doc().elements.sound);
  });
});

describe("the mirror of a shape with no recipe", () => {
  it("is the outline it already holds", () => {
    const d = doc();
    expect(mirrorFor(d.elements.drawn as any)).toBe((d.elements.drawn as any).shape);
  });

  /**
   * The fallback ladder `renderer/shape.ts#scaleOf` walks, so a project saved
   * before `oHeight` was written mirrors into the box it actually draws in
   * rather than collapsing onto an axis.
   */
  it("falls back across the axes when an authored size is missing", () => {
    const element = shapeElement({ oWidth: 200, oHeight: undefined as never });
    const withRecipe = {
      ...element,
      geometry: normalizeShapeGeometry("rectangle", {}),
    };
    expect(mirrorFor(withRecipe as any)).toEqual([
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ]);
  });

  it("falls back to a hundred when neither axis is usable", () => {
    const element = shapeElement({ oWidth: 0, oHeight: 0 });
    const withRecipe = {
      ...element,
      geometry: normalizeShapeGeometry("rectangle", {}),
    };
    expect(mirrorFor(withRecipe as any)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });
});

describe("setClipBackdropFx", () => {
  const PIXELATE = {
    presetId: "com.cartcut.pixelate",
    params: { size: 16, average: true },
    intensity: 100,
  };

  it("gives a shape a backdrop, coerced", () => {
    const next = setClipBackdropFx(doc(), "shape", { ...PIXELATE, intensity: 140 });
    expect(next.elements.shape).toMatchObject({
      backdropFx: { ...PIXELATE, intensity: 100 },
    });
  });

  it("declines a shape that already has that backdrop", () => {
    const once = setClipBackdropFx(doc(), "shape", PIXELATE);
    expect(setClipBackdropFx(once, "shape", { ...PIXELATE, params: { ...PIXELATE.params } })).toBe(once);
  });

  it("declines anything that is not a shape", () => {
    const d = doc();
    for (const id of ["picture", "title", "sound", "missing"]) {
      expect(setClipBackdropFx(d, id, PIXELATE)).toBe(d);
    }
  });

  it("declines a backdrop the coercer refuses", () => {
    const d = doc();
    expect(setClipBackdropFx(d, "shape", { presetId: "" })).toBe(d);
    expect(setClipBackdropFx(d, "shape", { presetId: "inline.0123456789abcdef" })).toBe(d);
  });

  it("takes it away with null, deleting the key", () => {
    const withFx = setClipBackdropFx(doc(), "shape", PIXELATE);
    const cleared = setClipBackdropFx(withFx, "shape", null);
    expect("backdropFx" in cleared.elements.shape).toBe(false);
    // And declines when there is nothing to take.
    expect(setClipBackdropFx(cleared, "shape", null)).toBe(cleared);
  });

  it("never mutates the shape it was given", () => {
    const d = doc();
    const before = JSON.stringify(d.elements.shape);
    setClipBackdropFx(d, "shape", PIXELATE);
    expect(JSON.stringify(d.elements.shape)).toBe(before);
  });

  it("drops the tracks of parameters the new preset does not have", () => {
    const track = { isActivate: true, x: [], ax: [] };
    const withFx = setClipBackdropFx(doc(), "shape", PIXELATE);
    const animated = {
      ...withFx,
      elements: {
        ...withFx.elements,
        shape: {
          ...withFx.elements.shape,
          animation: {
            ...(withFx.elements.shape as any).animation,
            "fx:size": track,
            intensity: track,
          },
        } as any,
      },
    };

    const blurred = setClipBackdropFx(animated, "shape", {
      presetId: "com.cartcut.gaussian-blur",
      params: { radius: 8 },
      intensity: 100,
    });
    const after = (blurred.elements.shape as any).animation;
    expect(after["fx:size"]).toBeUndefined();
    // Intensity belongs to the backdrop, not to the preset, so it stays.
    expect(after.intensity).toBe(track);
    // Every movement track the shape had is kept.
    expect(after.position).toBeDefined();

    const cleared = (setClipBackdropFx(animated, "shape", null).elements.shape as any).animation;
    expect(cleared["fx:size"]).toBeUndefined();
    expect(cleared.intensity).toBeUndefined();
    expect(cleared.position).toBeDefined();
  });

  it("folds over a selection, skipping what is not a shape", () => {
    const next = setClipBackdropFxMany(doc(), ["shape", "drawn", "picture"], PIXELATE);
    expect((next.elements.shape as any).backdropFx).toBeDefined();
    expect((next.elements.drawn as any).backdropFx).toBeDefined();
    expect((next.elements.picture as any).backdropFx).toBeUndefined();
  });
});

describe("patchClipBackdropFx", () => {
  const PIXELATE = {
    presetId: "com.cartcut.pixelate",
    params: { size: 16, average: true },
    intensity: 100,
  };

  it("changes one parameter and keeps the rest", () => {
    const withFx = setClipBackdropFx(doc(), "shape", PIXELATE);
    const next = patchClipBackdropFx(withFx, "shape", { params: { size: 40 } });
    expect((next.elements.shape as any).backdropFx).toEqual({
      ...PIXELATE,
      params: { size: 40, average: true },
    });
  });

  it("declines a shape with no backdrop, and a patch that changes nothing", () => {
    const d = doc();
    expect(patchClipBackdropFx(d, "shape", { intensity: 50 })).toBe(d);
    const withFx = setClipBackdropFx(d, "shape", PIXELATE);
    expect(patchClipBackdropFx(withFx, "shape", { params: { size: 16 } })).toBe(withFx);
  });
});

describe("setClipFillOpacity", () => {
  it("stores a translucent fill beside the colour", () => {
    const next = setClipFillOpacity(doc(), "shape", 40);
    expect((next.elements.shape as any).option).toEqual({
      fillColor: "#ff0000",
      fillOpacity: 40,
    });
  });

  it("deletes the key at full strength, so the shape saves as it always did", () => {
    const d = doc();
    const translucent = setClipFillOpacity(d, "shape", 40);
    const back = setClipFillOpacity(translucent, "shape", 100);
    expect((back.elements.shape as any).option).toEqual({ fillColor: "#ff0000" });
    expect(JSON.stringify(back.elements.shape)).toBe(JSON.stringify(d.elements.shape));
  });

  it("declines what changes nothing, a non-number and a non-shape", () => {
    const d = doc();
    expect(setClipFillOpacity(d, "shape", 100)).toBe(d);
    expect(setClipFillOpacity(d, "shape", 140)).toBe(d);
    expect(setClipFillOpacity(d, "shape", NaN)).toBe(d);
    expect(setClipFillOpacity(d, "picture", 40)).toBe(d);
    const once = setClipFillOpacity(d, "shape", 40);
    expect(setClipFillOpacity(once, "shape", 40)).toBe(once);
  });

  it("clamps below zero", () => {
    expect((setClipFillOpacity(doc(), "shape", -10).elements.shape as any).option.fillOpacity).toBe(0);
  });

  it("folds over a selection", () => {
    const next = setClipFillOpacityMany(doc(), ["shape", "drawn"], 0);
    expect((next.elements.shape as any).option.fillOpacity).toBe(0);
    expect((next.elements.drawn as any).option.fillOpacity).toBe(0);
  });
});

describe("chooseClipBackdrop", () => {
  const PIXELATE = { presetId: "com.cartcut.pixelate", params: { size: 16 } };

  it("switches the fill off for a shape's first backdrop", () => {
    const next = chooseClipBackdrop(doc(), "shape", PIXELATE);
    expect((next.elements.shape as any).option.fillOpacity).toBe(0);
    expect((next.elements.shape as any).backdropFx.intensity).toBe(100);
  });

  it("keeps the fill and the intensity across a preset change", () => {
    let next = chooseClipBackdrop(doc(), "shape", { ...PIXELATE, intensity: 60 });
    next = setClipFillOpacity(next, "shape", 35);
    next = chooseClipBackdrop(next, "shape", {
      presetId: "com.cartcut.gaussian-blur",
      params: { radius: 8 },
    });
    const shape = next.elements.shape as any;
    expect(shape.backdropFx).toEqual({
      presetId: "com.cartcut.gaussian-blur",
      params: { radius: 8 },
      intensity: 60,
    });
    expect(shape.option.fillOpacity).toBe(35);
  });

  it("declines what changes nothing, and anything that is not a shape", () => {
    const once = chooseClipBackdrop(doc(), "shape", PIXELATE);
    expect(chooseClipBackdrop(once, "shape", PIXELATE)).toBe(once);
    const d = doc();
    expect(chooseClipBackdrop(d, "picture", PIXELATE)).toBe(d);
    expect(chooseClipBackdrop(d, "shape", { presetId: "" })).toBe(d);
  });
});
