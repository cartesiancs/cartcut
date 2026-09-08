import { describe, it, expect } from "vitest";
import {
  NULL_ANCHOR_GRAB_PX,
  NULL_BAND_PX,
  nullGizmoGeometry,
  nullHitZoneOf,
  pointerOrder,
} from "./nullGizmo";
import { groupElement, imageElement } from "../renderer/testing";
import type { Timeline } from "../../@types/timeline";

const W = 400;
const H = 300;

/** The four corners and the four edge midpoints of a `w × h` box. */
const CORNERS = [
  { at: { x: 0, y: 0 }, zone: "stretchNW" },
  { at: { x: W, y: 0 }, zone: "stretchNE" },
  { at: { x: 0, y: H }, zone: "stretchSW" },
  { at: { x: W, y: H }, zone: "stretchSE" },
] as const;

const EDGES = [
  { at: { x: W / 2, y: 0 }, zone: "stretchN" },
  { at: { x: W / 2, y: H }, zone: "stretchS" },
  { at: { x: 0, y: H / 2 }, zone: "stretchW" },
  { at: { x: W, y: H / 2 }, zone: "stretchE" },
] as const;

describe("nullHitZoneOf", () => {
  /**
   * The rule the whole feature rests on.
   *
   * A null's box typically encloses its own children, so a null that answered
   * the pointer across its full rectangle would be an invisible sheet
   * swallowing every click aimed at what is inside it. That hazard is what made
   * `canPointerTarget` refuse an unselected group — circularly, so no group was
   * ever grabbable at all. Answering it here is what lets a null be live all
   * the time.
   */
  it("passes the interior through", () => {
    for (const p of [
      { x: W * 0.25, y: H * 0.25 },
      { x: W * 0.75, y: H * 0.25 },
      { x: W * 0.25, y: H * 0.75 },
      { x: W * 0.75, y: H * 0.75 },
      { x: W * 0.4, y: H * 0.6 },
    ]) {
      expect(nullHitZoneOf(p, W, H)).toBe("none");
    }
  });

  it("passes points far outside through", () => {
    expect(nullHitZoneOf({ x: 5000, y: 5000 }, W, H)).toBe("none");
    expect(nullHitZoneOf({ x: -5000, y: H / 2 }, W, H)).toBe("none");
  });

  it("takes the anchor at the pivot", () => {
    expect(nullHitZoneOf({ x: W / 2, y: H / 2 }, W, H)).toBe("position");
    // Just inside the grab radius, on both axes.
    expect(
      nullHitZoneOf({ x: W / 2 + NULL_ANCHOR_GRAB_PX - 1, y: H / 2 }, W, H),
    ).toBe("position");
    expect(
      nullHitZoneOf({ x: W / 2, y: H / 2 - NULL_ANCHOR_GRAB_PX + 1 }, W, H),
    ).toBe("position");
    // And just outside it is interior again, not a near-miss on something else.
    expect(
      nullHitZoneOf({ x: W / 2 + NULL_ANCHOR_GRAB_PX + 2, y: H / 2 }, W, H),
    ).toBe("none");
  });

  it("takes each corner", () => {
    for (const { at, zone } of CORNERS) {
      expect(nullHitZoneOf(at, W, H)).toBe(zone);
    }
  });

  it("takes each edge", () => {
    for (const { at, zone } of EDGES) {
      expect(nullHitZoneOf(at, W, H)).toBe(zone);
    }
  });

  it("takes a point straddling an edge, inside and out", () => {
    const half = NULL_BAND_PX / 2;
    expect(nullHitZoneOf({ x: W / 2, y: -half }, W, H)).toBe("stretchN");
    expect(nullHitZoneOf({ x: W / 2, y: half }, W, H)).toBe("stretchN");
  });

  it("does not take an edge band off the end of its own edge", () => {
    // Level with the top edge but far past the right-hand corner: a miss, not
    // a `stretchN` that would resize from a point outside the box.
    expect(nullHitZoneOf({ x: W + 200, y: 0 }, W, H)).toBe("none");
  });

  it("takes the rotation knob above the top edge", () => {
    expect(nullHitZoneOf({ x: W / 2, y: -50 }, W, H)).toBe("rotation");
  });

  it("prefers the anchor to a band when they overlap", () => {
    // A null small enough on screen that the bands reach the middle. Moving it
    // has to stay possible — the anchor is the only way — so the anchor is
    // tested first.
    const small = 12;
    expect(nullHitZoneOf({ x: small / 2, y: small / 2 }, small, small)).toBe(
      "position",
    );
  });

  it("keeps an interior on a box small enough for the bands to meet", () => {
    // The clamp to a quarter of the shorter side. Without it every point on a
    // small null reports a resize grip and the null becomes the swallowing
    // sheet this module exists to avoid.
    const g = nullGizmoGeometry(20, 20, 1);
    expect(g.band).toBeLessThanOrEqual(5);
    expect(g.band * 2).toBeLessThan(20);
  });

  it("survives a scale of zero rather than making every band infinite", () => {
    // The scale track reaches 0. Dividing by it would put every point in a
    // corner grab. Same defence `hitZoneOf` states.
    for (const scale of [0, -1, NaN, Infinity]) {
      expect(
        nullHitZoneOf({ x: W * 0.4, y: H * 0.6 }, W, H, { worldScale: scale }),
      ).toBe("none");
    }
  });

  it("rejects a non-finite pointer", () => {
    expect(nullHitZoneOf({ x: NaN, y: 0 }, W, H)).toBe("none");
    expect(nullHitZoneOf({ x: 0, y: Infinity }, W, H)).toBe("none");
  });

  /**
   * Handle sizes are a property of the pointer, not of the artwork: a band
   * should be the same number of *screen* pixels whatever the null is doing.
   * Since the point arriving here is already divided by the world scale, the
   * bands have to be divided too — or a null inside a group scaled to 25% gets
   * bands a quarter their intended size and becomes unusable.
   */
  it("keeps its bands screen-constant", () => {
    const g1 = nullGizmoGeometry(W, H, 1);
    const g4 = nullGizmoGeometry(W, H, 4);
    expect(g4.band).toBeCloseTo(g1.band / 4);
    expect(g4.anchor.grab).toBeCloseTo(g1.anchor.grab / 4);
    expect(g4.tick).toBeCloseTo(g1.tick / 4);
    expect(g4.line).toBeCloseTo(g1.line / 4);
    expect(g4.unit).toBeCloseTo(g1.unit / 4);

    // A point one screen pixel outside the right edge is `stretchE` at both
    // scales, which is the property those divisions exist for.
    expect(
      nullHitZoneOf({ x: W + 1 / 4, y: H / 2 }, W, H, { worldScale: 4 }),
    ).toBe("stretchE");
    // ...and four element-pixels out is a miss at 4x, where it would have been
    // a hit at 1x.
    expect(nullHitZoneOf({ x: W + 4, y: H / 2 }, W, H, { worldScale: 4 })).toBe(
      "none",
    );
    expect(nullHitZoneOf({ x: W + 4, y: H / 2 }, W, H, { worldScale: 1 })).toBe(
      "stretchE",
    );
  });
});

/**
 * The pairing that keeps this module honest: every mark `nullGizmoGeometry`
 * puts on screen has to be a mark `nullHitZoneOf` accepts. Drawing and pointing
 * derive from one function each, and these assertions are what stop the two
 * from drifting — the `collisionCheck`-versus-renderer split all over again.
 */
describe("geometry and hit test agree", () => {
  const g = nullGizmoGeometry(W, H, 1);

  it("puts the anchor marks inside the anchor's grab region", () => {
    // The drawn ring and the crosshair arms both have to be grabbable, or the
    // user aims at a mark that does nothing.
    expect(g.anchor.radius).toBeLessThanOrEqual(g.anchor.grab);
    expect(g.anchor.arm).toBeLessThanOrEqual(g.anchor.grab);
    expect(
      nullHitZoneOf({ x: g.anchor.x + g.anchor.radius, y: g.anchor.y }, W, H),
    ).toBe("position");
    expect(
      nullHitZoneOf({ x: g.anchor.x, y: g.anchor.y - g.anchor.arm }, W, H),
    ).toBe("position");
  });

  it("draws each corner tick along the zone that corner answers for", () => {
    // The far end of each arm, which is the outermost pixel of the mark.
    for (const { at, zone } of CORNERS) {
      const sx = at.x === 0 ? 1 : -1;
      const sy = at.y === 0 ? 1 : -1;
      expect(nullHitZoneOf({ x: at.x + sx * g.tick, y: at.y }, W, H)).toBe(zone);
      expect(nullHitZoneOf({ x: at.x, y: at.y + sy * g.tick }, W, H)).toBe(zone);
    }
  });

  it("draws the selected-state grips on zones the pointer accepts", () => {
    // The eight squares `drawNullGizmo` fills in the `active` state. Selecting
    // a null must not make anything newly grabbable, or there would be two
    // rules to keep in step instead of one.
    for (const { at, zone } of [...CORNERS, ...EDGES]) {
      expect(nullHitZoneOf(at, W, H)).toBe(zone);
    }
  });

  it("draws the knob inside the knob's zone", () => {
    expect(nullHitZoneOf({ x: g.knob.x, y: g.knob.y }, W, H)).toBe("rotation");
    expect(
      nullHitZoneOf({ x: g.knob.x, y: g.knob.y + g.knob.radius }, W, H),
    ).toBe("rotation");
  });
});

describe("pointerOrder", () => {
  const timeline = (): Timeline =>
    ({
      backdrop: imageElement({ priority: 0 }),
      title: imageElement({ priority: 9 }),
      // Deliberately the lowest priority of the three: a group row carries no
      // z-order meaning, so this is exactly the arrangement that used to leave
      // a null unreachable behind the pictures it sits over.
      nul: groupElement({ priority: 0 }),
    }) as unknown as Timeline;

  it("sorts clips by priority", () => {
    const order = pointerOrder(timeline());
    expect(order.indexOf("backdrop")).toBeLessThan(order.indexOf("title"));
  });

  /**
   * Both pointer loops walk this order and never break, so the *last* match
   * wins. Groups go last because the gizmo is chrome, and chrome wins — it
   * costs the clips underneath almost nothing, since a null only ever claims
   * its thin bands and its anchor.
   */
  it("puts every group after every clip, whatever their priorities", () => {
    const order = pointerOrder(timeline());
    expect(order[order.length - 1]).toBe("nul");
  });

  it("returns every id exactly once", () => {
    const order = pointerOrder(timeline());
    expect(order.slice().sort()).toEqual(["backdrop", "nul", "title"]);
  });

  it("survives an empty timeline", () => {
    expect(pointerOrder({})).toEqual([]);
  });
});
