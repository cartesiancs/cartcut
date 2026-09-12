import { describe, it, expect } from "vitest";
import { backdropOf, frostBackdrop } from "./backdrop";
import { pixel, scene } from "./testing";

/**
 * `frostBackdrop` on its own: what it draws, and every way it declines.
 *
 * The declines are the interesting half. A backdrop blur that cannot be applied
 * has to leave the frame exactly as it found it and say so — the contract a LUT
 * that is not installed already has — because the alternative is a region of
 * frame filled with something misaligned or empty, which reads as a rendering
 * bug in whatever element happens to be underneath.
 */

const SIZE = 120;
const EDGE = 60;

/** A canvas with a sharp red/blue step down the middle. */
function stepped(size = SIZE) {
  const { canvas, ctx } = scene(size, size);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, size / 2, size);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(size / 2, 0, size / 2, size);
  return { canvas, ctx };
}

const box =
  (x: number, y: number, w: number, h: number) =>
  (ctx: CanvasRenderingContext2D) => {
    ctx.rect(x, y, w, h);
    return true;
  };

/** Pixels on row `y` that hold a mix of the two solids. */
function mixed(canvas: ReturnType<typeof scene>["canvas"], y: number): number {
  const d = canvas.getContext("2d").getImageData(0, y, canvas.width, 1).data;
  let count = 0;
  for (let x = 0; x < canvas.width; x += 1) {
    const r = d[x * 4];
    const b = d[x * 4 + 2];
    if (r > 20 && r < 235 && b > 20 && b < 235) {
      count += 1;
    }
  }
  return count;
}

describe("frostBackdrop", () => {
  it("blurs the backdrop inside the traced region and nowhere else", () => {
    const { canvas, ctx } = stepped();

    expect(
      frostBackdrop(ctx, backdropOf(ctx), 8, box(20, 40, 80, 40)),
    ).toBe(true);

    // Inside the region the step is a ramp; two rows above it, still a step.
    expect(mixed(canvas, 60)).toBeGreaterThan(10);
    expect(mixed(canvas, 20)).toBe(0);
    // And the far edges of the frame keep their own colour.
    expect(pixel(canvas, 2, 60).r).toBe(255);
    expect(pixel(canvas, SIZE - 2, 60).b).toBe(255);
  });

  it("pulls colour in from outside the region", () => {
    // The whole backdrop is blitted through the blur and clipped, rather than a
    // crop of it being blurred: a crop's own edge would blur against nothing and
    // leave a seam just inside the region. So the first pixel inside the left
    // edge of a region that sits wholly in the red half must still be pure red,
    // not red fading into transparency.
    const { canvas, ctx } = stepped();
    frostBackdrop(ctx, backdropOf(ctx), 8, box(10, 40, 30, 40));

    const inside = pixel(canvas, 11, 60);
    expect([inside.r, inside.g, inside.b, inside.a]).toEqual([255, 0, 0, 255]);
  });

  it("declines with no backdrop, and leaves the frame alone", () => {
    const { canvas, ctx } = stepped();
    const before = Buffer.from(
      canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data,
    );

    expect(frostBackdrop(ctx, null, 8, box(20, 40, 80, 40))).toBe(false);
    expect(frostBackdrop(ctx, undefined, 8, box(20, 40, 80, 40))).toBe(false);

    expect(
      Buffer.from(canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(before);
  });

  it("declines on a blur of zero or less", () => {
    const { ctx } = stepped();
    for (const blur of [0, -4, Number.NaN]) {
      expect(frostBackdrop(ctx, backdropOf(ctx), blur, box(20, 40, 80, 40))).toBe(
        false,
      );
    }
  });

  it("declines when the backdrop is a different size", () => {
    // The blit is at identity, so a backdrop on another grid would land out of
    // register — a worse failure than not frosting.
    const { canvas, ctx } = stepped();
    const other = stepped(SIZE / 2);
    const before = Buffer.from(
      canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data,
    );

    expect(
      frostBackdrop(ctx, { canvas: other.canvas }, 8, box(20, 40, 80, 40)),
    ).toBe(false);
    expect(
      Buffer.from(canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(before);
  });

  it("declines when the region traces nothing", () => {
    const { canvas, ctx } = stepped();
    const before = Buffer.from(
      canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data,
    );

    expect(frostBackdrop(ctx, backdropOf(ctx), 8, () => false)).toBe(false);
    expect(
      Buffer.from(canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(before);
  });

  it("declines under a degenerate transform", () => {
    // A clip scaled to nothing: the device radius would be zero, and the matrix
    // has no scale to convert through. `shadow.ts` guards the same case.
    const { ctx } = stepped();
    ctx.scale(0, 0);
    expect(frostBackdrop(ctx, backdropOf(ctx), 8, box(20, 40, 80, 40))).toBe(
      false,
    );
  });

  it("scales the radius through the transform", () => {
    // Element pixels in, device pixels out. At 2x the ramp is twice as wide, so
    // the preview's zoom and the export's 1:1 draw the same picture.
    const ramp = (scale: number) => {
      const { canvas, ctx } = stepped(SIZE * scale);
      ctx.scale(scale, scale);
      frostBackdrop(ctx, backdropOf(ctx), 6, box(0, 0, SIZE, SIZE));
      return mixed(canvas, (SIZE / 2) * scale);
    };

    const one = ramp(1);
    expect(one).toBeGreaterThan(8);
    expect(Math.abs(ramp(2) - one * 2)).toBeLessThanOrEqual(3);
  });

  it("leaves no filter behind on the context", () => {
    // `filter` is context state, and a leaked `blur()` would soften every later
    // draw on the frame — the next clip, the selection outline, everything.
    const { ctx } = stepped();
    frostBackdrop(ctx, backdropOf(ctx), 8, box(20, 40, 80, 40));

    expect(ctx.filter).toBe("none");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 10, 10);
    expect(pixel(ctx.canvas as never, 5, 5).g).toBe(255);
  });

  it("restores the transform and the clip it was given", () => {
    // It resets to identity to blit, so anything it does not put back would
    // misplace the caller's next draw — the band's own colour, in `renderText`.
    const { canvas, ctx } = stepped();
    ctx.translate(30, 30);
    const before = ctx.getTransform();

    frostBackdrop(ctx, backdropOf(ctx), 8, box(0, 0, 40, 40));

    const after = ctx.getTransform();
    expect([after.a, after.d, after.e, after.f]).toEqual([
      before.a,
      before.d,
      before.e,
      before.f,
    ]);
    // The clip is gone with the save, so this fill lands in full.
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(60, 60, 10, 10);
    expect(pixel(canvas, 95, 95).g).toBe(255);
  });
});
