/**
 * Text panel tiles, drawn.
 *
 * `textTile.test.ts` pins the arithmetic; this draws tiles through the same
 * `drawTile` the panel uses, on a real Skia canvas, and looks at the ink. The
 * faces are not registered in node, so every tile draws in the canvas's own
 * fallback: the widths are not the app's, but what is asserted here (nothing
 * before the arrival, no jump at its end, nothing cut off by the well) holds
 * for any face.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType } from "../../@types/timeline";
import { DEFAULT_FONT } from "../font/fontFaces";
import { buildTextPresets, lookPreset, presetFontFiles } from "../font/textPresets";
import { renderText } from "../renderer/text";
import type { TimelineRenderers } from "../renderer/timeline";
import { inkBounds, scene } from "../renderer/testing";
import { TEXT_ANIMATIONS, textAnimationById } from "./textAnimations";
import { tileSpecFor, type TileSpec } from "./textTile";
import { drawTile, measureTileView } from "./textTileDraw";

/** A tile's map holds one text clip, so the text renderer is the whole table. */
const RENDERERS = { text: renderText } as unknown as TimelineRenderers;

const W = 384;
const H = 216;
const HD = { w: 1920, h: 1080 };

const presets = buildTextPresets(
  presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: "ttf",
  })),
);

function draw(spec: TileSpec, timeMs: number) {
  const { canvas } = scene(W, H);
  const surface = canvas as unknown as HTMLCanvasElement;
  const view = measureTileView(surface, spec.element)!;
  drawTile(surface, spec, view, timeMs, RENDERERS);
  return { canvas, ink: inkBounds(canvas) };
}

function animatedSpec(id: string, edit?: (element: TextElementType) => void) {
  const animation = textAnimationById(id)!;
  const look = lookPreset(animation.look, presets, DEFAULT_FONT)!;
  const spec = tileSpecFor(look, animation, HD);
  edit?.(spec.element);
  return { animation, spec };
}

describe("an animated tile", () => {
  it("is empty before its text arrives, and full once it has", () => {
    // Handed two instants, the two must disagree, or this suite would pass
    // against a painter that drew nothing at all.
    const { animation, spec } = animatedSpec("letter-rise");
    expect(draw(spec, 0).ink.count).toBe(0);
    expect(draw(spec, animation.inMs).ink.count).toBeGreaterThan(200);
  });

  it("does not jump on the last instant of its arrival", () => {
    // The same arrival with and without `settle`: without it the tail is
    // still in flight a moment before the end and settled at the end, so the
    // two frames differ by a jump; with it they are one picture.
    // 20ms short of the end: the lanes are baked at 240Hz and read by nearest
    // sample, so anything closer reads the final sample itself.
    const shift = (spec: TileSpec, inMs: number) => {
      const before = draw(spec, inMs - 20).ink;
      const after = draw(spec, inMs).ink;
      return Math.abs(before.maxY - after.maxY) + Math.abs(before.count - after.count) / 50;
    };

    const settled = animatedSpec("letter-rise");
    const unsettled = animatedSpec("letter-rise", (element) => {
      delete (element.reveal!.animate as { settle?: true }).settle;
    });

    expect(shift(unsettled.spec, unsettled.animation.inMs)).toBeGreaterThan(5);
    expect(shift(settled.spec, settled.animation.inMs)).toBeLessThan(2);
  });

  it("is empty again on the last frame of an exit", () => {
    const { spec } = animatedSpec("rise-and-sink");
    const last = spec.loop![spec.loop!.length - 1].from;
    expect(draw(spec, 1500).ink.count).toBeGreaterThan(200);
    expect(draw(spec, last).ink.count).toBe(0);
  });

  it("shows something at rest, for every animation", () => {
    for (const animation of TEXT_ANIMATIONS) {
      const { spec } = animatedSpec(animation.id);
      expect(draw(spec, spec.restMs).ink.count, animation.id).toBeGreaterThan(0);
    }
  });
});

describe("every tile at rest", () => {
  it("fits its settled text inside the well", () => {
    const settled = [
      ...presets.map((preset) => ({ id: preset.id, spec: tileSpecFor(preset, null, HD), at: 0 })),
      ...TEXT_ANIMATIONS.map((animation) => {
        const { spec } = animatedSpec(animation.id);
        return { id: animation.id, spec, at: spec.loop![0].to };
      }),
    ];

    for (const { id, spec, at } of settled) {
      const { ink } = draw(spec, at);
      expect(ink.count, id).toBeGreaterThan(0);
      expect(ink.minX, id).toBeGreaterThan(0);
      expect(ink.minY, id).toBeGreaterThan(0);
      expect(ink.maxX, id).toBeLessThan(W - 1);
      expect(ink.maxY, id).toBeLessThan(H - 1);
    }
  });
});
