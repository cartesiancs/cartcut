import { describe, it, expect } from "vitest";
import {
  addKeyframe,
  addKeyframePaired,
  moveKeyframe,
  moveKeyframePaired,
  normalizeAnimations,
  removeKeyframe,
  removeKeyframePaired,
  rebakeAnimations,
  setHandles,
  setTrackActive,
} from "./keyframeOps";
import { BAKE_HZ, bakeRateFor, bakeTrack, sampleBaked } from "./keyframes";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  audioElement,
  effectElement,
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
    // An effect's type carries `opacity` alone — it covers the whole frame, so
    // a scale keyframe would create a track the renderer never reads. This
    // used to be asserted of a shape, which now animates all four.
    const effects = doc({ a: effectElement({ trackId: "v1" }) });
    expect(addKeyframe(effects, "a", "scale", "x", 0, 1)).toBe(effects);
    expect(addKeyframe(effects, "a", "position", "x", 0, 1)).toBe(effects);
    expect(setTrackActive(effects, "a", "rotation", true)).toBe(effects);
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

  it("seeds size from the element's own box, both lanes", () => {
    // Pixels, and the same numbers the sidebar's Size row shows — `size` is
    // the width and height fields animated, not a second scale. Seeding from
    // them is what stops the clip resizing itself the moment the stopwatch is
    // clicked.
    const sized = doc({
      a: imageElement({ trackId: "v1", width: 320, height: 180 }),
    });
    const next = setTrackActive(sized, "a", "size", true, { atMs: 250 });
    const animation = (next.elements.a as any).animation.size;
    expect(animation.isActivate).toBe(true);
    expect(animation.x[0].p).toEqual([250, 320]);
    expect(animation.y[0].p).toEqual([250, 180]);
    expect(animation.ax).toEqual([[250, 320]]);
    expect(animation.ay).toEqual([[250, 180]]);
  });

  it("declines size where there is no box to resize", () => {
    // An effect covers the whole frame, and gif and audio carry no animation
    // block at all. Identity, so no undo step is recorded either.
    const effects = doc({ a: effectElement({ trackId: "v1" }) });
    expect(setTrackActive(effects, "a", "size" as any, true)).toBe(effects);
    expect(addKeyframe(effects, "a", "size" as any, "x", 0, 100)).toBe(effects);

    for (const element of [gifElement(), audioElement()]) {
      const d = doc({ a: { ...element, trackId: "v1" } });
      expect(setTrackActive(d, "a", "size" as any, true)).toBe(d);
      expect(addKeyframe(d, "a", "size" as any, "x", 0, 100)).toBe(d);
    }
  });

  it("seeds scale at 10, because scale is stored in tenths", () => {
    // `renderElement` divides by 10, so an unscaled element is 10 and not 1.
    const next = setTrackActive(inactive(), "a", "scale", true, { atMs: 0 });
    expect((next.elements.a as any).animation.scale.x[0].p).toEqual([0, 10]);
  });

  /**
   * A shape takes exactly the same path as an image now that its type carries
   * the four-track block. This is the gate, not the draw: `localMatrixOf` was
   * always generic and would have animated a shape given the data — what used
   * to be missing was any way to *produce* that data. `setTrackActive` returned
   * the document by identity, so the panel's Position and Rotation stopwatch
   * buttons clicked and did nothing at all.
   */
  it("seeds a shape's position and rotation from its static fields", () => {
    const shapes = doc({
      a: shapeElement({
        trackId: "v1",
        location: { x: 12, y: 34 },
        rotation: 90,
      }),
    });

    const moved = setTrackActive(shapes, "a", "position", true, { atMs: 500 });
    expect(moved).not.toBe(shapes);
    const position = (moved.elements.a as any).animation.position;
    expect(position.isActivate).toBe(true);
    expect(position.x[0].p).toEqual([500, 12]);
    expect(position.y[0].p).toEqual([500, 34]);

    const spun = setTrackActive(shapes, "a", "rotation", true, { atMs: 500 });
    expect(spun).not.toBe(shapes);
    const rotation = (spun.elements.a as any).animation.rotation;
    expect(rotation.isActivate).toBe(true);
    expect(rotation.x[0].p).toEqual([500, 90]);
  });

  it("activates without seeding when no cursor is given", () => {
    const next = setTrackActive(inactive(), "a", "opacity", true);
    expect((next.elements.a as any).animation.opacity.isActivate).toBe(true);
    expect((next.elements.a as any).animation.opacity.x).toEqual([]);
  });

  it("moves a shape on the canvas, from the ops the panel actually calls", () => {
    // The whole feature end to end: enable the track, add the second keyframe,
    // and check the pixels — the same two calls the Position stopwatch and a
    // preview drag make. Asserted through `renderElement` because the transform
    // lives in `localMatrixOf`, not in `renderShape`.
    const base = doc({
      a: shapeElement({
        trackId: "v1",
        width: 40,
        height: 40,
        oWidth: 40,
        oHeight: 40,
        location: { x: 0, y: 0 },
        shape: points([0, 0], [40, 0], [40, 40], [0, 40]),
        option: { fillColor: "#ff0000" },
      }),
    });

    const enabled = setTrackActive(base, "a", "position", true, { atMs: 0 });
    const withEnd = addKeyframePaired(
      addKeyframePaired(enabled, "a", "position", "x", 1000, 100),
      "a",
      "position",
      "y",
      1000,
      100,
    );

    const draw = (cursor: number) => {
      const { canvas, ctx } = scene(200, 200, "#000000");
      renderElement(ctx, "a", withEnd.elements.a as any, cursor, false, (c) => {
        c.fillStyle = "#ff0000";
        c.fillRect(0, 0, 40, 40);
      });
      return canvas;
    };

    expect(pixel(draw(0), 20, 20).r).toBeGreaterThan(200);
    expect(pixel(draw(0), 120, 120).r).toBeLessThan(50);

    expect(pixel(draw(1000), 120, 120).r).toBeGreaterThan(200);
    expect(pixel(draw(1000), 20, 20).r).toBeLessThan(50);
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

// ================================================== paired lanes (position)

/**
 * An image whose `position` track is animated on both lanes.
 *
 * The two lanes carry keyframes at the same instants, which is what every
 * producer in the app already writes and what the paired ops maintain.
 */
function positioned(over: Record<string, any> = {}) {
  const base = imageElement();
  return imageElement({
    trackId: "v1",
    location: { x: 7, y: 9 },
    animation: {
      ...(base.animation as any),
      position: {
        isActivate: true,
        x: keys([0, 0], [1000, 100]),
        ax: bakeTrack(keys([0, 0], [1000, 100])),
        y: keys([0, 200], [1000, 400]),
        ay: bakeTrack(keys([0, 200], [1000, 400])),
        ...over,
      },
    } as any,
  });
}

/** The instants at which a lane carries a keyframe. */
const times = (d: TimelineDocument, lane: "x" | "y") =>
  track(d, "position", lane).map((k: any) => k.p[0]);

describe("paired lanes", () => {
  const base = doc({ a: positioned() });

  // The bug this exists for: the curve editor edited whichever lane its x/y
  // buttons had selected, so dragging a position dot along the time axis moved
  // the x keyframe and left the y keyframe behind. Every other producer writes
  // the pair together, so the element then traced a path nobody drew.
  it("keeps the two lanes at the same instants through a time drag", () => {
    const moved = moveKeyframePaired(base, "a", "position", "x", 1, 600, 100);
    expect(times(moved.doc, "x")).toEqual([0, 600]);
    expect(times(moved.doc, "y")).toEqual([0, 600]);
  });

  it("moves only the edited lane's value", () => {
    const moved = moveKeyframePaired(base, "a", "position", "x", 1, 600, 55);
    expect(track(moved.doc, "position", "x")[1].p[1]).toBe(55);
    // The sibling kept its own value: the drag said something about x's curve.
    expect(track(moved.doc, "position", "y")[1].p[1]).toBe(400);
  });

  it("plants a matching keyframe on the sibling lane when one is added", () => {
    const added = addKeyframePaired(base, "a", "position", "x", 500, 42);
    expect(times(added, "x")).toEqual([0, 500, 1000]);
    expect(times(added, "y")).toEqual([0, 500, 1000]);
  });

  // Seeding the sibling from the static `location` — all there was to go on
  // before — would yank the other axis to wherever the element started. The
  // sibling has to gain a point *on the curve it already has*.
  it("leaves the sibling curve's shape alone when adding", () => {
    const before = baked(base, "position", "ay");
    const added = addKeyframePaired(base, "a", "position", "x", 500, 42);
    const after = baked(added, "position", "ay");

    for (const t of [0, 125, 250, 500, 750, 1000]) {
      expect(sampleBaked(after, t, NaN)).toBeCloseTo(
        sampleBaked(before, t, NaN),
        6,
      );
    }
  });

  it("takes the sibling with it when a keyframe is removed", () => {
    const gone = removeKeyframePaired(base, "a", "position", "x", 1);
    expect(times(gone, "x")).toEqual([0]);
    expect(times(gone, "y")).toEqual([0]);
  });

  it.each([
    ["adding", (d: TimelineDocument) =>
      addKeyframePaired(d, "a", "position", "y", 400, 1)],
    ["moving", (d: TimelineDocument) =>
      moveKeyframePaired(d, "a", "position", "y", 1, 700, 1).doc],
    ["removing", (d: TimelineDocument) =>
      removeKeyframePaired(d, "a", "position", "y", 0)],
  ])("keeps the lanes in step when %s from the y side", (_name, op) => {
    const out = (op as (d: TimelineDocument) => TimelineDocument)(base);
    expect(times(out, "x")).toEqual(times(out, "y"));
  });

  it("re-bakes both lanes", () => {
    const moved = moveKeyframePaired(base, "a", "position", "x", 1, 600, 100);
    for (const key of ["ax", "ay"] as const) {
      const b = baked(moved.doc, "position", key);
      expect(b[b.length - 1][0]).toBe(600);
    }
  });

  // Refusing outright is what `moveKeyframe` already does when a drag would
  // land on top of another keyframe. Letting the primary move while the
  // sibling stayed put is precisely the desync being prevented.
  it("declines the whole gesture when the sibling cannot follow", () => {
    const lopsided = doc({
      a: positioned({
        y: keys([0, 200], [500, 300], [1000, 400]),
        ay: bakeTrack(keys([0, 200], [500, 300], [1000, 400])),
      }),
    });
    const out = moveKeyframePaired(lopsided, "a", "position", "x", 1, 500, 5);
    expect(out.doc).toBe(lopsided);
  });

  // A project authored before pairing can have a keyframe on one lane with no
  // partner. Moving the one that exists beats refusing the drag with no
  // explanation.
  it("moves alone when the sibling has no keyframe at that instant", () => {
    const lopsided = doc({
      a: positioned({ y: keys([0, 200]), ay: bakeTrack(keys([0, 200])) }),
    });
    const out = moveKeyframePaired(lopsided, "a", "position", "x", 1, 600, 5);
    expect(times(out.doc, "x")).toEqual([0, 600]);
    expect(times(out.doc, "y")).toEqual([0]);
  });

  it.each([
    ["add", (d: TimelineDocument) =>
      addKeyframePaired(d, "a", "opacity", "x", 500, 50)],
    ["move", (d: TimelineDocument) =>
      moveKeyframePaired(d, "a", "opacity", "x", 1, 600, 50).doc],
    ["remove", (d: TimelineDocument) =>
      removeKeyframePaired(d, "a", "opacity", "x", 1)],
  ])("degrades to a single lane for a scalar property on %s", (_name, op) => {
    const scalars = doc({ a: animated() });
    const out = (op as (d: TimelineDocument) => TimelineDocument)(scalars);
    expect(out).not.toBe(scalars);
    expect((out.elements.a as any).animation.opacity.y).toBeUndefined();
  });

  it.each([
    ["add", (d: TimelineDocument) =>
      addKeyframePaired(d, "nope", "position", "x", 500, 50)],
    ["move", (d: TimelineDocument) =>
      moveKeyframePaired(d, "nope", "position", "x", 1, 600, 50).doc],
    ["remove", (d: TimelineDocument) =>
      removeKeyframePaired(d, "nope", "position", "x", 1)],
  ])("declines an unknown element by identity on %s", (_name, op) => {
    expect((op as (d: TimelineDocument) => TimelineDocument)(base)).toBe(base);
  });

  it.each([-1, 5, 99])(
    "declines an out-of-range index %s by identity",
    (index) => {
      expect(
        moveKeyframePaired(base, "a", "position", "x", index, 600, 50).doc,
      ).toBe(base);
      expect(removeKeyframePaired(base, "a", "position", "x", index)).toBe(base);
    },
  );

  it("shares the elements it did not touch", () => {
    const two = doc({ a: positioned(), b: imageElement({ trackId: "v1" }) });
    const out = addKeyframePaired(two, "a", "position", "x", 500, 42);
    expect(out.elements.b).toBe(two.elements.b);
  });
});

/**
 * The bake rate reaches these ops as a trailing argument with a default, the
 * same shape `addKeyframe`'s `handleMs` already had. The default is what makes
 * this safe: every existing caller and every existing test keeps the behaviour
 * it had, and only a caller that knows the project's frame rate asks for
 * something else.
 */
describe("bakeHz", () => {
  const base = doc({ a: animated() });

  it("bakes at 60Hz when nobody says otherwise", () => {
    const next = addKeyframe(base, "a", "opacity", "x", 500, 50);
    expect(baked(next)).toEqual(bakeTrack(track(next), BAKE_HZ));
  });

  it("is bit-identical to the same edit before the parameter existed", () => {
    // The regression guard. Anything that moved here would move every golden
    // snapshot and every `.ngt` already on disk.
    const explicit = addKeyframe(base, "a", "opacity", "x", 500, 50, 100, 60);
    const implicit = addKeyframe(base, "a", "opacity", "x", 500, 50);
    expect(explicit).toEqual(implicit);
  });

  it("is honoured by every op that writes a bake", () => {
    const added = addKeyframe(base, "a", "opacity", "x", 500, 50, 100, 120);
    expect(baked(added)).toEqual(bakeTrack(track(added), 120));

    const moved = moveKeyframe(added, "a", "opacity", "x", 1, 400, 50, 120).doc;
    expect(baked(moved)).toEqual(bakeTrack(track(moved), 120));

    const handled = setHandles(
      moved,
      "a",
      "opacity",
      "x",
      1,
      { cs: [350, 40] },
      120,
    );
    expect(baked(handled)).toEqual(bakeTrack(track(handled), 120));

    const removed = removeKeyframe(handled, "a", "opacity", "x", 1, 120);
    expect(baked(removed)).toEqual(bakeTrack(track(removed), 120));
  });

  it("reaches the seeded track when animation is switched on", () => {
    const off = doc({
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(imageElement().animation as any),
          opacity: { isActivate: false, x: [], ax: [] },
        } as any,
      }),
    });
    const on = setTrackActive(off, "a", "opacity", true, { atMs: 0 }, 120);
    expect(baked(on)).toEqual(bakeTrack(track(on), 120));
  });

  it("reaches both lanes of a paired add", () => {
    const paired = doc({
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(imageElement().animation as any),
          position: {
            isActivate: true,
            x: keys([0, 0], [1000, 100]),
            ax: points([0, 0], [1000, 100]),
            y: keys([0, 0], [1000, 200]),
            ay: points([0, 0], [1000, 200]),
          },
        } as any,
      }),
    });
    const next = addKeyframePaired(
      paired,
      "a",
      "position",
      "x",
      500,
      50,
      100,
      120,
    );
    expect(baked(next, "position", "ax")).toEqual(
      bakeTrack(track(next, "position", "x"), 120),
    );
    expect(baked(next, "position", "ay")).toEqual(
      bakeTrack(track(next, "position", "y"), 120),
    );
  });
});

/**
 * Changing a project's frame rate has to re-derive the caches without touching
 * anything the user drew — and has to cost nothing when there is nothing to do,
 * because it runs through `withCheckpoint` and a spurious undo step for a
 * settings change is worse than no rebake at all.
 */
describe("rebakeAnimations", () => {
  it("declines a document with no animation at all", () => {
    const plain = doc({ a: audioElement({ trackId: "v1" }) });
    expect(rebakeAnimations(plain, 120)).toBe(plain);
  });

  it("declines when the bakes already hold this rate", () => {
    // `points(...)` builds a hand-written sample list rather than a real bake,
    // so the fixture has to be settled at 60Hz before "already at this rate"
    // means anything.
    const at60 = rebakeAnimations(doc({ a: animated() }), BAKE_HZ);
    expect(rebakeAnimations(at60, BAKE_HZ)).toBe(at60);

    const at120 = rebakeAnimations(at60, 120);
    expect(at120).not.toBe(at60);
    expect(rebakeAnimations(at120, 120)).toBe(at120);
  });

  it("settles a hand-written bake onto the real grid", () => {
    // Which is also what ingress does for a `.ngt` written by an older build.
    const base = doc({ a: animated() });
    expect(rebakeAnimations(base, BAKE_HZ)).not.toBe(base);
    expect(baked(rebakeAnimations(base, BAKE_HZ))).toEqual(
      bakeTrack(track(base), BAKE_HZ),
    );
  });

  it("rewrites the baked lane when the rate changes", () => {
    const at60 = rebakeAnimations(doc({ a: animated() }), BAKE_HZ);
    const at120 = rebakeAnimations(at60, 120);
    expect(baked(at120)).toEqual(bakeTrack(track(at60), 120));
    expect(baked(at120).length).toBeGreaterThan(baked(at60).length);
  });

  it("leaves the authored keyframes exactly where they were", () => {
    // The claim that makes a rate change non-destructive: `x` and `y` are the
    // user's work, `ax` and `ay` are a cache of it.
    const base = doc({ a: animated() });
    const next = rebakeAnimations(base, 120);
    expect(track(next)).toBe(track(base));
  });

  it("rebakes both lanes of a paired track", () => {
    const base = doc({
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(imageElement().animation as any),
          position: {
            isActivate: true,
            x: keys([0, 0], [1000, 100]),
            ax: points([0, 0], [1000, 100]),
            y: keys([0, 0], [1000, 200]),
            ay: points([0, 0], [1000, 200]),
          },
        } as any,
      }),
    });
    const next = rebakeAnimations(base, 120);
    expect(baked(next, "position", "ax")).toEqual(
      bakeTrack(track(next, "position", "x"), 120),
    );
    expect(baked(next, "position", "ay")).toEqual(
      bakeTrack(track(next, "position", "y"), 120),
    );
  });

  it("survives a legacy track carrying only its x lane", () => {
    // `lanesOf` describes the type; a project authored before pairing existed
    // is what decides whether `y` is actually there.
    const base = doc({
      a: imageElement({
        trackId: "v1",
        animation: {
          ...(imageElement().animation as any),
          position: {
            isActivate: true,
            x: keys([0, 0], [1000, 100]),
            ax: points([0, 0], [1000, 100]),
          },
        } as any,
      }),
    });
    const next = rebakeAnimations(base, 120);
    expect(baked(next, "position", "ax")).toEqual(
      bakeTrack(track(next, "position", "x"), 120),
    );
    expect((next.elements.a as any).animation.position.y).toBeUndefined();
  });

  it("touches only the elements that carry animation", () => {
    const base = doc({
      a: animated(),
      b: audioElement({ trackId: "v1" }),
      c: shapeElement({ trackId: "v1" }),
    });
    const next = rebakeAnimations(base, 120);
    expect(next.elements.b).toBe(base.elements.b);
    expect(next.elements.c).toBe(base.elements.c);
    expect(next.elements.a).not.toBe(base.elements.a);
  });

  it("keeps the tracks and the schema version", () => {
    const base = doc({ a: animated() });
    const next = rebakeAnimations(base, 120);
    expect(next.tracks).toBe(base.tracks);
    expect(next.schemaVersion).toBe(base.schemaVersion);
  });

  it("reads the same values at the rates the old bake could express", () => {
    // A finer cache must not move what a 60fps project already saw: every
    // instant the 60Hz grid carried is still carried, with the same value.
    const at60 = rebakeAnimations(doc({ a: animated() }), BAKE_HZ);
    const at120 = rebakeAnimations(at60, 120);
    for (let frame = 0; frame <= 60; frame++) {
      const t = (frame / 60) * 1000;
      expect(sampleBaked(baked(at120), t, NaN)).toBeCloseTo(
        sampleBaked(baked(at60), t, NaN),
        9,
      );
    }
  });

  it("is a no-op for every rate under the bake floor", () => {
    // The floor is what keeps a 24fps project from paying for a rate change it
    // cannot see: 24, 30 and 60 all bake at 60Hz, so switching between them
    // records no undo step at all.
    const at60 = rebakeAnimations(doc({ a: animated() }), BAKE_HZ);
    for (const fps of [1, 24, 25, 30, 50, 60]) {
      expect(rebakeAnimations(at60, bakeRateFor(fps))).toBe(at60);
    }
    expect(rebakeAnimations(at60, bakeRateFor(120))).not.toBe(at60);
  });
});
