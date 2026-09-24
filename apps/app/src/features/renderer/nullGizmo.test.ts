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

/**
 * Every pixel the gizmo lit, as `"x,y"`.
 *
 * One `getImageData` for the whole canvas rather than `pixel` per point: the
 * subset check below looks at all 61,600 of them.
 */
function lit(state: NullGizmoState): Set<string> {
  const canvas = draw(state);
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const out = new Set<string>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] > 40) {
        out.add(`${x},${y}`);
      }
    }
  }
  return out;
}

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
    const bounds = inkBounds(draw("hover"));
    expect(bounds.minX).toBeGreaterThanOrEqual(OX - 2);
    expect(bounds.maxX).toBeLessThanOrEqual(OX + W + 2);
    expect(bounds.maxY).toBeLessThanOrEqual(OY + H + 2);
    // Hover draws no knob, so nothing reaches above the top edge.
    expect(bounds.minY).toBeGreaterThanOrEqual(OY - 2);
  });

  /**
   * After Effects' and Premiere's rule, as far as we can take it: transform
   * chrome belongs to what is being worked on, so neither leaves a box standing
   * over the picture for an unselected layer. We keep the anchor, because the
   * preview is the only surface that can select a null, and drop the rest, so
   * a resting project carries one small mark per null instead of a frame-sized
   * dashed rectangle around each one, which is what made several nulls
   * unwatchable.
   */
  it("draws the anchor and no boundary at idle", () => {
    const bounds = inkBounds(draw("idle"));
    // Confined to the middle half of both axes, so nothing is near an edge, a
    // corner or the knob. The bands are still grabbable there; `hover` is what
    // marks them, and `previewCanvas` raises it for any zone the hit test
    // accepts.
    expect(bounds.minX).toBeGreaterThan(OX + W / 4);
    expect(bounds.maxX).toBeLessThan(OX + (W * 3) / 4);
    expect(bounds.minY).toBeGreaterThan(OY + H / 4);
    expect(bounds.maxY).toBeLessThan(OY + (H * 3) / 4);
  });

  it("adds the boundary on hover and moves nothing already drawn", () => {
    const idle = lit("idle");
    const hover = lit("hover");

    // A mark that moved as the pointer arrived would be a target sliding out
    // from under the click it invited. Subset rather than equality: hover is
    // allowed to add the box and the ticks, never to relocate the anchor.
    expect([...idle].filter((p) => !hover.has(p))).toEqual([]);
    expect(hover.size).toBeGreaterThan(idle.size);

    const bounds = inkBounds(draw("hover"));
    expect(bounds.minX).toBeLessThanOrEqual(OX + 2);
    expect(bounds.maxX).toBeGreaterThanOrEqual(OX + W - 2);
    expect(bounds.minY).toBeLessThanOrEqual(OY + 2);
    expect(bounds.maxY).toBeGreaterThanOrEqual(OY + H - 2);
  });

  /**
   * The dark backing under every mark, and the reason `idle` can be this quiet.
   *
   * `color` is the user's own `timelineOptions.color`, the footage under it is
   * anything at all, and since idle draws only the anchor a washed-out gizmo is
   * a null nobody can find. Drawing it in the background's own colour leaves
   * the backing as the only thing that can carry the shape, which is the whole
   * claim: Premiere's handles and AE's anchor point are two-tone for this.
   */
  it("stays visible on footage its own colour", () => {
    const { canvas, ctx } = scene(280, 220, "#ffffff");
    ctx.translate(OX, OY);
    drawNullGizmo(ctx, nullGizmoGeometry(W, H, 1), "idle", "#ffffff");

    const data = canvas.getContext("2d").getImageData(0, 0, 280, 220).data;
    let darkened = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 220) {
        darkened++;
      }
    }
    expect(darkened).toBeGreaterThan(50);

    // And it is a rim on the marks, not a wash over the box: the interior the
    // hit test refuses is still untouched white.
    for (const [x, y] of [
      [0.25, 0.25],
      [0.75, 0.75],
    ]) {
      expect(pixel(canvas, OX + W * x, OY + H * y).r).toBe(255);
    }
  });

  it("draws the anchor fainter at idle than under the pointer", () => {
    const faint = pixel(draw("idle"), OX + W / 2, OY + H / 2);
    const full = pixel(draw("hover"), OX + W / 2, OY + H / 2);
    expect(faint.r).toBeGreaterThan(0);
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
