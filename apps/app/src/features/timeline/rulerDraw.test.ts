import { describe, expect, it } from "vitest";
import { RULER_HEIGHT_PX, defaultRulerColors, drawRuler } from "./rulerDraw";
import { planRulerTicks, type RulerPlan } from "./rulerTicks";
import { defaultColors } from "./draw";
import { pixel, scene } from "../renderer/testing";

const W = 400;
const H = RULER_HEIGHT_PX;

/** `#rrggbb` to channels. */
function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function paint(playheadX: number, plan?: RulerPlan) {
  const { canvas, ctx } = scene(W, H);
  drawRuler(ctx, {
    plan: plan ?? planRulerTicks({ range: 0.9, hScroll: 0, width: W, fps: 60 }),
    width: W,
    height: H,
    playheadX,
  });
  return canvas;
}

/** Columns on `row` painted in the playhead's colour. */
function headColumns(canvas: ReturnType<typeof paint>, row: number) {
  const want = rgb(defaultColors.playhead);
  const columns: number[] = [];
  for (let x = 0; x < W; x++) {
    const p = pixel(canvas, x, row);
    if (p.r === want.r && p.g === want.g && p.b === want.b) {
      columns.push(x);
    }
  }
  return columns;
}

describe("drawRuler", () => {
  it("keeps the timeline's background", () => {
    // Between two ticks and above them, where nothing but the band is drawn.
    const canvas = paint(-100);
    expect(pixel(canvas, 30, 2)).toEqual({ ...rgb(defaultColors.background), a: 255 });
    expect(defaultRulerColors.band).toBe(defaultColors.background);
  });

  it("draws its labels in the muted grey, never brighter", () => {
    // `strokeText` in white left pixels near 255 across every label; a filled
    // label in `#7f878f` cannot exceed its own colour anywhere.
    const canvas = paint(-100);
    const label = rgb(defaultRulerColors.label);
    const band = rgb(defaultRulerColors.band);
    let ink = 0;
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < 15; y++) {
        const p = pixel(canvas, x, y);
        expect(p.r).toBeLessThanOrEqual(label.r + 1);
        expect(p.g).toBeLessThanOrEqual(label.g + 1);
        expect(p.b).toBeLessThanOrEqual(label.b + 1);
        if (p.r !== band.r || p.g !== band.g || p.b !== band.b) ink++;
      }
    }
    // And there is text there to measure, or the bound above proves nothing.
    expect(ink).toBeGreaterThan(50);
  });

  it("stands its ticks on the hairline, a labelled one taller", () => {
    const plan: RulerPlan = {
      ticks: [
        { x: 100, ms: 0, major: true, label: "0s" },
        { x: 200, ms: 1, major: false },
      ],
      stepMs: 1,
      majorEvery: 2,
    };
    const canvas = paint(-100, plan);
    const band = rgb(defaultRulerColors.band);
    const lit = (x: number, y: number) => pixel(canvas, x, y).r > band.r;

    // Five px above the hairline: the major reaches it, the minor does not.
    expect(lit(100, H - 6)).toBe(true);
    expect(lit(200, H - 6)).toBe(false);
    expect(lit(200, H - 3)).toBe(true);
    // Nothing between them but the hairline itself.
    expect(lit(150, H - 3)).toBe(false);
    expect(lit(150, H - 1)).toBe(true);
  });

  it("centres the playhead head on the line it names", () => {
    for (const x of [120, 250.5]) {
      const columns = headColumns(paint(x), H - 9);
      expect(columns.length).toBeGreaterThan(6);
      const centre = (columns[0] + columns[columns.length - 1] + 1) / 2;
      expect(Math.abs(centre - x)).toBeLessThanOrEqual(0.5);
    }
  });

  it("narrows the head to the 2px line at the bottom edge", () => {
    const columns = headColumns(paint(120), H - 1);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.length).toBeLessThanOrEqual(3);
  });

  it("moves the head with the playhead, and drops it off screen", () => {
    expect(headColumns(paint(120), H - 9)).not.toEqual(
      headColumns(paint(300), H - 9),
    );
    expect(headColumns(paint(-100), H - 9)).toEqual([]);
    expect(headColumns(paint(W + 100), H - 9)).toEqual([]);
    expect(headColumns(paint(Number.NaN), H - 9)).toEqual([]);
  });
});
