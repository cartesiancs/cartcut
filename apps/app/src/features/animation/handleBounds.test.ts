import { describe, it, expect } from "vitest";
import {
  ceTimeBounds,
  clampHandles,
  csTimeBounds,
  handlesInBounds,
  isCollapsedHandle,
} from "./handleBounds";
import {
  addKeyframe,
  moveKeyframe,
  normalizeKeyframes,
  removeKeyframe,
  setHandles,
  type Keyframe,
} from "./keyframes";
import { mulberry32 } from "../renderer/testing";

/** One keyframe with handles placed explicitly, so a test can put them anywhere. */
function kf(
  p: [number, number],
  cs: [number, number],
  ce: [number, number],
  type: "cubic" | "linear" = "cubic",
): Keyframe {
  return { type, p, cs, ce };
}

/** A three-keyframe list with every handle already in bounds. */
function trio(): Keyframe[] {
  return [
    kf([0, 0], [0, 0], [100, 0]),
    kf([500, 50], [400, 50], [600, 50]),
    kf([1000, 100], [900, 100], [1000, 100]),
  ];
}

describe("bounds of a handle", () => {
  it.each([
    ["cs of a middle keyframe spans from the previous anchor", 1, [0, 500]],
    ["cs of the last keyframe spans from its predecessor", 2, [500, 1000]],
  ])("%s", (_name, index, expected) => {
    expect(csTimeBounds(trio(), index as number)).toEqual(expected);
  });

  it.each([
    ["ce of the first keyframe spans to the next anchor", 0, [0, 500]],
    ["ce of a middle keyframe spans to its successor", 1, [500, 1000]],
  ])("%s", (_name, index, expected) => {
    expect(ceTimeBounds(trio(), index as number)).toEqual(expected);
  });

  // `bakeTrack` walks pairs and reads only `a.ce` and `b.cs`, so the outermost
  // two handles are never consulted. Reporting a span for them would invite the
  // editor to draw and offer a control that cannot affect the curve.
  it("reports no span for the handles the baker never reads", () => {
    const list = trio();
    expect(csTimeBounds(list, 0)).toBeNull();
    expect(ceTimeBounds(list, list.length - 1)).toBeNull();
  });

  it("reports no span at all for a lone keyframe", () => {
    const list = [kf([300, 7], [200, 7], [400, 7])];
    expect(csTimeBounds(list, 0)).toBeNull();
    expect(ceTimeBounds(list, 0)).toBeNull();
  });

  it.each([
    ["below zero", -1],
    ["past the end", 9],
  ])("reports no span for an index %s", (_name, index) => {
    expect(csTimeBounds(trio(), index as number)).toBeNull();
    expect(ceTimeBounds(trio(), index as number)).toBeNull();
  });
});

describe("clampHandles", () => {
  // The bug this module exists for: the editor wrote whatever the drag produced
  // while `bakeTrack` clamped the abscissae before solving, so a handle dragged
  // past its neighbour kept moving on screen while the curve stopped changing.
  it("folds a handle dragged past its neighbour back onto the boundary", () => {
    const list = trio();
    list[1] = kf([500, 50], [-4000, 50], [9000, 50]);

    const out = clampHandles(list);

    expect(out[1].cs[0]).toBe(0);
    expect(out[1].ce[0]).toBe(1000);
  });

  // Constraining the value axis would make overshoot and bounce easings
  // inexpressible. After Effects constrains time only, and so do we.
  it("never touches the value axis, however far out it is", () => {
    const list = trio();
    list[1] = kf([500, 50], [-4000, -9999], [9000, 9999]);

    const out = clampHandles(list);

    expect(out[1].cs[1]).toBe(-9999);
    expect(out[1].ce[1]).toBe(9999);
  });

  it("collapses the two inert end handles onto their anchors", () => {
    const list = [
      kf([0, 0], [-250, 30], [100, 0]),
      kf([1000, 100], [900, 100], [1250, 70]),
    ];

    const out = clampHandles(list);

    expect(isCollapsedHandle(out[0], "cs")).toBe(true);
    expect(isCollapsedHandle(out[1], "ce")).toBe(true);
    expect(out[0].cs).toEqual([0, 0]);
    expect(out[1].ce).toEqual([1000, 100]);
  });

  // The ops downstream declare that an edit changing nothing returns its input,
  // and `withCheckpoint` compares by identity to decide whether to record an
  // undo step. A clamp that always allocated would push an entry per no-op drag.
  it("returns the input by identity when every handle is already in bounds", () => {
    const list = trio();
    expect(clampHandles(list)).toBe(list);
  });

  it("shares the keyframes it did not have to change", () => {
    const list = trio();
    list[1] = kf([500, 50], [-4000, 50], [600, 50]);

    const out = clampHandles(list);

    expect(out).not.toBe(list);
    expect(out[0]).toBe(list[0]);
    expect(out[2]).toBe(list[2]);
  });

  it.each([
    ["an empty list", [] as Keyframe[]],
    ["a lone keyframe with stray handles", [kf([300, 7], [-1, 2], [999, 3])]],
  ])("handles %s", (_name, list) => {
    expect(handlesInBounds(clampHandles(list as Keyframe[]))).toBe(true);
  });

  it("is idempotent", () => {
    const list = trio();
    list[1] = kf([500, 50], [-4000, 50], [9000, 50]);

    const once = clampHandles(list);
    expect(clampHandles(once)).toBe(once);
  });
});

describe("the invariant survives every list-shaping op", () => {
  const seeded = (): Keyframe[] =>
    normalizeKeyframes([
      kf([0, 0], [-100, 0], [100, 0]),
      kf([200, 40], [100, 40], [300, 40]),
      kf([1000, 100], [900, 100], [1100, 100]),
    ]);

  it.each([
    ["addKeyframe into a gap narrower than the default handle", (l: Keyframe[]) =>
      addKeyframe(l, 250, 60)],
    ["addKeyframe at the very start", (l: Keyframe[]) => addKeyframe(l, -50, 5)],
    ["moveKeyframe past a neighbour", (l: Keyframe[]) =>
      moveKeyframe(l, 0, 700, 10).list],
    ["moveKeyframe onto the far end", (l: Keyframe[]) =>
      moveKeyframe(l, 1, 5000, 10).list],
    ["removeKeyframe from the middle", (l: Keyframe[]) => removeKeyframe(l, 1)],
    ["removeKeyframe from the end", (l: Keyframe[]) => removeKeyframe(l, 2)],
    ["setHandles well outside the segment", (l: Keyframe[]) =>
      setHandles(l, 1, { cs: [-9999, 1], ce: [9999, 1] })],
  ])("%s", (_name, op) => {
    const out = (op as (l: Keyframe[]) => Keyframe[])(seeded());
    expect(handlesInBounds(out)).toBe(true);
  });

  // `addKeyframe` seeds a fresh keyframe at ±DEFAULT_HANDLE_MS. Dropping one
  // 50ms after its neighbour therefore places `cs` 50ms *before* that neighbour
  // — outside the segment the baker will solve over.
  it("seats a new keyframe's default handles inside a narrow gap", () => {
    const out = addKeyframe(seeded(), 250, 60);
    const index = out.findIndex((k) => k.p[0] === 250);

    expect(out[index].cs[0]).toBe(200);
    expect(handlesInBounds(out)).toBe(true);
  });

  it("re-collapses the new last handle after the tail is removed", () => {
    const out = removeKeyframe(seeded(), 2);
    expect(isCollapsedHandle(out[out.length - 1], "ce")).toBe(true);
  });

  it("declines a setHandles patch that was already in bounds", () => {
    const list = seeded();
    const patch = { cs: [list[1].cs[0], list[1].cs[1]] as [number, number] };
    expect(setHandles(list, 1, patch)).toBe(list);
  });

  it("survives 500 mixed operations without leaving the invariant", () => {
    const random = mulberry32(20260820);
    let list = seeded();

    for (let step = 0; step < 500; step++) {
      const roll = random();
      const index = Math.floor(random() * Math.max(1, list.length));
      const tMs = Math.round(random() * 2000 - 250);
      const value = Math.round(random() * 200 - 50);

      if (roll < 0.35) {
        list = addKeyframe(list, tMs, value);
      } else if (roll < 0.6) {
        list = moveKeyframe(list, index, tMs, value).list;
      } else if (roll < 0.75) {
        list = removeKeyframe(list, index);
      } else {
        list = setHandles(list, index, {
          cs: [tMs, value],
          ce: [tMs + Math.round(random() * 500), value],
        });
      }

      expect(handlesInBounds(list)).toBe(true);
    }

    expect(list.length).toBeGreaterThan(0);
  });
});
