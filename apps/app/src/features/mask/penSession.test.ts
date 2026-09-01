import { describe, expect, it } from "vitest";

import { boundsOf, isCorner } from "./geometry";
import { maskNodesInElementSpace, maskStaticSample } from "./place";
import { defaultMask } from "./maskShape";
import {
  PEN_KEY_CODES,
  type PenSession,
  penBegin,
  penCapturesKey,
  penClosesAt,
  penCommit,
  penDown,
  penKey,
  penMove,
  penUp,
} from "./penSession";

const GRAB = 8;
const BOX = { width: 400, height: 200 };

/** Click a sequence of points, ignoring anything the session refuses. */
function clicks(...points: Array<[number, number]>): PenSession {
  let session = penBegin("el");
  for (const [x, y] of points) {
    const action = penDown(session, { x, y }, GRAB);
    if (action.kind === "update" || action.kind === "commit") {
      session = action.session;
    }
    const up = penUp(session);
    if (up.kind === "update") {
      session = up.session;
    }
  }
  return session;
}

const TRIANGLE: Array<[number, number]> = [
  [100, 40],
  [300, 40],
  [200, 160],
];

describe("placing nodes", () => {
  it("starts empty", () => {
    const session = penBegin("el");
    expect(session.nodes).toEqual([]);
    expect(session.elementId).toBe("el");
    expect(session.dragging).toBe(-1);
  });

  it("adds a corner per click", () => {
    const session = clicks(...TRIANGLE);
    expect(session.nodes).toHaveLength(3);
    expect(session.nodes.every(isCorner)).toBe(true);
    expect(session.nodes[0].p).toEqual([100, 40]);
  });

  // A drag is how the user says "curve here". A click is how they say "corner",
  // and `round.ts` reads exactly that distinction later.
  it("turns a click-drag into a smooth node with mirrored handles", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    session = (penMove(session, { x: 130, y: 90 }) as any).session;

    const node = session.nodes[0];
    expect(node.ce).toEqual([30, -10]);
    expect(node.cs).toEqual([-30, 10]);
    expect(isCorner(node)).toBe(false);
  });

  it("leaves a node a corner when the drag never moves", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    const moved = penMove(session, { x: 100.1, y: 100.1 });
    expect(isCorner((moved as any).session.nodes[0])).toBe(true);
  });

  // A press that pulls a handle out and comes back is a corner again — the user
  // undid the drag with the mouse still down, and the node should follow.
  it("takes handles back off when the drag returns to the anchor", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    session = (penMove(session, { x: 140, y: 100 }) as any).session;
    session = (penMove(session, { x: 100, y: 100 }) as any).session;
    expect(isCorner(session.nodes[0])).toBe(true);
  });

  it("disarms the node on mouse up, so the next move is a hover", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    session = (penUp(session) as any).session;
    expect(session.dragging).toBe(-1);

    session = (penMove(session, { x: 200, y: 200 }) as any).session;
    expect(isCorner(session.nodes[0])).toBe(true);
    expect(session.hover).toEqual({ x: 200, y: 200 });
  });

  it("ignores a second press on the node just placed", () => {
    let session = clicks([100, 100]);
    expect(penDown(session, { x: 100.2, y: 100.2 }, GRAB).kind).toBe("none");
    expect(session.nodes).toHaveLength(1);
  });

  it("reports no change rather than a new session for a still pointer", () => {
    let session = clicks([100, 100]);
    session = (penMove(session, { x: 150, y: 150 }) as any).session;
    expect(penMove(session, { x: 150, y: 150 }).kind).toBe("none");
  });

  it("never mutates the session it is given", () => {
    const session = clicks(...TRIANGLE);
    const before = JSON.stringify(session);
    penDown(session, { x: 10, y: 10 }, GRAB);
    penMove(session, { x: 20, y: 20 });
    penKey(session, "Backspace");
    penCommit(session, BOX);
    expect(JSON.stringify(session)).toBe(before);
  });
});

describe("closing the path", () => {
  it("closes on a click near the first node", () => {
    const session = clicks(...TRIANGLE);
    expect(penClosesAt(session, { x: 103, y: 42 }, GRAB)).toBe(true);
    expect(penDown(session, { x: 103, y: 42 }, GRAB).kind).toBe("commit");
  });

  it("does not close on a click near the first node from far away", () => {
    const session = clicks(...TRIANGLE);
    expect(penClosesAt(session, { x: 140, y: 40 }, GRAB)).toBe(false);
    expect(penDown(session, { x: 140, y: 40 }, GRAB).kind).toBe("update");
  });

  // Two nodes enclose nothing, so "closing" would commit a line and the ops
  // layer would decline — leaving a tool that looked like it had worked.
  it("refuses to close before there are three nodes", () => {
    const session = clicks([100, 40], [300, 40]);
    expect(penClosesAt(session, { x: 100, y: 40 }, GRAB)).toBe(false);
    expect(penDown(session, { x: 100, y: 40 }, GRAB).kind).toBe("update");
  });

  it("closes on Enter", () => {
    expect(penKey(clicks(...TRIANGLE), "Enter").kind).toBe("commit");
    expect(penKey(clicks(...TRIANGLE), "NumpadEnter").kind).toBe("commit");
  });

  it("does nothing on Enter with too few nodes", () => {
    expect(penKey(clicks([100, 40], [300, 40]), "Enter").kind).toBe("none");
  });

  it("clears the rubber band when it closes, so no stray segment is drawn", () => {
    let session = clicks(...TRIANGLE);
    session = (penMove(session, { x: 250, y: 100 }) as any).session;
    const action = penKey(session, "Enter");
    expect((action as any).session.hover).toBeNull();
  });
});

describe("the keys the pen owns", () => {
  // These are the ones `elementTimelineCanvas._handleKeydown` would otherwise
  // take: Backspace and Delete delete the selected clip, Escape cancels an
  // unrelated timeline gesture.
  it("captures exactly the keys it acts on", () => {
    for (const code of ["Escape", "Enter", "NumpadEnter", "Backspace", "Delete"]) {
      expect(penCapturesKey(code), code).toBe(true);
    }
    expect([...PEN_KEY_CODES].sort()).toEqual(
      ["Backspace", "Delete", "Enter", "Escape", "NumpadEnter"].sort(),
    );
  });

  // Arrows stay with the timeline, inert because every non-pointer tool already
  // disables them. A modal tool should not have to list what it is not using.
  it("leaves the arrow keys, space and undo alone", () => {
    for (const code of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Space",
      "KeyZ",
      "KeyD",
    ]) {
      expect(penCapturesKey(code), code).toBe(false);
      expect(penKey(clicks(...TRIANGLE), code).kind, code).toBe("none");
    }
  });

  it("abandons the whole session on Escape", () => {
    expect(penKey(clicks(...TRIANGLE), "Escape").kind).toBe("cancel");
    expect(penKey(penBegin("el"), "Escape").kind).toBe("cancel");
  });

  it("removes the last node on Backspace", () => {
    const action = penKey(clicks(...TRIANGLE), "Backspace");
    expect((action as any).session.nodes).toHaveLength(2);
    expect((action as any).session.nodes[1].p).toEqual([300, 40]);
  });

  it("removes the last node on Delete, and does not touch the clip", () => {
    const action = penKey(clicks(...TRIANGLE), "Delete");
    expect(action.kind).toBe("update");
    expect((action as any).session.nodes).toHaveLength(2);
  });

  // The key always does something: a user who over-deletes ends up with the
  // tool off rather than with an invisible session still eating Backspaces.
  it("cancels rather than doing nothing when Backspace empties the session", () => {
    expect(penKey(penBegin("el"), "Backspace").kind).toBe("cancel");
  });

  it("disarms a drag when a node is removed mid-press", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    expect(session.dragging).toBe(0);
    const action = penKey(session, "Backspace");
    // The armed index would now point past the end of the list.
    expect((action as any).session?.dragging ?? -1).toBe(-1);
  });
});

describe("committing", () => {
  it("frames the drawing with its own bounding box", () => {
    const commit = penCommit(clicks(...TRIANGLE), BOX)!;
    // The triangle spans x 100..300 and y 40..160 of a 400x200 element.
    expect(commit.location.x).toBeCloseTo(50, 9);
    expect(commit.location.y).toBeCloseTo(50, 9);
    expect(commit.size.width).toBeCloseTo(50, 9);
    expect(commit.size.height).toBeCloseTo(60, 9);
  });

  it("expresses the nodes in the unit square", () => {
    const commit = penCommit(clicks(...TRIANGLE), BOX)!;
    const bounds = boundsOf(commit.path)!;
    expect(bounds.minX).toBeCloseTo(-0.5, 9);
    expect(bounds.maxX).toBeCloseTo(0.5, 9);
    expect(bounds.minY).toBeCloseTo(-0.5, 9);
    expect(bounds.maxY).toBeCloseTo(0.5, 9);
  });

  /**
   * The round trip that matters: what the user drew is what gets drawn.
   *
   * Framing and placement are inverses, so pushing the committed mask back
   * through `maskNodesInElementSpace` must land on the original clicks.
   */
  it("round-trips through placement back to the pixels that were clicked", () => {
    const commit = penCommit(clicks(...TRIANGLE), BOX)!;
    const mask = {
      ...defaultMask("pen"),
      location: commit.location,
      size: commit.size,
      path: commit.path,
    };
    const placed = maskNodesInElementSpace(mask, maskStaticSample(mask), BOX);
    placed.forEach((node, index) => {
      expect(node.p[0]).toBeCloseTo(TRIANGLE[index][0], 6);
      expect(node.p[1]).toBeCloseTo(TRIANGLE[index][1], 6);
    });
  });

  it("round-trips a path with handles too", () => {
    let session = penBegin("el");
    session = (penDown(session, { x: 100, y: 100 }, GRAB) as any).session;
    session = (penMove(session, { x: 140, y: 80 }) as any).session;
    session = (penUp(session) as any).session;
    session = (penDown(session, { x: 300, y: 100 }, GRAB) as any).session;
    session = (penUp(session) as any).session;
    session = (penDown(session, { x: 200, y: 180 }, GRAB) as any).session;
    session = (penUp(session) as any).session;

    const commit = penCommit(session, BOX)!;
    const mask = {
      ...defaultMask("pen"),
      location: commit.location,
      size: commit.size,
      path: commit.path,
    };
    const placed = maskNodesInElementSpace(mask, maskStaticSample(mask), BOX);
    expect(placed[0].ce![0]).toBeCloseTo(40, 6);
    expect(placed[0].ce![1]).toBeCloseTo(-20, 6);
    expect(placed[0].cs![0]).toBeCloseTo(-40, 6);
  });

  it("declines a path that encloses nothing", () => {
    expect(penCommit(clicks([100, 40], [300, 40]), BOX)).toBeNull();
    expect(penCommit(penBegin("el"), BOX)).toBeNull();
  });

  it("declines when the element has no extent", () => {
    expect(penCommit(clicks(...TRIANGLE), { width: 0, height: 200 })).toBeNull();
    expect(penCommit(clicks(...TRIANGLE), { width: 400, height: 0 })).toBeNull();
  });

  // Three collinear clicks have no height. The framing must still produce
  // numbers, or every node lands at NaN and the mask goes off-canvas.
  it("survives a degenerate bounding box without producing NaN", () => {
    const commit = penCommit(clicks([100, 100], [200, 100], [300, 100]), BOX)!;
    expect(commit).not.toBeNull();
    for (const value of [
      commit.location.x,
      commit.location.y,
      commit.size.width,
      commit.size.height,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const node of commit.path) {
      expect(Number.isFinite(node.p[0])).toBe(true);
      expect(Number.isFinite(node.p[1])).toBe(true);
    }
    expect(commit.size.height).toBeGreaterThan(0);
  });

  it("frames once, so editing afterwards does not creep the box", () => {
    const first = penCommit(clicks(...TRIANGLE), BOX)!;
    const again = penCommit(clicks(...TRIANGLE), BOX)!;
    expect(again).toEqual(first);
  });
});

describe("the session is independent of the viewport", () => {
  /**
   * Zoom, pan and scrubbing all change where a click lands *on screen* and none
   * of them change where it lands on the picture. Because the session stores
   * element-local pixels — the caller converts on the way in — none of the
   * three can reach it, and there is nothing to guard.
   */
  it("holds element-local pixels, so the same picture point is the same node", () => {
    const atOneHundredPercent = clicks([100, 40]);
    const atTwoHundred = clicks([100, 40]);
    expect(atOneHundredPercent.nodes).toEqual(atTwoHundred.nodes);
  });

  it("keeps the target it began with", () => {
    let session = penBegin("target");
    session = (penDown(session, { x: 10, y: 10 }, GRAB) as any).session;
    session = (penKey(session, "Backspace") as any).session;
    expect(session.elementId).toBe("target");
  });
});
