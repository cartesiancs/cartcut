import { describe, it, expect } from "vitest";
import {
  HANDLE_PADDING_PX,
  hitZoneOf,
  isStretchZone,
  type HitZone,
} from "./hitTest";
import {
  applyPoint,
  invert,
  scaleOf,
  worldMatrixOf,
} from "../timeline/transform";
import { bakeTrack } from "../animation/keyframes";
import { groupElement, imageElement, keys } from "../renderer/testing";
import type { Timeline } from "../../@types/timeline";

const W = 200;
const H = 100;

/** The zone a canvas-space pointer lands in, resolved through the world matrix. */
function hitOnCanvas(
  elements: Timeline,
  id: string,
  pointer: { x: number; y: number },
  cursor = 0,
): HitZone {
  const m = worldMatrixOf(elements, id, cursor);
  const element = elements[id] as any;
  return hitZoneOf(applyPoint(invert(m), pointer), element.width, element.height, {
    worldScale: scaleOf(m),
  });
}

describe("hitZoneOf on a plain box", () => {
  it("reports the interior", () => {
    expect(hitZoneOf({ x: 100, y: 50 }, W, H)).toBe("position");
  });

  it("reports nothing far outside", () => {
    expect(hitZoneOf({ x: 1000, y: 1000 }, W, H)).toBe("none");
  });

  it("reports each edge", () => {
    expect(hitZoneOf({ x: W + 5, y: H / 2 }, W, H)).toBe("stretchE");
    expect(hitZoneOf({ x: -5, y: H / 2 }, W, H)).toBe("stretchW");
    expect(hitZoneOf({ x: W / 2, y: -5 }, W, H)).toBe("stretchN");
    expect(hitZoneOf({ x: W / 2, y: H + 5 }, W, H)).toBe("stretchS");
  });

  it("reports each corner", () => {
    expect(hitZoneOf({ x: 0, y: 0 }, W, H)).toBe("stretchNW");
    expect(hitZoneOf({ x: W, y: 0 }, W, H)).toBe("stretchNE");
    expect(hitZoneOf({ x: 0, y: H }, W, H)).toBe("stretchSW");
    expect(hitZoneOf({ x: W, y: H }, W, H)).toBe("stretchSE");
  });

  it("prefers a corner over the edge it shares a band with", () => {
    // A corner point satisfies two edge bands at once; the diagonal grip is
    // what the pointer was aimed at.
    expect(hitZoneOf({ x: 2, y: 2 }, W, H)).toBe("stretchNW");
  });

  it("prefers the interior over an edge band just inside the box", () => {
    // Otherwise a drag started near the edge of a small element resizes it
    // when the user meant to move it.
    expect(hitZoneOf({ x: W / 2, y: HANDLE_PADDING_PX }, W, H)).toBe("position");
  });

  it("finds the rotation knob above the top edge", () => {
    expect(hitZoneOf({ x: W / 2, y: -50 }, W, H)).toBe("rotation");
  });

  it("does not report rotation from inside the element", () => {
    expect(hitZoneOf({ x: W / 2, y: 10 }, W, H)).not.toBe("rotation");
  });

  it("rejects a non-finite pointer instead of guessing", () => {
    expect(hitZoneOf({ x: NaN, y: 0 }, W, H)).toBe("none");
  });

  it("still resolves a zero-sized element without dividing by zero", () => {
    expect(() => hitZoneOf({ x: 0, y: 0 }, 0, 0)).not.toThrow();
  });
});

describe("handle sizes are screen pixels, not artwork pixels", () => {
  it("shrinks the bands in local space when the world scale is up", () => {
    // At 4x, 20 screen px is 5 local px. A point 10 local px outside the edge
    // is 40 screen px away — well past the grip.
    expect(hitZoneOf({ x: W + 10, y: H / 2 }, W, H, { worldScale: 4 })).toBe(
      "none",
    );
    expect(hitZoneOf({ x: W + 3, y: H / 2 }, W, H, { worldScale: 4 })).toBe(
      "stretchE",
    );
  });

  it("grows the bands in local space when the world scale is down", () => {
    // At 0.25x a grip would reach 80 local px to stay 20 on screen — but the
    // clamp holds it to a third of the shorter side (100/3), so it reaches
    // 33 local px instead. Still far wider than the unscaled 20.
    expect(hitZoneOf({ x: W + 20, y: H / 2 }, W, H, { worldScale: 0.25 })).toBe(
      "stretchE",
    );
  });

  it("keeps an interior for a small element instead of covering it in grips", () => {
    // A 20x20 clip with a 20px band has no interior at all unless the band is
    // clamped, so it could not be grabbed to move — every point on it read as
    // a resize grip.
    expect(hitZoneOf({ x: 10, y: 10 }, 20, 20)).toBe("position");
  });

  it("keeps the edge bands disjoint on a small element", () => {
    // Overlapping bands would make the zone depend on test order rather than
    // on where the pointer is.
    expect(hitZoneOf({ x: 20, y: 10 }, 20, 20)).toBe("stretchE");
    expect(hitZoneOf({ x: 0, y: 10 }, 20, 20)).toBe("stretchW");
  });

  it("ignores a zero or negative scale rather than making every band infinite", () => {
    expect(hitZoneOf({ x: 1000, y: 1000 }, W, H, { worldScale: 0 })).toBe("none");
    expect(hitZoneOf({ x: 1000, y: 1000 }, W, H, { worldScale: -2 })).toBe("none");
  });
});

describe("hit-testing through a parent chain", () => {
  it("finds a child that a group has translated away", () => {
    const elements: Timeline = {
      g: groupElement({ location: { x: 500, y: 300 }, width: 0, height: 0 }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 0, y: 0 },
        width: W,
        height: H,
      }) as any,
    };
    // The clip's own numbers say (0, 0); it is drawn at (500, 300).
    expect(hitOnCanvas(elements, "c", { x: 600, y: 350 })).toBe("position");
    expect(hitOnCanvas(elements, "c", { x: 100, y: 50 })).toBe("none");
  });

  it("finds a child that a group has rotated", () => {
    // Group is 200x200 → pivot (100, 100); a quarter turn about it.
    const elements: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 200,
        height: 200,
        rotation: 90,
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 100, y: 90 },
        width: 20,
        height: 20,
      }) as any,
    };
    // Centre of the child in group space is (110, 100). Rotating 90° about
    // (100, 100) sends it to (100, 110).
    expect(hitOnCanvas(elements, "c", { x: 100, y: 110 })).toBe("position");
  });

  it("keeps a child grabbable inside a group scaled right down", () => {
    // The regression this module exists to prevent: handles measured in
    // artwork pixels vanish as the group shrinks.
    const quarter = keys([0, 2.5]); // 0.25x
    const elements: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          scale: { isActivate: true, x: quarter, ax: bakeTrack(quarter) },
        },
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 0, y: 0 },
        width: W,
        height: H,
      }) as any,
    };

    // The element is drawn 200x100 * 0.25 = 50x25 on screen, at the origin.
    expect(hitOnCanvas(elements, "c", { x: 25, y: 12 })).toBe("position");
    // A corner grab 10 screen px outside the corner must still land.
    expect(isStretchZone(hitOnCanvas(elements, "c", { x: 52, y: 27 }))).toBe(true);
  });

  it("follows the group's animated position over time", () => {
    const list = keys([0, 0], [1000, 400]);
    const flat = keys([0, 0], [1000, 0]);
    const elements: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          position: {
            isActivate: true,
            x: list,
            y: flat,
            ax: bakeTrack(list),
            ay: bakeTrack(flat),
          },
        },
      }) as any,
      c: imageElement({
        parentId: "g",
        location: { x: 0, y: 0 },
        width: W,
        height: H,
      }) as any,
    };

    expect(hitOnCanvas(elements, "c", { x: 100, y: 50 }, 0)).toBe("position");
    expect(hitOnCanvas(elements, "c", { x: 100, y: 50 }, 1000)).toBe("none");
    expect(hitOnCanvas(elements, "c", { x: 500, y: 50 }, 1000)).toBe("position");
  });

  it("still works for an element with no parent at all", () => {
    const elements: Timeline = {
      c: imageElement({ location: { x: 10, y: 10 }, width: W, height: H }) as any,
    };
    expect(hitOnCanvas(elements, "c", { x: 110, y: 60 })).toBe("position");
  });
});

describe("isStretchZone", () => {
  it("is true for every grip and false otherwise", () => {
    for (const zone of [
      "stretchE",
      "stretchW",
      "stretchN",
      "stretchS",
      "stretchNW",
      "stretchNE",
      "stretchSW",
      "stretchSE",
    ] as HitZone[]) {
      expect(isStretchZone(zone)).toBe(true);
    }
    expect(isStretchZone("position")).toBe(false);
    expect(isStretchZone("rotation")).toBe(false);
    expect(isStretchZone("none")).toBe(false);
  });
});
