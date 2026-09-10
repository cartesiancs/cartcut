import { describe, it, expect } from "vitest";
import { renderControlOutline } from "./controlOutline";
import { scene, pixel } from "./testing";

/**
 * The box the outline is drawn around. Chosen so nothing it draws leaves the
 * canvas — the rotation knob sits 50px above `y` and is 15 across, which is why
 * `y` is 80.
 */
const X = 40;
const Y = 80;
const W = 100;
const H = 60;

function outline(background: string, style?: { casing?: string }) {
  const { canvas, ctx } = scene(220, 200, background);
  renderControlOutline(ctx, X, Y, W, H, style);
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

    // Just outside the top edge stroke, between the corner grip and the N bar.
    expect(pixel(canvas, 70, Y - 3).r).toBeCloseTo(RIM_ON_WHITE, -1);
    // Just outside the NW corner grip.
    expect(pixel(canvas, 29, Y).r).toBeCloseTo(RIM_ON_WHITE, -1);
    // Just outside the rotation knob, which is the mark furthest from the box.
    expect(pixel(canvas, X + W / 2, Y - 50 - 16).r).toBeCloseTo(
      RIM_ON_WHITE,
      -1,
    );
    // Just outside the E edge bar, the mark that says one axis resizes.
    expect(pixel(canvas, X + W + 3, Y + H / 2).r).toBeCloseTo(RIM_ON_WHITE, -1);
  });

  it("leaves the marks themselves white, and the same size", () => {
    const canvas = outline("#ffffff");

    // Inside the corner grip, and inside the knob.
    expect(pixel(canvas, X - 5, Y).r).toBe(255);
    expect(pixel(canvas, X + W / 2, Y - 50).r).toBe(255);
    // The rim is bounded: a couple of pixels further out is untouched backdrop.
    expect(pixel(canvas, X - 14, Y).r).toBe(255);
    expect(pixel(canvas, 70, Y - 6).r).toBe(255);
  });

  it("still draws white marks over a dark backdrop", () => {
    const canvas = outline("#101020");

    // The knob's centre — the pixel `timeline.test.ts` reads to decide the
    // outline is on at all.
    expect(pixel(canvas, X + W / 2, Y - 50)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(pixel(canvas, X - 5, Y)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("draws nothing dark when the casing is suppressed", () => {
    const canvas = outline("#ffffff", { casing: "transparent" });

    expect(pixel(canvas, 70, Y - 3).r).toBe(255);
    expect(pixel(canvas, 29, Y).r).toBe(255);
    // And the mark is still there.
    expect(pixel(canvas, X - 5, Y).r).toBe(255);
  });

  /**
   * A box too narrow for edge bars must not sprout a casing where no bar is
   * drawn — the two passes read the *ungrown* length for exactly this.
   */
  it("suppresses a bar's casing wherever the bar itself is suppressed", () => {
    const { canvas, ctx } = scene(220, 200, "#ffffff");
    // 20 wide: `barLength` returns 20 - 26 < 0, so the N and S bars decline.
    renderControlOutline(ctx, 100, 100, 20, 60);

    // Midway along the top edge, outside the box stroke and its rim: if a
    // casing had been drawn for the absent bar it would land here.
    expect(pixel(canvas, 110, 95).r).toBe(255);
  });
});
