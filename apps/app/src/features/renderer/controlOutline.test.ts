import { describe, it, expect } from "vitest";
import {
  GRIP_PX,
  KNOB_OFFSET_PX,
  KNOB_RADIUS_PX,
  LINE_WIDTH_PX,
  RIM_PX,
  renderControlOutline,
} from "./controlOutline";
import { scene, pixel } from "./testing";
import {
  HANDLE_PADDING_PX,
  ROTATION_HANDLE_HALF_WIDTH_PX,
  ROTATION_HANDLE_HEIGHT_PX,
  hitZoneOf,
  isStretchZone,
} from "../preview/hitTest";

/**
 * Drawn at four units to the screen pixel, so every mark is several pixels wide
 * and no assertion below lands on an antialiased half pixel. The box sits low
 * enough that the knob, `KNOB_OFFSET_PX * U` above it, stays on the canvas.
 */
const U = 4;
const X = 80;
const Y = 140;
const W = 120;
const H = 80;

const grip = GRIP_PX * U;
const rim = RIM_PX * U;
const halfLine = (LINE_WIDTH_PX * U) / 2;
const knobY = Y - KNOB_OFFSET_PX * U;
const knobR = KNOB_RADIUS_PX * U;
const halfBar = (GRIP_PX * 0.6 * U) / 2;

function outline(background: string, style?: { casing?: string }) {
  const { canvas, ctx } = scene(300, 300, background);
  renderControlOutline(ctx, X, Y, W, H, { ...style, unit: U });
  return canvas;
}

/** Black at 62% over white. The rim's expected value, give or take rounding. */
const RIM_ON_WHITE = 97;

describe("renderControlOutline", () => {
  /**
   * The whole point of the casing: on a white clip the white mark and the white
   * backdrop are the same pixels, so the only thing that can say where the
   * element ends is the darker rim around them.
   */
  it("puts a dark rim around every mark on a white backdrop", () => {
    const canvas = outline("#ffffff");
    const inRim = (edge: number) => Math.floor(edge + rim / 2);

    // Just outside the top edge stroke, between the corner grip and the N bar.
    expect(pixel(canvas, X + 25, Y - inRim(halfLine) - 1).r).toBeCloseTo(
      RIM_ON_WHITE,
      -1,
    );
    // Just outside the NW corner grip.
    expect(pixel(canvas, X - inRim(grip) - 1, Y).r).toBeCloseTo(RIM_ON_WHITE, -1);
    // Just outside the rotation knob, which is the mark furthest from the box.
    expect(pixel(canvas, X + W / 2, knobY - inRim(knobR) - 1).r).toBeCloseTo(
      RIM_ON_WHITE,
      -1,
    );
    // Just outside the E edge bar, the mark that says one axis resizes.
    expect(pixel(canvas, X + W + inRim(halfBar), Y + H / 2).r).toBeCloseTo(
      RIM_ON_WHITE,
      -1,
    );
  });

  it("leaves the marks themselves white, and the same size", () => {
    const canvas = outline("#ffffff");

    // Inside the corner grip, and inside the knob.
    expect(pixel(canvas, X - grip / 2, Y).r).toBe(255);
    expect(pixel(canvas, X + W / 2, knobY).r).toBe(255);
    // The rim is bounded: a couple of pixels further out is untouched backdrop.
    expect(pixel(canvas, X - grip - rim - 3, Y).r).toBe(255);
    expect(pixel(canvas, X + 25, Y - halfLine - rim - 3).r).toBe(255);
  });

  it("still draws white marks over a dark backdrop", () => {
    const canvas = outline("#101020");

    // The knob's centre, the pixel `timeline.test.ts` reads to decide the
    // outline is on at all.
    expect(pixel(canvas, X + W / 2, knobY)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(pixel(canvas, X - grip / 2, Y)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("draws nothing dark when the casing is suppressed", () => {
    const canvas = outline("#ffffff", { casing: "transparent" });

    expect(pixel(canvas, X + 25, Y - halfLine - 1).r).toBe(255);
    expect(pixel(canvas, X - grip - 1, Y).r).toBe(255);
    // And the mark is still there.
    expect(pixel(canvas, X - grip / 2, Y).r).toBe(255);
  });

  /**
   * A box too narrow for edge bars must not sprout a casing where no bar is
   * drawn: the two passes read the *ungrown* length for exactly this.
   */
  it("suppresses a bar's casing wherever the bar itself is suppressed", () => {
    const { canvas, ctx } = scene(300, 300, "#ffffff");
    // 40 wide: the bar would be 40 - 2.6 * grip = -1.6 long, and grown by the
    // rim on both ends that is +4.4, so a casing pass that read the grown size
    // would put a dark sliver in the gap between the two corner grips.
    renderControlOutline(ctx, 100, 100, 40, 60, { unit: U });

    // In that gap, above the top stroke's rim and inside where the sliver
    // would be.
    expect(pixel(canvas, 120, 100 - halfLine - rim - 1).r).toBe(255);
  });
});

describe("the outline is the same size on screen at every zoom", () => {
  /**
   * The same box, on screen at the same place, through a preview zoomed to
   * `zoom`: the context is scaled, the box is given in the scaled space, and
   * `unit` cancels the scale out for the marks.
   */
  function atZoom(zoom: number, unit = 1 / zoom) {
    const { canvas, ctx } = scene(300, 300, "#101020");
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);
    renderControlOutline(ctx, X / zoom, Y / zoom, W / zoom, H / zoom, { unit });
    return canvas.getContext("2d").getImageData(0, 0, 300, 300).data;
  }

  /** How many pixels of two renders differ by more than antialiasing does. */
  function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8) {
        n++;
      }
    }
    return n;
  }

  it("draws the same pixels zoomed out, at 100% and zoomed in", () => {
    const base = atZoom(1);
    expect(differing(atZoom(0.5), base)).toBe(0);
    expect(differing(atZoom(2), base)).toBe(0);
  });

  it("would not, with the marks left in the zoomed space", () => {
    // Proves the comparison above can fail: a unit that ignores the zoom grows
    // every mark with it, which is the bug this module used to have.
    const base = atZoom(1);
    expect(differing(atZoom(2, 1), base)).toBeGreaterThan(100);
  });
});

describe("every mark sits on the zone that grabs it", () => {
  /**
   * The outline and `hitZoneOf` are two descriptions of one thing. Checked at a
   * scale well below and well above 1, since a disagreement that only shows at
   * one zoom is the kind this used to have.
   */
  const SCALES = [0.25, 1, 4];
  const BW = 400;
  const BH = 300;

  it("keeps the knob, all of it, inside the rotation zone", () => {
    expect(KNOB_RADIUS_PX).toBeLessThan(ROTATION_HANDLE_HALF_WIDTH_PX);
    expect(KNOB_OFFSET_PX + KNOB_RADIUS_PX).toBeLessThan(ROTATION_HANDLE_HEIGHT_PX);

    for (const scale of SCALES) {
      const centre = { x: BW / 2, y: -KNOB_OFFSET_PX / scale };
      const top = { x: BW / 2, y: -(KNOB_OFFSET_PX + KNOB_RADIUS_PX) / scale };
      const bottom = { x: BW / 2, y: -(KNOB_OFFSET_PX - KNOB_RADIUS_PX) / scale };
      for (const point of [centre, top, bottom]) {
        expect(hitZoneOf(point, BW, BH, { worldScale: scale })).toBe("rotation");
      }
    }
  });

  it("keeps every corner grip inside the band that resizes from it", () => {
    expect(GRIP_PX + RIM_PX).toBeLessThanOrEqual(HANDLE_PADDING_PX);

    for (const scale of SCALES) {
      // The grip's outer corner, the point of it furthest from the box.
      const reach = (GRIP_PX + RIM_PX) / scale;
      expect(
        hitZoneOf({ x: -reach, y: -reach }, BW, BH, { worldScale: scale }),
      ).toBe("stretchNW");
      expect(
        hitZoneOf({ x: BW + reach, y: BH + reach }, BW, BH, { worldScale: scale }),
      ).toBe("stretchSE");
      // And the edge bar's outer face.
      expect(
        isStretchZone(
          hitZoneOf({ x: BW / 2, y: -reach }, BW, BH, { worldScale: scale }),
        ),
      ).toBe(true);
    }
  });
});
