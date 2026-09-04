/**
 * What the preset tiles show.
 *
 * The claim under test is not "these numbers are right" — it is that the tile
 * cannot show something the preset does not do. `previewSamples` runs the real
 * `applyPreset` and reads it back through the real `localSampleAt`, so a change
 * to a preset's curve moves the thumbnail with it and neither can be edited
 * into disagreeing with the other. These assertions pin that the chain is
 * actually connected, which is the only part a reader cannot see by looking.
 */

import { describe, it, expect } from "vitest";
import {
  PREVIEW_BOX,
  PREVIEW_STEPS,
  previewSamples,
} from "./presetPreview";
import { presetNames, type PresetName } from "./presets";

const first = (preset: PresetName) => previewSamples(preset)[0];
const last = (preset: PresetName) =>
  previewSamples(preset)[PREVIEW_STEPS - 1];

describe("previewSamples", () => {
  it("gives every preset the same number of steps", () => {
    for (const name of presetNames()) {
      expect(previewSamples(name), name).toHaveLength(PREVIEW_STEPS);
    }
  });

  it("honours a step count the caller asks for", () => {
    expect(previewSamples("fade_in", 5)).toHaveLength(5);
  });

  it("moves in every preset, so no tile is a still picture", () => {
    // Against the *first* frame rather than between the endpoints: `shake`
    // returns to where it started by design, and comparing ends would call the
    // one preset that is nothing but movement static.
    for (const name of presetNames()) {
      const samples = previewSamples(name);
      const a = samples[0];
      const moved = samples.some(
        (b) =>
          a.x !== b.x ||
          a.y !== b.y ||
          a.scale !== b.scale ||
          a.rotationDeg !== b.rotationDeg ||
          a.opacity !== b.opacity,
      );
      expect(moved, name).toBe(true);
    }
  });

  it("returns finite numbers throughout, whatever the curve does", () => {
    // `overshoot` and `anticipate` leave the range between their anchors on
    // purpose. Leaving the number line is a different thing.
    for (const name of presetNames()) {
      for (const sample of previewSamples(name)) {
        for (const [key, value] of Object.entries(sample)) {
          expect(Number.isFinite(value), `${name}.${key}`).toBe(true);
        }
      }
    }
  });

  it("memoises, so a panel of tiles pays for each preset once", () => {
    expect(previewSamples("fade_in")).toBe(previewSamples("fade_in"));
  });

  it("does not memoise an explicit step count over the default", () => {
    expect(previewSamples("fade_in", 5)).not.toBe(previewSamples("fade_in"));
  });

  // ------------------------------------------------ the chain is really wired

  it("reads fade_in's opacity all the way from 0 to 100", () => {
    expect(first("fade_in").opacity).toBe(0);
    expect(last("fade_in").opacity).toBe(100);
  });

  it("reads fade_out the other way", () => {
    expect(first("fade_out").opacity).toBe(100);
    expect(last("fade_out").opacity).toBe(0);
  });

  it("reports scale as a multiplier, not in the tenths the track stores", () => {
    // `localSampleAt` divides by 10. A tile that drew the raw track value would
    // render every zoom at ten times its size.
    expect(first("zoom_in").scale).toBeCloseTo(1, 9);
    expect(last("zoom_in").scale).toBeCloseTo(1.2, 9);
  });

  it("carries rotation in degrees", () => {
    expect(first("rotate_settle").rotationDeg).toBe(-7);
    expect(last("rotate_settle").rotationDeg).toBe(0);
  });

  it("comes to rest at the origin for the in-slides", () => {
    for (const name of ["slide_in_up", "slide_in_down", "slide_in_left", "slide_in_right"] as const) {
      const end = last(name);
      expect(end.x, name).toBe(0);
      expect(end.y, name).toBe(0);
    }
  });

  it("starts at the origin for the out-slides", () => {
    for (const name of ["slide_out_up", "slide_out_down", "slide_out_left", "slide_out_right"] as const) {
      const start = first(name);
      expect(start.x, name).toBe(0);
      expect(start.y, name).toBe(0);
    }
  });

  it("travels one box length, so the tile can scale by its own size", () => {
    // The offsets are in the units of `PREVIEW_BOX`, which is what lets a tile
    // of any size multiply through without knowing anything about the preset.
    expect(first("slide_in_up").y).toBe(PREVIEW_BOX);
    expect(first("slide_in_down").y).toBe(-PREVIEW_BOX);
    expect(first("slide_in_left").x).toBe(PREVIEW_BOX);
    expect(first("slide_in_right").x).toBe(-PREVIEW_BOX);
  });

  it("keeps shake inside the box rather than flinging it off the tile", () => {
    for (const sample of previewSamples("shake")) {
      expect(Math.abs(sample.x)).toBeLessThan(PREVIEW_BOX);
    }
  });

  it("answers an empty list for a preset that does not exist", () => {
    expect(previewSamples("spin" as PresetName)).toEqual([]);
  });
});
