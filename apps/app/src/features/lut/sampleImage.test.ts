import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import {
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  drawSampleImage,
} from "./sampleImage";

/**
 * The sample every LUT tile is graded from.
 *
 * The property that matters most is the dullest to state: **it never changes.**
 * A grid of eighty tiles is a comparison, and a comparison whose subject moves
 * is not one — so this suite pins determinism first and content second.
 */

function draw(width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  drawSampleImage(ctx, width, height);
  return {
    canvas,
    pixels: (canvas.getContext("2d") as any).getImageData(
      0,
      0,
      width,
      height,
    ) as ImageData,
  };
}

function at(pixels: ImageData, x: number, y: number) {
  const i = (y * pixels.width + x) * 4;
  return {
    r: pixels.data[i],
    g: pixels.data[i + 1],
    b: pixels.data[i + 2],
    a: pixels.data[i + 3],
  };
}

describe("the sample never changes", () => {
  it("is byte-identical between two calls", () => {
    const a = draw().pixels;
    const b = draw().pixels;
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("is byte-identical after being drawn over something else", () => {
    // The panel reuses one scratch canvas for eighty grades, so the sample is
    // redrawn onto a surface that already holds a graded copy of itself. If it
    // depended on what was underneath — a missing `globalCompositeOperation`
    // reset, a stray `globalAlpha` — every tile after the first would be wrong.
    const canvas = createCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const ctx = canvas.getContext("2d") as any;
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    ctx.globalAlpha = 0.3;
    ctx.globalCompositeOperation = "multiply";
    ctx.setTransform(2, 0, 0, 2, 17, 5);
    drawSampleImage(ctx as CanvasRenderingContext2D, SAMPLE_WIDTH, SAMPLE_HEIGHT);

    expect(
      Array.from(
        (ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT) as ImageData).data,
      ),
    ).toEqual(Array.from(draw().pixels.data));
  });

  it("reads nothing from outside its own arguments", () => {
    // No clock, no randomness, no environment — so a rebuild produces the same
    // panel and a screenshot of it stays comparable across builds.
    const source = drawSampleImage.toString();
    for (const forbidden of ["Date", "Math.random", "performance", "window."]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("what the sample is made of", () => {
  const { pixels } = draw();

  it("is fully opaque everywhere", () => {
    // A transparent pixel would grade as itself and composite as the tile's
    // background, which reads as a LUT that did nothing there.
    for (let i = 3; i < pixels.data.length; i += 4) {
      expect(pixels.data[i]).toBe(255);
    }
  });

  it("runs to true black and true white", () => {
    // The band a matte LUT's lifted black and a high-contrast LUT's clipping
    // are visible in. A ramp that stops short shows neither.
    const y = SAMPLE_HEIGHT - 2;
    expect(at(pixels, 0, y).r).toBeLessThanOrEqual(2);
    expect(at(pixels, SAMPLE_WIDTH - 1, y).r).toBeGreaterThanOrEqual(253);
  });

  it("carries four separable skin tones", () => {
    // The thing a bad grade ruins first, and one swatch cannot show a grade
    // that flatters one complexion and turns another.
    const y = Math.round(SAMPLE_HEIGHT * 0.32) + 4;
    const tones = [0, 1, 2, 3].map(
      (i) => at(pixels, Math.round(SAMPLE_WIDTH * ((i + 0.5) / 6)), y).r,
    );
    for (let i = 1; i < tones.length; i++) {
      expect(tones[i - 1] - tones[i]).toBeGreaterThan(20);
    }
  });

  it("covers a wide spread of hues, not just a ramp", () => {
    // A LUT's hue rotation is invisible on neutrals. Counting distinct hues
    // is how "the chart is actually colourful" stops being an assumption.
    const hues = new Set<number>();
    for (let y = 0; y < SAMPLE_HEIGHT; y += 3) {
      for (let x = 0; x < SAMPLE_WIDTH; x += 3) {
        const { r, g, b } = at(pixels, x, y);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 30) {
          continue;
        }
        let h: number;
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        hues.add(Math.round(h * 6));
      }
    }
    expect(hues.size).toBeGreaterThanOrEqual(8);
  });

  it("scales to another size without leaving gaps", () => {
    // The swatch rows are laid out by rounding boundaries rather than by
    // stepping a width, so no seam of background shows through at any size.
    for (const [w, h] of [
      [96, 54],
      [192, 108],
      [320, 180],
    ]) {
      const { pixels: scaled } = draw(w, h);
      for (let i = 3; i < scaled.data.length; i += 4) {
        expect(scaled.data[i], `${w}x${h}`).toBe(255);
      }
    }
  });
});
