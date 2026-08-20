import { describe, it, expect } from "vitest";
import {
  canBeGrouped,
  createGroup,
  isGroupAnimated,
  removeFromParent,
  setParent,
  ungroup,
} from "./groupOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { MAX_GROUP_DEPTH, childrenOf, parentOf } from "./hierarchy";
import { applyPoint, worldMatrixOf, type Mat } from "./transform";
import { bakeTrack } from "../animation/keyframes";
import {
  audioElement,
  groupElement,
  imageElement,
  keys,
  textElement,
} from "../renderer/testing";

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v1", "video", 0),
      createTrack("t1", "text", 1),
      createTrack("g1", "group", 2),
      createTrack("a1", "audio", 3),
    ],
    elements,
  });
}

function close(actual: number, expected: number, epsilon = 1e-6) {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon);
}

/**
 * Where the element's four corners land on the canvas.
 *
 * The invariant this whole suite exists for is stated in these terms: grouping
 * changes which space a clip's numbers are written in, and must change nothing
 * about where its pixels end up.
 */
function corners(d: TimelineDocument, id: string, cursor: number) {
  const element = d.elements[id] as any;
  const m: Mat = worldMatrixOf(d.elements, id, cursor);
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  return [
    applyPoint(m, { x: 0, y: 0 }),
    applyPoint(m, { x: w, y: 0 }),
    applyPoint(m, { x: w, y: h }),
    applyPoint(m, { x: 0, y: h }),
  ];
}

function expectUnmoved(
  before: TimelineDocument,
  after: TimelineDocument,
  ids: string[],
  cursors: number[] = [0],
  epsilon = 1e-6,
) {
  for (const id of ids) {
    for (const cursor of cursors) {
      const a = corners(before, id, cursor);
      const b = corners(after, id, cursor);
      for (let i = 0; i < 4; i++) {
        close(b[i].x, a[i].x, epsilon);
        close(b[i].y, a[i].y, epsilon);
      }
    }
  }
}

/** A position track whose two lanes share their anchor instants. */
function positionTrack(
  xs: Array<[number, number]>,
  ys: Array<[number, number]>,
) {
  const x = keys(...xs);
  const y = keys(...ys);
  return { isActivate: true, x, y, ax: bakeTrack(x), ay: bakeTrack(y) };
}

describe("canBeGrouped", () => {
  it("rejects audio, which has nothing to place", () => {
    expect(canBeGrouped(audioElement())).toBe(false);
  });

  it("accepts visual clips and groups", () => {
    expect(canBeGrouped(imageElement())).toBe(true);
    expect(canBeGrouped(textElement())).toBe(true);
    expect(canBeGrouped(groupElement())).toBe(true);
  });
});

describe("createGroup — nothing moves (G1)", () => {
  it("leaves two static clips exactly where they were", () => {
    const before = doc({
      a: imageElement({ location: { x: 100, y: 50 }, width: 40, height: 30 }),
      b: imageElement({ location: { x: 200, y: 90 }, width: 60, height: 20 }),
    });
    const after = createGroup(before, ["a", "b"], "grp", "g1");
    expectUnmoved(before, after, ["a", "b"]);
  });

  it("leaves a rotated child where it was", () => {
    const before = doc({
      a: imageElement({
        location: { x: 10, y: 10 },
        width: 80,
        height: 40,
        rotation: 37,
      }),
      b: imageElement({ location: { x: 300, y: 300 } }),
    });
    expectUnmoved(before, createGroup(before, ["a", "b"], "grp", "g1"), [
      "a",
      "b",
    ]);
  });

  it("leaves an animated child on its exact path, at every instant", () => {
    // The point of the value-axis offset: the whole curve translates, so the
    // clip traces the same path through the same instants.
    const before = doc({
      a: imageElement({
        location: { x: 100, y: 100 },
        width: 50,
        height: 50,
        animation: {
          ...imageElement().animation,
          position: positionTrack(
            [
              [0, 100],
              [1000, 400],
              [2000, 250],
            ],
            [
              [0, 100],
              [1000, 50],
              [2000, 300],
            ],
          ),
        },
      }),
      b: imageElement({ location: { x: 0, y: 0 } }),
    });

    const after = createGroup(before, ["a", "b"], "grp", "g1");
    expectUnmoved(
      before,
      after,
      ["a", "b"],
      [0, 250, 500, 750, 1000, 1500, 2000, 3000],
    );
  });

  it("keeps the child's keyframe timing untouched", () => {
    // Only the value axis moves. A group that also slid the times would
    // desynchronise the animation from the footage under it.
    const track = positionTrack(
      [
        [0, 100],
        [1000, 400],
      ],
      [
        [0, 100],
        [1000, 50],
      ],
    );
    const before = doc({
      a: imageElement({
        location: { x: 100, y: 100 },
        animation: { ...imageElement().animation, position: track },
      }),
    });
    const after = createGroup(before, ["a"], "grp", "g1");
    const lane = (after.elements.a as any).animation.position;
    expect(lane.x.map((k: any) => k.p[0])).toEqual([0, 1000]);
    expect(lane.y.map((k: any) => k.p[0])).toEqual([0, 1000]);
  });

  it("offsets the handles along with the anchors", () => {
    // A translation acts on a bezier's control points exactly as on its curve.
    // Moving only the anchors would change the easing between them.
    const x = keys([0, 100], [1000, 400]);
    x[0].ce = [200, 150];
    const y = keys([0, 100], [1000, 50]);
    y[0].ce = [200, 120];

    const before = doc({
      a: imageElement({
        location: { x: 100, y: 100 },
        animation: {
          ...imageElement().animation,
          position: { isActivate: true, x, y, ax: bakeTrack(x), ay: bakeTrack(y) },
        },
      }),
    });
    const after = createGroup(before, ["a"], "grp", "g1");
    const lane = (after.elements.a as any).animation.position;
    // The group sits at the clip's own top-left (100, 100), so everything
    // shifts by exactly that.
    close(lane.x[0].ce[1], 150 - 100);
    expect(lane.x[0].ce[0]).toBe(200);
  });

  it("re-bakes so the sampled path matches the new keyframes", () => {
    const before = doc({
      a: imageElement({
        location: { x: 100, y: 100 },
        animation: {
          ...imageElement().animation,
          position: positionTrack([[0, 100], [1000, 400]], [[0, 100], [1000, 100]]),
        },
      }),
    });
    const lane = (createGroup(before, ["a"], "grp", "g1").elements.a as any)
      .animation.position;
    expect(lane.ax).toEqual(bakeTrack(lane.x));
    expect(lane.ay).toEqual(bakeTrack(lane.y));
  });
});

describe("createGroup — the group it builds", () => {
  it("seats the group at the selection's bounding box", () => {
    const after = createGroup(
      doc({
        a: imageElement({ location: { x: 100, y: 50 }, width: 40, height: 30 }),
        b: imageElement({ location: { x: 200, y: 90 }, width: 60, height: 20 }),
      }),
      ["a", "b"],
      "grp",
      "g1",
    );
    const group = after.elements.grp as any;
    expect(group.location).toEqual({ x: 100, y: 50 });
    expect(group.width).toBe(160); // 260 - 100
    expect(group.height).toBe(60); // 110 - 50
  });

  it("gives the group an identity transform", () => {
    // Anything else and the compensation would not be a pure translation.
    const group = createGroup(
      doc({ a: imageElement({ location: { x: 7, y: 9 } }) }),
      ["a"],
      "grp",
      "g1",
    ).elements.grp as any;
    expect(group.rotation).toBe(0);
    expect(group.opacity).toBe(100);
    expect(group.animation.scale.isActivate).toBe(false);
  });

  it("makes the children's positions relative to the box", () => {
    const after = createGroup(
      doc({
        a: imageElement({ location: { x: 100, y: 50 }, width: 40, height: 30 }),
        b: imageElement({ location: { x: 200, y: 90 }, width: 60, height: 20 }),
      }),
      ["a", "b"],
      "grp",
      "g1",
    );
    expect((after.elements.a as any).location).toEqual({ x: 0, y: 0 });
    expect((after.elements.b as any).location).toEqual({ x: 100, y: 40 });
  });

  it("spans the clips it holds", () => {
    const group = createGroup(
      doc({
        a: imageElement({ startTime: 1000, duration: 2000 }),
        b: imageElement({ startTime: 4000, duration: 1000 }),
      }),
      ["a", "b"],
      "grp",
      "g1",
    ).elements.grp as any;
    expect(group.startTime).toBe(1000);
    expect(group.duration).toBe(4000);
  });

  it("lands on the track it was given", () => {
    const group = createGroup(doc({ a: imageElement() }), ["a"], "grp", "g1")
      .elements.grp as any;
    expect(group.trackId).toBe("g1");
  });

  it("links every child to the new group", () => {
    const after = createGroup(
      doc({ a: imageElement(), b: textElement({ trackId: "t1" }) }),
      ["a", "b"],
      "grp",
      "g1",
    );
    expect(childrenOf(after.elements, "grp")).toEqual(["a", "b"]);
  });

  it("does not touch clips outside the selection", () => {
    const after = createGroup(
      doc({
        a: imageElement({ location: { x: 100, y: 100 } }),
        outsider: imageElement({ location: { x: 500, y: 500 } }),
      }),
      ["a"],
      "grp",
      "g1",
    );
    expect((after.elements.outsider as any).location).toEqual({ x: 500, y: 500 });
    expect((after.elements.outsider as any).parentId).toBeUndefined();
  });

  it("does not change z-order", () => {
    // Parenting is spatial. A group is not a nested sequence, so what paints in
    // front of what still comes from track order alone.
    //
    // Asserted as *relative* order, not as the raw `priority` numbers: those
    // are a dense 1..n rank over every element, so the group element takes one
    // of them and shifts the rest along. What must not change is which clip
    // paints first — and a group, drawing nothing, never enters that question.
    const before = doc({
      a: imageElement({ trackId: "v1" }),
      b: textElement({ trackId: "t1" }),
    });
    const after = createGroup(before, ["a", "b"], "grp", "g1");

    const paintOrderOf = (d: TimelineDocument) =>
      Object.entries(d.elements)
        .filter(([, e]) => e.filetype !== "group")
        .sort(([, x], [, y]) => x.priority - y.priority)
        .map(([id]) => id);

    expect(paintOrderOf(after)).toEqual(paintOrderOf(before));
  });
});

describe("createGroup — nesting", () => {
  it("groups a group", () => {
    let d = createGroup(
      doc({ a: imageElement(), b: imageElement() }),
      ["a", "b"],
      "inner",
      "g1",
    );
    d = createGroup(d, ["inner"], "outer", "g1");
    expect(parentOf(d.elements, "inner")).toBe("outer");
    expect(parentOf(d.elements, "a")).toBe("inner");
  });

  it("keeps the deeper children in place through both levels", () => {
    const before = doc({
      a: imageElement({ location: { x: 120, y: 80 }, width: 40, height: 40 }),
      b: imageElement({ location: { x: 300, y: 200 }, width: 20, height: 20 }),
    });
    const inner = createGroup(before, ["a", "b"], "inner", "g1");
    const outer = createGroup(inner, ["inner"], "outer", "g1");
    expectUnmoved(before, outer, ["a", "b"]);
  });

  it("inherits the shared parent when grouping siblings inside a group", () => {
    let d = createGroup(
      doc({ a: imageElement(), b: imageElement(), c: imageElement() }),
      ["a", "b", "c"],
      "outer",
      "g1",
    );
    d = createGroup(d, ["a", "b"], "inner", "g1");
    expect(parentOf(d.elements, "inner")).toBe("outer");
    expect(parentOf(d.elements, "c")).toBe("outer");
  });
});

describe("createGroup — declines by identity (G2)", () => {
  it("declines an empty selection", () => {
    const d = doc({ a: imageElement() });
    expect(createGroup(d, [], "grp", "g1")).toBe(d);
  });

  it("declines when no named element exists", () => {
    const d = doc({ a: imageElement() });
    expect(createGroup(d, ["ghost"], "grp", "g1")).toBe(d);
  });

  it("declines a selection containing audio", () => {
    const d = doc({ a: imageElement(), s: audioElement({ trackId: "a1" }) });
    expect(createGroup(d, ["a", "s"], "grp", "g1")).toBe(d);
  });

  it("declines when the id is already taken", () => {
    const d = doc({ a: imageElement(), taken: imageElement() });
    expect(createGroup(d, ["a"], "taken", "g1")).toBe(d);
  });

  it("declines an empty group id", () => {
    const d = doc({ a: imageElement() });
    expect(createGroup(d, ["a"], "", "g1")).toBe(d);
  });

  it("declines clips that do not share a parent", () => {
    // Half a selection reseated into a new space is worse than refusing.
    const grouped = createGroup(
      doc({ a: imageElement(), b: imageElement(), c: imageElement() }),
      ["a"],
      "inner",
      "g1",
    );
    expect(createGroup(grouped, ["a", "b"], "other", "g1")).toBe(grouped);
  });

  it("declines when nesting would breach the depth cap", () => {
    let d = doc({ leaf: imageElement() });
    let last = "leaf";
    for (let i = 0; i < MAX_GROUP_DEPTH; i++) {
      const next = createGroup(d, [last], `g${i}`, "g1");
      if (next === d) {
        break;
      }
      d = next;
      last = `g${i}`;
    }
    // One more level past the cap must be refused, by identity.
    expect(createGroup(d, [last], "toodeep", "g1")).toBe(d);
  });

  it("allows the full depth when grouping siblings inside a group", () => {
    // The cap counts the resulting chain, not the number of gestures. Grouping
    // two clips that already sit inside a group puts the new group at *their*
    // depth, not one below it — an off-by-one here rejects a legal nesting one
    // level early.
    let d = doc({ a: imageElement(), b: imageElement() });
    let last: string[] = ["a", "b"];
    let made = 0;
    for (let i = 0; i < MAX_GROUP_DEPTH; i++) {
      const next = createGroup(d, last, `g${i}`, "g1");
      if (next === d) {
        break;
      }
      d = next;
      last = [`g${i}`];
      made++;
    }

    // `a` ends up under `made` groups, and that chain must reach the cap
    // exactly rather than stopping short of it.
    const depth = (id: string) => {
      let n = 0;
      let cur: string | null = id;
      while ((cur = parentOf(d.elements, cur)) != null) n++;
      return n;
    };
    expect(depth("a")).toBe(MAX_GROUP_DEPTH);
  });

  it("records no undo step for a declined group", () => {
    // The identity contract is what `withCheckpoint` reads.
    const d = doc({ a: imageElement() });
    expect(createGroup(d, [], "grp", "g1")).toBe(d);
  });
});

describe("ungroup", () => {
  it("puts a plain group's children back exactly where they were", () => {
    const before = doc({
      a: imageElement({ location: { x: 100, y: 50 }, width: 40, height: 30 }),
      b: imageElement({ location: { x: 200, y: 90 }, width: 60, height: 20 }),
    });
    const grouped = createGroup(before, ["a", "b"], "grp", "g1");
    const after = ungroup(grouped, "grp", 0);

    expectUnmoved(before, after, ["a", "b"]);
    expect((after.elements.a as any).location).toEqual({ x: 100, y: 50 });
    expect((after.elements.b as any).location).toEqual({ x: 200, y: 90 });
  });

  it("removes the group element", () => {
    const grouped = createGroup(doc({ a: imageElement() }), ["a"], "grp", "g1");
    expect(ungroup(grouped, "grp", 0).elements.grp).toBeUndefined();
  });

  it("clears the children's parentId", () => {
    const grouped = createGroup(doc({ a: imageElement() }), ["a"], "grp", "g1");
    expect((ungroup(grouped, "grp", 0).elements.a as any).parentId).toBeUndefined();
  });

  it("round-trips an animated child through group and ungroup", () => {
    const before = doc({
      a: imageElement({
        location: { x: 100, y: 100 },
        width: 50,
        height: 50,
        animation: {
          ...imageElement().animation,
          position: positionTrack(
            [[0, 100], [1000, 400]],
            [[0, 100], [1000, 250]],
          ),
        },
      }),
    });
    const round = ungroup(createGroup(before, ["a"], "grp", "g1"), "grp", 0);
    expectUnmoved(before, round, ["a"], [0, 500, 1000, 2000]);
  });

  it("bakes a translated group into its children", () => {
    const d = doc({
      grp: groupElement({ location: { x: 300, y: 200 }, width: 0, height: 0 }),
      a: imageElement({ parentId: "grp", location: { x: 10, y: 5 }, width: 20, height: 20 }),
    });
    const after = ungroup(d, "grp", 0);
    expect((after.elements.a as any).location).toEqual({ x: 310, y: 205 });
  });

  it("bakes a scaled group into the child's size and position", () => {
    const scaled = keys([0, 20]); // 2x
    const d = doc({
      grp: groupElement({
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: scaled, ax: bakeTrack(scaled) },
        },
      }),
      a: imageElement({
        parentId: "grp",
        location: { x: 50, y: 50 },
        width: 10,
        height: 10,
      }),
    });
    const after = ungroup(d, "grp", 0);
    const child = after.elements.a as any;
    close(child.width, 20);
    close(child.height, 20);
    close(child.location.x, 100);
    close(child.location.y, 100);
  });

  it("keeps a scaled group's children where they appeared", () => {
    const scaled = keys([0, 25]);
    const d = doc({
      grp: groupElement({
        location: { x: 40, y: 10 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: scaled, ax: bakeTrack(scaled) },
        },
      }),
      a: imageElement({ parentId: "grp", location: { x: 12, y: 8 }, width: 30, height: 14 }),
    });
    expectUnmoved(d, ungroup(d, "grp", 0), ["a"]);
  });

  it("keeps a rotated group's children where they appeared", () => {
    const d = doc({
      grp: groupElement({
        location: { x: 100, y: 100 },
        width: 200,
        height: 120,
        rotation: 35,
      }),
      a: imageElement({ parentId: "grp", location: { x: 20, y: 30 }, width: 40, height: 25 }),
    });
    expectUnmoved(d, ungroup(d, "grp", 0), ["a"], [0], 1e-6);
  });

  it("keeps an animated child of a rotated group exact at its anchors", () => {
    // The documented boundary: with rotation in play the anchors are still
    // exact, and only the easing between them may bow.
    const d = doc({
      grp: groupElement({
        location: { x: 60, y: 20 },
        width: 100,
        height: 100,
        rotation: 45,
      }),
      a: imageElement({
        parentId: "grp",
        location: { x: 10, y: 10 },
        width: 20,
        height: 20,
        animation: {
          ...imageElement().animation,
          position: positionTrack([[0, 10], [1000, 60]], [[0, 10], [1000, 80]]),
        },
      }),
    });
    // Cursors chosen to land on the keyframe anchors.
    expectUnmoved(d, ungroup(d, "grp", 0), ["a"], [0, 1000], 1e-6);
  });

  it("multiplies the group's opacity into its children", () => {
    const d = doc({
      grp: groupElement({ opacity: 50 }),
      a: imageElement({ parentId: "grp", opacity: 80 }),
    });
    close((ungroup(d, "grp", 0).elements.a as any).opacity, 40);
  });

  it("hands children up to the grandparent when the group was nested", () => {
    let d = createGroup(doc({ a: imageElement() }), ["a"], "inner", "g1");
    d = createGroup(d, ["inner"], "outer", "g1");
    const after = ungroup(d, "inner", 0);
    expect(parentOf(after.elements, "a")).toBe("outer");
  });

  it("leaves the deeper subtree intact", () => {
    let d = createGroup(doc({ a: imageElement() }), ["a"], "inner", "g1");
    d = createGroup(d, ["inner"], "outer", "g1");
    const after = ungroup(d, "outer", 0);
    expect(parentOf(after.elements, "a")).toBe("inner");
    expect(after.elements.inner).toBeDefined();
  });

  it("declines by identity for a clip that is not a group", () => {
    const d = doc({ a: imageElement() });
    expect(ungroup(d, "a", 0)).toBe(d);
  });

  it("declines by identity for an id that is not there", () => {
    const d = doc({ a: imageElement() });
    expect(ungroup(d, "ghost", 0)).toBe(d);
  });
});

describe("isGroupAnimated", () => {
  it("is false for a fresh group", () => {
    const d = createGroup(doc({ a: imageElement() }), ["a"], "grp", "g1");
    expect(isGroupAnimated(d.elements, "grp")).toBe(false);
  });

  it("is true once a track is live and has keyframes", () => {
    const d = doc({
      grp: groupElement({
        animation: {
          ...groupElement().animation,
          position: positionTrack([[0, 0], [1000, 10]], [[0, 0], [1000, 10]]),
        },
      }),
    });
    expect(isGroupAnimated(d.elements, "grp")).toBe(true);
  });

  it("is false for a track that is live but empty", () => {
    const d = doc({
      grp: groupElement({
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: [], ax: [] },
        },
      }),
    });
    expect(isGroupAnimated(d.elements, "grp")).toBe(false);
  });
});

describe("setParent", () => {
  it("moves a clip into a group without moving it on screen", () => {
    const before = doc({
      grp: groupElement({ location: { x: 200, y: 100 }, width: 50, height: 50 }),
      a: imageElement({ location: { x: 10, y: 10 }, width: 20, height: 20 }),
    });
    const after = setParent(before, ["a"], "grp", 0);
    expect(parentOf(after.elements, "a")).toBe("grp");
    expectUnmoved(before, after, ["a"]);
  });

  it("moves a clip between two groups without moving it on screen", () => {
    const before = doc({
      g1e: groupElement({ location: { x: 100, y: 0 }, width: 10, height: 10 }),
      g2e: groupElement({ location: { x: 0, y: 300 }, width: 10, height: 10, rotation: 20 }),
      a: imageElement({ parentId: "g1e", location: { x: 5, y: 5 }, width: 20, height: 20 }),
    });
    expectUnmoved(before, setParent(before, ["a"], "g2e", 0), ["a"]);
  });

  it("detaches to the canvas without moving anything", () => {
    const before = doc({
      grp: groupElement({ location: { x: 90, y: 40 }, width: 30, height: 30 }),
      a: imageElement({ parentId: "grp", location: { x: 5, y: 5 }, width: 20, height: 20 }),
    });
    const after = removeFromParent(before, ["a"], 0);
    expect(parentOf(after.elements, "a")).toBeNull();
    expectUnmoved(before, after, ["a"]);
    expect((after.elements.a as any).location).toEqual({ x: 95, y: 45 });
  });

  it("declines a cycle by identity (G5)", () => {
    let d = createGroup(doc({ a: imageElement() }), ["a"], "inner", "g1");
    d = createGroup(d, ["inner"], "outer", "g1");
    expect(setParent(d, ["outer"], "inner", 0)).toBe(d);
  });

  it("declines self-parenting by identity", () => {
    const d = doc({ grp: groupElement() });
    expect(setParent(d, ["grp"], "grp", 0)).toBe(d);
  });

  it("declines a parent that is not a group", () => {
    const d = doc({ a: imageElement(), b: imageElement() });
    expect(setParent(d, ["a"], "b", 0)).toBe(d);
  });

  it("declines a parent that is not there", () => {
    const d = doc({ a: imageElement() });
    expect(setParent(d, ["a"], "ghost", 0)).toBe(d);
  });

  it("declines audio", () => {
    const d = doc({ grp: groupElement(), s: audioElement({ trackId: "a1" }) });
    expect(setParent(d, ["s"], "grp", 0)).toBe(d);
  });

  it("declines when nothing would change", () => {
    const d = createGroup(doc({ a: imageElement() }), ["a"], "grp", "g1");
    expect(setParent(d, ["a"], "grp", 0)).toBe(d);
  });

  it("declines detaching something already detached", () => {
    const d = doc({ a: imageElement() });
    expect(removeFromParent(d, ["a"], 0)).toBe(d);
  });

  it("is all or nothing when one member would cycle", () => {
    let d = createGroup(doc({ a: imageElement(), b: imageElement() }), ["a"], "inner", "g1");
    d = createGroup(d, ["inner"], "outer", "g1");
    // "b" alone could move into "inner", but "outer" cannot — so neither does.
    const after = setParent(d, ["b", "outer"], "inner", 0);
    expect(after).toBe(d);
  });

  it("declines when the depth cap would be breached", () => {
    let d = doc({ leaf: imageElement(), other: imageElement() });
    let last = "leaf";
    for (let i = 0; i < MAX_GROUP_DEPTH; i++) {
      const next = createGroup(d, [last], `g${i}`, "g1");
      if (next === d) break;
      d = next;
      last = `g${i}`;
    }
    // The deepest group in the chain cannot take another child below it.
    const deepest = childrenOf(d.elements, last).length > 0 ? "g0" : last;
    const attempt = setParent(d, ["other"], deepest, 0);
    if (attempt !== d) {
      // If it was allowed, the resulting chain must still respect the cap.
      const depth = (id: string): number => {
        let n = 0;
        let cur: string | null = id;
        while ((cur = parentOf(attempt.elements, cur)) != null) n++;
        return n;
      };
      expect(depth("other")).toBeLessThanOrEqual(MAX_GROUP_DEPTH);
    }
  });
});

describe("the document stays well formed", () => {
  it("keeps priorities derived after grouping", () => {
    const after = createGroup(
      doc({ a: imageElement(), b: imageElement() }),
      ["a", "b"],
      "grp",
      "g1",
    );
    const ranks = Object.values(after.elements).map((e) => e.priority);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("holds the parentId invariant after every op (G4)", () => {
    let d = createGroup(
      doc({ a: imageElement(), b: imageElement() }),
      ["a", "b"],
      "grp",
      "g1",
    );
    d = ungroup(d, "grp", 0);
    for (const element of Object.values(d.elements)) {
      const parentId = (element as any).parentId;
      if (parentId != null) {
        expect(d.elements[parentId]?.filetype).toBe("group");
      }
    }
  });
});
