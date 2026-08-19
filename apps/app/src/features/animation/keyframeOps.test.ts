import { describe, it, expect } from "vitest";
import {
  addKeyframe,
  moveKeyframe,
  normalizeAnimations,
  removeKeyframe,
  setHandles,
  setTrackActive,
} from "./keyframeOps";
import { bakeTrack, sampleBaked } from "./keyframes";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  audioElement,
  gifElement,
  imageElement,
  keys,
  pixel,
  points,
  scene,
  shapeElement,
} from "../renderer/testing";
import { renderElement } from "../renderer/element";

function doc(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  };
}

/** An image with one animated opacity track. */
function animated(over: Record<string, any> = {}) {
  const base = imageElement();
  return imageElement({
    trackId: "v1",
    animation: {
      ...(base.animation as any),
      opacity: {
        isActivate: true,
        x: keys([0, 0], [1000, 100]),
        ax: points([0, 0], [1000, 100]),
      },
      ...over,
    } as any,
  });
}

const track = (d: TimelineDocument, property = "opacity", lane = "x") =>
  (d.elements.a as any).animation[property][lane];
const baked = (d: TimelineDocument, property = "opacity", key = "ax") =>
  (d.elements.a as any).animation[property][key];

describe("decline by identity", () => {
  const base = doc({ a: animated() });

  it("declines an unknown element", () => {
    expect(addKeyframe(base, "nope", "opacity", "x", 500, 50)).toBe(base);
  });

  it("declines a property the element cannot animate", () => {
    // A shape's type carries `opacity` alone, so a scale keyframe would create
    // a track the renderer never reads.
    const shapes = doc({ a: shapeElement({ trackId: "v1" }) });
    expect(addKeyframe(shapes, "a", "scale", "x", 0, 1)).toBe(shapes);
    expect(addKeyframe(shapes, "a", "position", "x", 0, 1)).toBe(shapes);
  });

  it("declines gif and audio, which carry no animation block", () => {
    for (const element of [gifElement(), audioElement()]) {
      const d = doc({ a: { ...element, trackId: "v1" } });
      expect(addKeyframe(d, "a", "opacity", "x", 0, 1)).toBe(d);
      expect(setTrackActive(d, "a", "opacity", true)).toBe(d);
    }
  });

  it("declines a y lane on a single-lane property", () => {
    expect(addKeyframe(base, "a", "opacity", "y", 500, 50)).toBe(base);
  });

  it.each([-1, 99])("declines an out-of-range index %s", (index) => {
    expect(removeKeyframe(base, "a", "opacity", "x", index)).toBe(base);
    expect(setHandles(base, "a", "opacity", "x", index, { cs: [0, 0] })).toBe(
      base,
    );
    expect(moveKeyframe(base, "a", "opacity", "x", index, 5, 5).doc).toBe(base);
  });

  it("declines an add that changes nothing", () => {
    expect(addKeyframe(base, "a", "opacity", "x", 0, 0)).toBe(base);
  });

  it("declines toggling a track to the state it is already in", () => {
    expect(setTrackActive(base, "a", "opacity", true)).toBe(base);
  });
});

describe("authored and baked stay in step", () => {
  it("re-bakes on add", () => {
    // The API this replaces made baking a separate `interpolate()` call the
    // caller had to remember, and the delete path forgot it.
    const next = addKeyframe(doc({ a: animated() }), "a", "opacity", "x", 500, 40);
    expect(track(next)).toHaveLength(3);
    expect(baked(next)).toEqual(bakeTrack(track(next)));
  });

  it.each([
    ["move", (d: TimelineDocument) => moveKeyframe(d, "a", "opacity", "x", 0, 200, 5).doc],
    ["remove", (d: TimelineDocument) => removeKeyframe(d, "a", "opacity", "x", 0)],
    [
      "setHandles",
      (d: TimelineDocument) =>
        setHandles(d, "a", "opacity", "x", 0, { ce: [400, 80] }),
    ],
  ])("re-bakes on %s", (_label, op) => {
    const next = op(doc({ a: animated() }));
    expect(baked(next)).toEqual(bakeTrack(track(next)));
  });

  it("empties the bake when the last keyframe goes", () => {
    const one = doc({
      a: animated({
        opacity: { isActivate: true, x: keys([0, 0]), ax: points([0, 0]) },
      }),
    });
    const next = removeKeyframe(one, "a", "opacity", "x", 0);
    expect(track(next)).toEqual([]);
    expect(baked(next)).toEqual([]);
  });

  it("stops animating once the last keyframe is gone", () => {
    // End to end through the real renderer, not just on the data: the store
    // used to keep applying the animation the user had just deleted.
    const element = imageElement({
      width: 50,
      height: 50,
      location: { x: 0, y: 0 },
      opacity: 100,
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: keys([0, 0]), ax: points([0, 0]) },
      } as any,
    });

    const draw = (el: any) => {
      const { canvas, ctx } = scene(100, 100, "#000000");
      renderElement(ctx, "a", el, 0, false, (c) => {
        c.fillStyle = "#ff0000";
        c.fillRect(0, 0, 50, 50);
      });
      return canvas;
    };

    // Fully transparent while the 0-value keyframe stands.
    expect(pixel(draw(element), 25, 25)).toMatchObject({ r: 0, g: 0, b: 0 });

    const after = removeKeyframe(doc({ a: element }), "a", "opacity", "x", 0);
    expect(pixel(draw(after.elements.a), 25, 25)).toMatchObject({ r: 255 });
  });
});

describe("moveKeyframe", () => {
  it("reports the corrected index when the drag re-sorts the list", () => {
    const d = doc({
      a: animated({
        opacity: {
          isActivate: true,
          x: keys([0, 0], [500, 50], [1000, 100]),
          ax: [],
        },
      }),
    });
    const moved = moveKeyframe(d, "a", "opacity", "x", 0, 800, 0);
    expect(moved.index).toBe(1);
    expect(track(moved.doc).map((k: any) => k.p[0])).toEqual([500, 800, 1000]);
  });
});

describe("setTrackActive", () => {
  const inactive = () =>
    doc({
      a: imageElement({
        trackId: "v1",
        location: { x: 40, y: 70 },
        opacity: 55,
        rotation: 33,
      }),
    });

  it("seeds position from the element's location, both lanes", () => {
    const next = setTrackActive(inactive(), "a", "position", true, { atMs: 250 });
    const animation = (next.elements.a as any).animation.position;
    expect(animation.isActivate).toBe(true);
    expect(animation.x[0].p).toEqual([250, 40]);
    expect(animation.y[0].p).toEqual([250, 70]);
    expect(animation.ax).toEqual([[250, 40]]);
    expect(animation.ay).toEqual([[250, 70]]);
  });

  it.each([
    ["opacity", 55],
    ["rotation", 33],
  ])("seeds %s from its static field", (property, expected) => {
    const next = setTrackActive(inactive(), "a", property as any, true, {
      atMs: 100,
    });
    expect((next.elements.a as any).animation[property].x[0].p).toEqual([
      100,
      expected,
    ]);
  });

  it("seeds scale at 10, because scale is stored in tenths", () => {
    // `renderElement` divides by 10, so an unscaled element is 10 and not 1.
    const next = setTrackActive(inactive(), "a", "scale", true, { atMs: 0 });
    expect((next.elements.a as any).animation.scale.x[0].p).toEqual([0, 10]);
  });

  it("activates without seeding when no cursor is given", () => {
    const next = setTrackActive(inactive(), "a", "opacity", true);
    expect((next.elements.a as any).animation.opacity.isActivate).toBe(true);
    expect((next.elements.a as any).animation.opacity.x).toEqual([]);
  });

  it("does not re-seed a track that already has keyframes", () => {
    const off = doc({
      a: animated({
        opacity: { isActivate: false, x: keys([0, 0], [1000, 100]), ax: [] },
      }),
    });
    const next = setTrackActive(off, "a", "opacity", true, { atMs: 500 });
    expect(track(next)).toHaveLength(2);
  });

  it("keeps the keyframes when switched off", () => {
    // Re-enabling should restore the animation the user drew; deleting their
    // work is what the remove button is for.
    const next = setTrackActive(doc({ a: animated() }), "a", "opacity", false);
    expect((next.elements.a as any).animation.opacity.isActivate).toBe(false);
    expect(track(next)).toHaveLength(2);

    const back = setTrackActive(next, "a", "opacity", true, { atMs: 500 });
    expect(track(back)).toHaveLength(2);
  });
});

describe("immutability", () => {
  it("shares every untouched object with the input document", () => {
    // This is what keeps a keyframe edit out of the undo history: only the path
    // from the root to the changed lane is copied.
    const before = doc({ a: animated(), b: imageElement({ trackId: "v1" }) });
    const after = addKeyframe(before, "a", "opacity", "x", 500, 40);

    expect(after).not.toBe(before);
    expect(after.elements.b).toBe(before.elements.b);
    expect(after.tracks).toBe(before.tracks);
    expect((after.elements.a as any).animation.position).toBe(
      (before.elements.a as any).animation.position,
    );
    expect((after.elements.a as any).location).toBe(
      (before.elements.a as any).location,
    );
  });

  it("leaves the input document structurally unchanged", () => {
    const before = doc({ a: animated() });
    const snapshot = JSON.parse(JSON.stringify(before));
    addKeyframe(before, "a", "opacity", "x", 500, 40);
    removeKeyframe(before, "a", "opacity", "x", 0);
    setTrackActive(before, "a", "position", true, { atMs: 0 });
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });
});

describe("normalizeAnimations", () => {
  it("repairs the legacy [[], []] baked shape across the document", () => {
    const base = imageElement();
    const legacy = doc({
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(base.animation as any),
          position: {
            isActivate: false,
            x: [],
            y: [],
            ax: [[], []],
            ay: [[], []],
          },
        } as any,
      }),
    });

    const out = normalizeAnimations(legacy);
    expect(out).not.toBe(legacy);
    expect((out.elements.a as any).animation.position.ax).toEqual([]);
    expect((out.elements.a as any).animation.position.ay).toEqual([]);
  });

  it("returns a clean document by identity", () => {
    const clean = doc({ a: imageElement({ trackId: "v1" }) });
    expect(normalizeAnimations(clean)).toBe(clean);
  });

  it("leaves elements without animation blocks alone", () => {
    const mixed = doc({
      a: audioElement({ trackId: "v1" }),
      b: gifElement({ trackId: "v1" }),
    });
    expect(normalizeAnimations(mixed)).toBe(mixed);
  });
});

describe("a heavily edited track stays coherent", () => {
  it("survives 500 mixed operations", () => {
    // The "used hard" case: adds, moves, removes and toggles interleaved, with
    // the bake checked against the authored list after every single step.
    let d = doc({ a: animated({ opacity: { isActivate: true, x: [], ax: [] } }) });

    for (let i = 0; i < 500; i++) {
      const phase = i % 5;
      if (phase === 0 || phase === 1) {
        d = addKeyframe(d, "a", "opacity", "x", (i * 37) % 4000, i % 100);
      } else if (phase === 2 && track(d).length > 0) {
        d = moveKeyframe(d, "a", "opacity", "x", 0, (i * 91) % 4000, i % 100).doc;
      } else if (phase === 3 && track(d).length > 0) {
        d = removeKeyframe(d, "a", "opacity", "x", track(d).length - 1);
      } else {
        d = setTrackActive(d, "a", "opacity", i % 2 === 0);
      }

      const list = track(d);
      // Sorted, unique, and baked to match — after every operation.
      for (let k = 1; k < list.length; k++) {
        expect(list[k].p[0]).toBeGreaterThan(list[k - 1].p[0]);
      }
      expect(baked(d)).toEqual(bakeTrack(list));
    }

    expect(sampleBaked(baked(d), 0, -1)).not.toBeNaN();
  });
});
