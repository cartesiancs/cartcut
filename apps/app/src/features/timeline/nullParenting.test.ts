/**
 * The null object, end to end.
 *
 * Everything here is a claim about the *feature* rather than about one module,
 * so it deliberately drives the shipping pieces together — the factory, the
 * placement, `setParent`, and the matrix chain the renderer reads — instead of
 * standing any of them in.
 *
 * ## The one distinction that matters
 *
 * "Parenting does not touch the child's keyframes" is true and false depending
 * on which moment you mean, and conflating the two is the way to misunderstand
 * this whole feature:
 *
 *   - **At the instant of parenting**, `setParent` rewrites the child's numbers
 *     once, by the change of basis between its old space and its new one. That
 *     is what keeps the picture still while the space underneath it changes,
 *     and it is what After Effects' pick-whip does too.
 *   - **Every moment after that**, moving the null changes nothing on the child
 *     at all. The parent's matrix is composed at draw time by
 *     `worldMatrixOf`/`applyParentTransform`, so the child's curves are read,
 *     never written.
 *
 * The first two suites below pin exactly that pair, in that order.
 */

import { describe, it, expect } from "vitest";
import { createNullElement } from "../element/nullElement";
import { setParent } from "./groupOps";
import { placeNewElement } from "./placement";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { parentOf } from "./hierarchy";
import { applyPoint, worldMatrixOf } from "./transform";
import { bakeTrack } from "../animation/keyframes";
import { keys, textElement } from "../renderer/testing";

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t1", "text", 0), createTrack("v1", "video", 1)],
    elements,
  });
}

/**
 * A text clip that moves from (100, 100) to (500, 300) over two seconds.
 *
 * Authored *and* baked, because the two are read by different halves of the
 * app: the curve editor and every op read `x`/`y`, the renderer reads `ax`/`ay`.
 * A test that set only one would pass while the picture was wrong.
 */
function movingText(over: Record<string, any> = {}) {
  const x = keys([0, 100], [1000, 300], [2000, 500]);
  const y = keys([0, 100], [1000, 200], [2000, 300]);
  return textElement({
    trackId: "t1",
    location: { x: 100, y: 100 },
    width: 200,
    height: 60,
    animation: {
      ...(textElement().animation as any),
      position: { isActivate: true, x, y, ax: bakeTrack(x), ay: bakeTrack(y) },
    },
    ...over,
  } as any);
}

/** Add a null spanning the whole timeline, centred on a 1920×1080 frame. */
function withNull(base: TimelineDocument, id = "null1") {
  return placeNewElement(
    base,
    id,
    createNullElement({ center: { x: 960, y: 540 }, duration: 10_000 }),
    0,
    "g-new",
  );
}

/** Where the child's origin lands on the canvas at `cursor`. */
function screenPoint(d: TimelineDocument, id: string, cursor: number) {
  return applyPoint(worldMatrixOf(d.elements, id, cursor), { x: 0, y: 0 });
}

/** Move a null by editing its static location, the way dragging it does. */
function moveNull(d: TimelineDocument, id: string, dx: number, dy: number) {
  const element = d.elements[id] as any;
  return normalizeDocument({
    ...d,
    elements: {
      ...d.elements,
      [id]: {
        ...element,
        location: { x: element.location.x + dx, y: element.location.y + dy },
      },
    },
  });
}

const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("moving a null object", () => {
  it("does not rewrite one keyframe of the child it parents", () => {
    const base = withNull(doc({ text: movingText() }));
    const parented = setParent(base, ["text"], "null1", 0);

    // The state the user is looking at when they grab the null. Everything
    // after this point must leave it alone.
    const before = snapshot((parented.elements.text as any).animation);

    const moved = moveNull(parented, "null1", 400, -250);

    expect(snapshot((moved.elements.text as any).animation)).toEqual(before);
  });

  it("leaves the child's own location and rotation alone as well", () => {
    const base = withNull(doc({ text: movingText({ rotation: 30 }) }));
    const parented = setParent(base, ["text"], "null1", 0);
    const before = parented.elements.text as any;

    const moved = moveNull(parented, "null1", 120, 40) as any;

    expect(moved.elements.text.location).toEqual(before.location);
    expect(moved.elements.text.rotation).toBe(before.rotation);
    expect(moved.elements.text.width).toBe(before.width);
    expect(moved.elements.text.height).toBe(before.height);
  });

  it("shifts the child's whole animated path by exactly the delta", () => {
    const base = withNull(doc({ text: movingText() }));
    const parented = setParent(base, ["text"], "null1", 0);

    // On the keyframe instants, because `sampleBaked` snaps to the nearest
    // sample rather than interpolating — a cursor between two anchors would be
    // testing the bake grid, not the parent chain.
    const cursors = [0, 1000, 2000];
    const before = cursors.map((t) => screenPoint(parented, "text", t));

    const moved = moveNull(parented, "null1", 400, -250);

    cursors.forEach((t, i) => {
      const after = screenPoint(moved, "text", t);
      expect(after.x).toBeCloseTo(before[i].x + 400, 9);
      expect(after.y).toBeCloseTo(before[i].y - 250, 9);
    });
  });

  it("carries the child around when the null itself is animated", () => {
    const nx = keys([0, 0], [1000, 600]);
    const base = withNull(doc({ text: movingText() }));
    const animatedNull = {
      ...(base.elements.null1 as any),
      animation: {
        ...(base.elements.null1 as any).animation,
        position: {
          isActivate: true,
          x: nx,
          y: keys([0, 0], [1000, 0]),
          ax: bakeTrack(nx),
          ay: bakeTrack(keys([0, 0], [1000, 0])),
        },
      },
    };
    const parented = setParent(
      { ...base, elements: { ...base.elements, null1: animatedNull } },
      ["text"],
      "null1",
      0,
    );

    // The null travels +600 in x between 0ms and 1000ms; the child rides it on
    // top of its own motion.
    const still = screenPoint(parented, "text", 0);
    const later = screenPoint(parented, "text", 1000);

    // The child's own curve contributes +200 over the same second.
    expect(later.x - still.x).toBeCloseTo(800, 6);
  });

  it("keeps drawing the child past the end of the null's own bar", () => {
    // Spatial parenting only: a group's span does not gate its children, which
    // `renderer/timeline.ts` states as a rule. A short null must not make a
    // long caption disappear, so its transform still answers past its end.
    const base = placeNewElement(
      doc({ text: movingText({ duration: 8000 }) }),
      "null1",
      createNullElement({ center: { x: 960, y: 540 }, duration: 500 }),
      0,
      "g-new",
    );
    const parented = setParent(base, ["text"], "null1", 0);

    const inside = screenPoint(parented, "text", 0);
    const past = screenPoint(parented, "text", 7000);

    // The child moved (it is animated), and the null's contribution is still
    // in the answer rather than having dropped out at 500ms.
    const nullLocation = (parented.elements.null1 as any).location;
    expect(past.x).toBeGreaterThan(inside.x);
    expect(past.x - (parented.elements.text as any).location.x).toBeCloseTo(
      nullLocation.x + 400,
      6,
    );
  });
});

describe("the instant of parenting", () => {
  it("does not move the child on screen", () => {
    const base = withNull(doc({ text: movingText() }));

    const cursors = [0, 1000, 2000];
    const before = cursors.map((t) => screenPoint(base, "text", t));

    const parented = setParent(base, ["text"], "null1", 0);

    cursors.forEach((t, i) => {
      const after = screenPoint(parented, "text", t);
      expect(after.x).toBeCloseTo(before[i].x, 6);
      expect(after.y).toBeCloseTo(before[i].y, 6);
    });
  });

  it("rewrites the child's keyframes once, which is what keeps it still", () => {
    // The counterpart to the first suite, and the reason the two are stated
    // together. A null centred at (960, 540) with a 100px pivot box sits at
    // (910, 490), so the child owes exactly that as a translation.
    const base = withNull(doc({ text: movingText() }));
    const wasX = snapshot((base.elements.text as any).animation.position.x);

    const parented = setParent(base, ["text"], "null1", 0);
    const nowX = (parented.elements.text as any).animation.position.x;

    expect(nowX).not.toEqual(wasX);
    nowX.forEach((k: any, i: number) => {
      expect(k.p[0]).toBe(wasX[i].p[0]); // time is untouched
      expect(k.p[1]).toBeCloseTo(wasX[i].p[1] - 910, 6);
    });
  });

  it("re-bakes the lanes it rewrote, so the renderer agrees with the editor", () => {
    const base = withNull(doc({ text: movingText() }));
    const parented = setParent(base, ["text"], "null1", 0);
    const position = (parented.elements.text as any).animation.position;

    expect(position.ax).toEqual(bakeTrack(position.x));
    expect(position.ay).toEqual(bakeTrack(position.y));
  });

  it("puts the child back where it was when it is released again", () => {
    const base = withNull(doc({ text: movingText() }));
    const parented = setParent(base, ["text"], "null1", 0);
    const released = setParent(parented, ["text"], null, 0);

    expect(parentOf(released.elements, "text")).toBeNull();
    [0, 1000, 2000].forEach((t) => {
      const was = screenPoint(base, "text", t);
      const now = screenPoint(released, "text", t);
      expect(now.x).toBeCloseTo(was.x, 6);
      expect(now.y).toBeCloseTo(was.y, 6);
    });
  });
});
