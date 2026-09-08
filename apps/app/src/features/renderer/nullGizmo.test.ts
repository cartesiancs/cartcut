import { describe, it, expect } from "vitest";
import { drawNullGizmo } from "./nullGizmo";
import { inkBounds, pixel, scene } from "./testing";
import {
  nullGizmoGeometry,
  type NullGizmoState,
} from "../preview/nullGizmo";

const W = 200;
const H = 140;
/** Where the box's top-left is put on the test canvas. */
const OX = 40;
const OY = 40;

function draw(state: NullGizmoState, label?: string) {
  const { canvas, ctx } = scene(280, 220, "#000000");
  ctx.translate(OX, OY);
  drawNullGizmo(ctx, nullGizmoGeometry(W, H, 1), state, "#ffffff", label);
  return canvas;
}

/** How many pixels the gizmo lit up. */
const ink = (state: NullGizmoState, label?: string) =>
  inkBounds(draw(state, label)).count;

describe("drawNullGizmo", () => {
  /**
   * The whole reason a null can be drawn at every playhead without ruining the
   * preview: it is an outline and an anchor, not a filled rectangle. This is
   * the pixel-level statement of the same contract `nullHitZoneOf` makes by
   * answering "none" for the interior.
   */
  it("leaves the interior empty", () => {
    const canvas = draw("active");
    for (const [x, y] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]) {
      const p = pixel(canvas, OX + W * x, OY + H * y);
      expect(p.r).toBe(0);
      expect(p.g).toBe(0);
      expect(p.b).toBe(0);
    }
  });

  it("marks the pivot", () => {
    // The anchor crosshair, dead centre — the primary grab target, and the one
    // mark that has to be findable without hovering.
    const p = pixel(draw("idle"), OX + W / 2, OY + H / 2);
    expect(p.r).toBeGreaterThan(0);
  });

  it("draws inside the box it was given, plus the knob above it", () => {
    const bounds = inkBounds(draw("idle"));
    expect(bounds.minX).toBeGreaterThanOrEqual(OX - 2);
    expect(bounds.maxX).toBeLessThanOrEqual(OX + W + 2);
    expect(bounds.maxY).toBeLessThanOrEqual(OY + H + 2);
    // Idle draws no knob, so nothing reaches above the top edge.
    expect(bounds.minY).toBeGreaterThanOrEqual(OY - 2);
  });

  it("draws the same shape at idle and hover, only fainter", () => {
    // Hover is an alpha change, not a different gizmo: the marks must not move
    // under the pointer as it arrives.
    const idle = inkBounds(draw("idle"));
    const hover = inkBounds(draw("hover"));
    expect(idle.minX).toBe(hover.minX);
    expect(idle.maxX).toBe(hover.maxX);
    expect(idle.minY).toBe(hover.minY);
    expect(idle.maxY).toBe(hover.maxY);

    const faint = pixel(draw("idle"), OX + W / 2, OY + H / 2);
    const full = pixel(draw("hover"), OX + W / 2, OY + H / 2);
    expect(faint.r).toBeLessThan(full.r);
  });

  /**
   * Selecting adds the eight grips and the rotation knob. It must not add
   * anything *grabbable* — `nullGizmo.test.ts` pins that every one of those
   * marks sits on a zone the hit test already accepted — so this only checks
   * that the state is visibly different and reaches above the box.
   */
  it("adds grips and a knob when active", () => {
    expect(ink("active")).toBeGreaterThan(ink("hover"));
    expect(inkBounds(draw("active")).minY).toBeLessThan(OY - 10);
  });

  it("shows the name only once the pointer has said which null it means", () => {
    // Drawn for every null at every playhead, a permanent label is the clutter
    // the idle state is trying to avoid.
    expect(ink("idle", "Null")).toBe(ink("idle"));
    expect(ink("hover", "Null")).toBeGreaterThan(ink("hover"));
    expect(ink("active", "Null")).toBeGreaterThan(ink("active"));
  });

  it("draws nothing extra for an empty name", () => {
    expect(ink("hover", "")).toBe(ink("hover"));
  });

  /**
   * The reason the gizmo does not reuse `renderControlOutline`: its handles are
   * sized in world pixels, so they shrink as you zoom out, while every hit test
   * sizes them in screen pixels divided by the world scale. Here the two agree,
   * because both come from `nullGizmoGeometry`.
   */
  it("keeps its marks a constant size on screen as the scale changes", () => {
    // `worldScale` is element pixels *to* screen pixels: at 2, one element
    // pixel covers two on screen. So a null that fills the same W×H of screen
    // is half as large in its own units, and the context scales up by the same
    // factor. Both pictures must come out identical.
    const marksAt = (worldScale: number) => {
      const { canvas, ctx } = scene(280, 220, "#000000");
      ctx.translate(OX, OY);
      ctx.scale(worldScale, worldScale);
      drawNullGizmo(
        ctx,
        nullGizmoGeometry(W / worldScale, H / worldScale, worldScale),
        "active",
        "#ffffff",
      );
      return inkBounds(canvas);
    };

    const one = marksAt(1);
    const two = marksAt(2);
    expect(two.minX).toBeCloseTo(one.minX, -1);
    expect(two.maxX).toBeCloseTo(one.maxX, -1);
    expect(two.count / one.count).toBeGreaterThan(0.8);
    expect(two.count / one.count).toBeLessThan(1.25);
  });
});
