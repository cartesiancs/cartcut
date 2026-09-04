import { describe, expect, it } from "vitest";

import type { MaskNode } from "../../@types/timeline";
import { MASK_ANIMATABLE_PROPERTIES, animatableProperties } from "../../@types/timeline";
import { emptyAnimation, normalizeAnimation } from "../animation/keyframes";
import { addKeyframe, rebakeAnimations } from "../animation/keyframeOps";
import { pasteClips, splitClip, trimClipStart } from "./clipOps";
import {
  DEFAULT_MASK_FEATHER,
  DEFAULT_MASK_ROUNDNESS,
  defaultMask,
  maskOf,
} from "../mask/maskShape";
import {
  audioElement,
  gifElement,
  imageElement,
  shapeElement,
} from "../renderer/testing";
import {
  MASKABLE_FILETYPES,
  isMaskable,
  maskRefOf,
  setClipMask,
  setClipMaskFields,
  setClipMaskFieldsMany,
  setClipMaskMany,
  setClipMaskPath,
} from "./maskOps";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "./tracks";

function doc(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  };
}

const TRIANGLE: MaskNode[] = [
  { p: [-0.5, 0.5] },
  { p: [0.5, 0.5] },
  { p: [0, -0.5] },
];

describe("isMaskable", () => {
  it("covers the five layer-painted types and nothing else", () => {
    expect([...MASKABLE_FILETYPES].sort()).toEqual(
      ["gif", "image", "shape", "text", "video"].sort(),
    );
    expect(isMaskable(imageElement())).toBe(true);
    expect(isMaskable(shapeElement())).toBe(true);
    expect(isMaskable(gifElement())).toBe(true);
    expect(isMaskable(audioElement())).toBe(false);
    expect(isMaskable(null)).toBe(false);
    expect(isMaskable(undefined)).toBe(false);
  });
});

describe("setClipMask", () => {
  it("applies a mask at its defaults", () => {
    const next = setClipMask(doc({ a: imageElement() }), "a", "star");
    expect(maskRefOf(next, "a")).toEqual(defaultMask("star"));
  });

  it("seeds the five mask tracks, empty and switched off", () => {
    const next = setClipMask(doc({ a: imageElement() }), "a", "rectangle");
    const animation = (next.elements.a as any).animation;
    for (const property of MASK_ANIMATABLE_PROPERTIES) {
      expect(animation[property], property).toBeDefined();
      expect(animation[property].isActivate, property).toBe(false);
      expect(animation[property].x, property).toEqual([]);
    }
    // The two vector tracks carry a second lane; the three scalars do not.
    expect(animation.maskPosition.y).toEqual([]);
    expect(animation.maskSize.y).toEqual([]);
    expect(animation.maskRotation.y).toBeUndefined();
  });

  it("leaves the clip's own four tracks exactly as they were", () => {
    const before = imageElement();
    const next = setClipMask(doc({ a: before }), "a", "rectangle");
    const animation = (next.elements.a as any).animation;
    for (const property of ["position", "opacity", "scale", "rotation"]) {
      expect(animation[property]).toEqual((before as any).animation[property]);
    }
  });

  describe("clearing", () => {
    it("removes the key rather than storing undefined", () => {
      const applied = setClipMask(doc({ a: imageElement() }), "a", "rectangle");
      const cleared = setClipMask(applied, "a", null);
      // `JSON.stringify` drops an undefined value but `structuredClone` — which
      // the copy path uses — keeps it, so the saved project and the in-memory
      // one would disagree about whether the clip had ever been masked.
      expect("mask" in (cleared.elements.a as any)).toBe(false);
    });

    it("removes the five mask tracks with it", () => {
      const applied = setClipMask(doc({ a: imageElement() }), "a", "rectangle");
      const cleared = setClipMask(applied, "a", null);
      const animation = (cleared.elements.a as any).animation;
      for (const property of MASK_ANIMATABLE_PROPERTIES) {
        expect(property in animation, property).toBe(false);
      }
      // Against `emptyAnimation` rather than a written-out list: the claim is
      // "the five went and the clip's own block came back", and spelling the
      // block out here means every track added to it later fails this test for
      // no reason.
      expect(Object.keys(animation).sort()).toEqual(
        Object.keys(emptyAnimation("image")).sort(),
      );
    });

    it("leaves an unmasked clip byte-identical to one that never had a mask", () => {
      const pristine = doc({ a: imageElement() });
      const roundTripped = setClipMask(
        setClipMask(pristine, "a", "heart"),
        "a",
        null,
      );
      expect(JSON.stringify(roundTripped.elements.a)).toBe(
        JSON.stringify(pristine.elements.a),
      );
    });
  });

  describe("declining by identity", () => {
    it("declines on a filetype that cannot carry a mask", () => {
      const before = doc({ a: audioElement() });
      expect(setClipMask(before, "a", "rectangle")).toBe(before);
    });

    it("declines on an element that is not there", () => {
      const before = doc({ a: imageElement() });
      expect(setClipMask(before, "missing", "rectangle")).toBe(before);
    });

    it("declines on an unknown shape", () => {
      const before = doc({ a: imageElement() });
      expect(setClipMask(before, "a", "octagon" as any)).toBe(before);
    });

    it("declines when clearing a clip that has no mask", () => {
      const before = doc({ a: imageElement() });
      expect(setClipMask(before, "a", null)).toBe(before);
    });

    // Clicking the shape a clip already has must cost the user nothing.
    it("declines when the shape is already the one asked for", () => {
      const applied = setClipMask(doc({ a: imageElement() }), "a", "star");
      expect(setClipMask(applied, "a", "star")).toBe(applied);
    });
  });

  // The same reason a LUT's intensity carries over: trying five shapes should
  // compare five shapes in the frame you set up, not reset it four times.
  it("carries the placement across a change of shape", () => {
    const placed = setClipMaskFields(
      setClipMask(doc({ a: imageElement() }), "a", "rectangle"),
      "a",
      { location: { x: 20, y: 30 }, rotation: 45, feather: 8 },
    );
    const switched = setClipMask(placed, "a", "heart");
    const mask = maskRefOf(switched, "a")!;
    expect(mask.shape).toBe("heart");
    expect(mask.location).toEqual({ x: 20, y: 30 });
    expect(mask.rotation).toBe(45);
    expect(mask.feather).toBe(8);
  });

  it("keeps the mask tracks that were already seeded when the shape changes", () => {
    const applied = setClipMask(doc({ a: imageElement() }), "a", "rectangle");
    const withTrack = {
      ...applied,
      elements: {
        a: {
          ...(applied.elements.a as any),
          animation: {
            ...(applied.elements.a as any).animation,
            maskRotation: { isActivate: true, x: [], ax: [[0, 12]] },
          },
        },
      },
    };
    const switched = setClipMask(withTrack, "a", "star");
    expect((switched.elements.a as any).animation.maskRotation.ax).toEqual([[0, 12]]);
  });

  // A GIF is maskable but not animatable — it carries no `animation` block at
  // all — so there is nowhere to seed tracks, and inventing one would give it a
  // curve editor for a clip type that has never had one.
  it("masks a gif without inventing an animation block for it", () => {
    const next = setClipMask(doc({ a: gifElement() }), "a", "rectangle");
    expect(maskRefOf(next, "a")).toEqual(defaultMask("rectangle"));
    expect((next.elements.a as any).animation).toBeUndefined();
  });
});

describe("setClipMaskFields", () => {
  const masked = () => setClipMask(doc({ a: imageElement() }), "a", "rectangle");

  it("patches only what it is given", () => {
    const next = setClipMaskFields(masked(), "a", { feather: 12 });
    const mask = maskRefOf(next, "a")!;
    expect(mask.feather).toBe(12);
    expect(mask.roundness).toBe(DEFAULT_MASK_ROUNDNESS);
    expect(mask.shape).toBe("rectangle");
  });

  it("clamps rather than refuses, matching the sliders it is driven by", () => {
    const next = setClipMaskFields(masked(), "a", { roundness: 500, feather: -4 });
    expect(maskRefOf(next, "a")!.roundness).toBe(100);
    expect(maskRefOf(next, "a")!.feather).toBe(DEFAULT_MASK_FEATHER);
  });

  it("stores invert as a flag and removes it again rather than storing false", () => {
    const on = setClipMaskFields(masked(), "a", { invert: true });
    expect((on.elements.a as any).mask.invert).toBe(true);
    const off = setClipMaskFields(on, "a", { invert: false });
    expect("invert" in (off.elements.a as any).mask).toBe(false);
  });

  it("declines on an unmasked clip", () => {
    const before = doc({ a: imageElement() });
    expect(setClipMaskFields(before, "a", { feather: 4 })).toBe(before);
  });

  it("declines when nothing in the patch changes anything", () => {
    const before = masked();
    expect(setClipMaskFields(before, "a", {})).toBe(before);
    expect(setClipMaskFields(before, "a", { rotation: 0 })).toBe(before);
  });

  it("ignores an unreadable number instead of writing NaN into the document", () => {
    const before = masked();
    expect(setClipMaskFields(before, "a", { rotation: NaN })).toBe(before);
    expect(setClipMaskFields(before, "a", { feather: Infinity })).toBe(before);
  });
});

describe("setClipMaskPath", () => {
  it("stores a drawn path and switches the shape to pen", () => {
    const next = setClipMaskPath(doc({ a: imageElement() }), "a", TRIANGLE);
    const mask = maskRefOf(next, "a")!;
    expect(mask.shape).toBe("pen");
    expect(mask.path).toEqual(TRIANGLE);
  });

  it("seeds the mask tracks for a clip that had no mask at all", () => {
    const next = setClipMaskPath(doc({ a: imageElement() }), "a", TRIANGLE);
    expect(animatableProperties(next.elements.a)).toContain("maskPosition");
  });

  it("declines on a path that cannot enclose anything", () => {
    const before = doc({ a: imageElement() });
    expect(setClipMaskPath(before, "a", TRIANGLE.slice(0, 2))).toBe(before);
    expect(setClipMaskPath(before, "a", [])).toBe(before);
  });

  it("declines on a malformed path rather than storing it", () => {
    const before = doc({ a: imageElement() });
    expect(setClipMaskPath(before, "a", [{ p: [0] }, { p: [1, 1] }, { p: [0, 1] }] as any)).toBe(
      before,
    );
  });

  it("declines when the path is the one already stored", () => {
    const before = setClipMaskPath(doc({ a: imageElement() }), "a", TRIANGLE);
    expect(setClipMaskPath(before, "a", [...TRIANGLE])).toBe(before);
  });

  // `pasteClips` deliberately shares everything but the animation block, so a
  // duplicate holds the *same* mask object as its original. Every write here
  // must therefore build a new one — an in-place push into `path` would edit
  // the original, and reach backwards into every undo entry sharing it.
  it("never mutates the mask it was given", () => {
    const start = setClipMaskPath(doc({ a: imageElement() }), "a", TRIANGLE);
    const shared = (start.elements.a as any).mask;
    const before = JSON.stringify(shared);

    const next = setClipMaskPath(start, "a", [...TRIANGLE, { p: [0.4, 0] }]);

    expect(JSON.stringify(shared)).toBe(before);
    expect((next.elements.a as any).mask).not.toBe(shared);
    expect((next.elements.a as any).mask.path).not.toBe(shared.path);
  });

  it("drops a stale path when the shape moves off pen", () => {
    const drawn = setClipMaskPath(doc({ a: imageElement() }), "a", TRIANGLE);
    const switched = setClipMask(drawn, "a", "rectangle");
    expect("path" in (switched.elements.a as any).mask).toBe(false);
  });
});

describe("the many-at-once variants", () => {
  const two = () => doc({ a: imageElement(), b: shapeElement(), c: audioElement() });

  it("apply as one document, skipping what cannot take a mask", () => {
    const next = setClipMaskMany(two(), ["a", "b", "c"], "heart");
    expect(maskRefOf(next, "a")?.shape).toBe("heart");
    expect(maskRefOf(next, "b")?.shape).toBe("heart");
    expect(maskRefOf(next, "c")).toBeNull();
  });

  it("decline by identity when no id can take the edit", () => {
    const before = two();
    expect(setClipMaskMany(before, ["c"], "heart")).toBe(before);
    expect(setClipMaskMany(before, [], "heart")).toBe(before);
    expect(setClipMaskFieldsMany(before, ["a"], { feather: 3 })).toBe(before);
  });

  it("patch many masks at once", () => {
    const masked = setClipMaskMany(two(), ["a", "b"], "rectangle");
    const next = setClipMaskFieldsMany(masked, ["a", "b"], { feather: 6 });
    expect(maskRefOf(next, "a")!.feather).toBe(6);
    expect(maskRefOf(next, "b")!.feather).toBe(6);
  });
});

describe("the tracks and the mask stay in step", () => {
  // The orphan case: mask curves with no mask are invisible to the curve
  // editor, the diamond lane, `keyframeOps` and `rebakeElement`, while still
  // being cloned, sliced and saved. `normalizeAnimation` collects them.
  it("drops mask tracks left behind on an unmasked clip", () => {
    const orphan = imageElement({
      animation: {
        ...(imageElement() as any).animation,
        maskFeather: { isActivate: true, x: [], ax: [[0, 5]] },
      } as any,
    });
    const repaired = normalizeAnimation(orphan);
    expect("maskFeather" in (repaired as any).animation).toBe(false);
  });

  it("keeps them on a clip that still has its mask", () => {
    const masked = setClipMask(doc({ a: imageElement() }), "a", "rectangle");
    const repaired = normalizeAnimation(masked.elements.a);
    expect("maskFeather" in (repaired as any).animation).toBe(true);
  });

  it("offers the mask properties for animation only once a mask exists", () => {
    const before = doc({ a: imageElement() });
    expect(animatableProperties(before.elements.a)).not.toContain("maskPosition");
    const after = setClipMask(before, "a", "rectangle");
    expect(animatableProperties(after.elements.a)).toEqual([
      ...animatableProperties(before.elements.a),
      ...MASK_ANIMATABLE_PROPERTIES,
    ]);
  });
});

describe("mask curves survive the clip's own lifecycle", () => {
  /** A masked clip whose mask position is keyed on both lanes. */
  function keyedMask(): TimelineDocument {
    const applied = setClipMask(
      doc({
        a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
      }),
      "a",
      "rectangle",
    );
    return addKeyframe(
      addKeyframe(
        addKeyframe(
          addKeyframe(applied, "a", "maskPosition", "x", 0, 10),
          "a",
          "maskPosition",
          "y",
          0,
          20,
        ),
        "a",
        "maskPosition",
        "x",
        3000,
        90,
      ),
      "a",
      "maskPosition",
      "y",
      3000,
      80,
    );
  }

  const lanes = (element: any) => ({
    x: element.animation.maskPosition.x.length,
    y: element.animation.maskPosition.y.length,
    ax: element.animation.maskPosition.ax.length,
    ay: element.animation.maskPosition.ay.length,
  });

  /**
   * The failure this pins is the quiet one. Every lifecycle helper walks
   * `Object.keys(animation)` — so mask tracks are *seen* the moment they exist
   * — but then asks `lanesOf(property)` which lanes to carry. Until
   * `VECTOR_PROPERTIES` knows about `maskPosition` and `maskSize`, all four of
   * these drop the `y` and `ay` lanes: the mask animates horizontally and jumps
   * vertically, with no error anywhere.
   */
  it("carries both lanes through a split", () => {
    const split = splitClip(keyedMask(), "a", 2000, "b");
    expect(lanes(split.elements.a).y).toBeGreaterThan(0);
    expect(lanes(split.elements.a).ay).toBeGreaterThan(0);
    expect(lanes(split.elements.b).y).toBeGreaterThan(0);
    expect(lanes(split.elements.b).ay).toBeGreaterThan(0);
  });

  it("carries both lanes through a trim", () => {
    const trimmed = trimClipStart(keyedMask(), "a", 1000);
    const after = lanes(trimmed.elements.a);
    expect(after.y).toBeGreaterThan(0);
    expect(after.ay).toBeGreaterThan(0);
  });

  it("carries both lanes through a duplicate, sharing nothing mutable", () => {
    const source = keyedMask();
    const pasted = pasteClips(
      source,
      { a: source.elements.a },
      0,
      () => "copy",
    );
    const copy = pasted.elements.copy as any;
    expect(lanes(copy).y).toBeGreaterThan(0);
    expect(copy.animation).not.toBe((source.elements.a as any).animation);
    expect(copy.animation.maskPosition.y).not.toBe(
      (source.elements.a as any).animation.maskPosition.y,
    );
  });

  it("re-bakes mask lanes when the project frame rate changes", () => {
    const before = keyedMask();
    const after = rebakeAnimations(before, 120);
    const track = (after.elements.a as any).animation.maskPosition;
    expect(track.ax.length).toBeGreaterThan(
      (before.elements.a as any).animation.maskPosition.ax.length,
    );
    expect(track.ay.length).toBe(track.ax.length);
  });
});

describe("maskRefOf", () => {
  it("reads through the guard, so a hand-edited mask comes back usable", () => {
    const broken = doc({
      a: imageElement({ mask: { shape: "star", feather: "8" } as any }),
    });
    expect(maskRefOf(broken, "a")).toEqual(defaultMask("star"));
  });

  it("answers null for an unmasked or missing clip", () => {
    const d = doc({ a: imageElement() });
    expect(maskRefOf(d, "a")).toBeNull();
    expect(maskRefOf(d, "nope")).toBeNull();
  });

  it("agrees with maskOf on the element", () => {
    const next = setClipMask(doc({ a: imageElement() }), "a", "heart");
    expect(maskRefOf(next, "a")).toEqual(maskOf(next.elements.a));
  });
});
