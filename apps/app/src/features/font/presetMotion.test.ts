import { describe, expect, it } from "vitest";
import { springOvershoot, springPosition } from "../onboarding/spring";
import {
  PRESET_HOVER_EXIT_MS,
  PRESET_HOVER_FADE_MS,
  PRESET_HOVER_FROM,
  PRESET_HOVER_MOTION,
  PRESET_HOVER_SPRING,
  presetHoverMotionStyle,
} from "./presetMotion";

/**
 * Each number in `presetMotion.ts` was picked for a reason about the panel, so
 * the reasons are stated here rather than left in a comment nothing checks.
 */
describe("text preset hover motion", () => {
  it("overshoots, or the spring is a fade with a scale attached", () => {
    expect(springOvershoot(PRESET_HOVER_SPRING)).toBeGreaterThan(0.05);
  });

  // The band is inset 0 on a tile roughly 130x100, so the overshoot is the
  // only part of the motion that leaves the tile's own box and grows into the
  // gap beside its neighbour. A couple of pixels is a bounce; ten is a tile
  // that looks mis-sized for a frame.
  it("keeps the overshoot to a bounce rather than a jump", () => {
    const peak = 1 + springOvershoot(PRESET_HOVER_SPRING) * (1 - PRESET_HOVER_FROM);

    expect(peak).toBeGreaterThan(1.005);
    expect(peak).toBeLessThan(1.025);
  });

  // A pointer crossing the grid rests on a tile for a moment at a time. A
  // spring still visibly settling when the next one starts reads as lag.
  it("settles in about the time a pointer spends on one tile", () => {
    expect(PRESET_HOVER_MOTION.enterMs).toBeLessThan(320);
  });

  it("lights the tile well before the scale has settled", () => {
    expect(PRESET_HOVER_FADE_MS).toBeLessThan(PRESET_HOVER_MOTION.enterMs);

    const travelled = springPosition(PRESET_HOVER_SPRING, PRESET_HOVER_FADE_MS / 1000);
    expect(travelled).toBeGreaterThan(0.9);
  });

  it("leaves faster than it arrives", () => {
    expect(PRESET_HOVER_EXIT_MS).toBeLessThan(PRESET_HOVER_MOTION.enterMs);
  });

  it("hands every number to CSS", () => {
    const style = presetHoverMotionStyle();

    expect(style).toContain(`--preset-hover-from: ${PRESET_HOVER_FROM}`);
    expect(style).toContain(`--preset-hover-enter: ${PRESET_HOVER_MOTION.enterMs}ms`);
    expect(style).toContain(`--preset-hover-fade: ${PRESET_HOVER_FADE_MS}ms`);
    expect(style).toContain(`--preset-hover-exit: ${PRESET_HOVER_EXIT_MS}ms`);
    expect(style).toContain("--preset-hover-ease: linear(");
  });

  // The easing is a list of samples, and `linear()` reads the first and last as
  // the endpoints. Either one off its value and the scale jumps on the frame
  // the transition starts or ends.
  it("pins the easing to its endpoints, with the overshoot inside it", () => {
    const points = PRESET_HOVER_MOTION.enterEase
      .replace(/^linear\(|\)$/g, "")
      .split(", ")
      .map(Number);

    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1);
  });
});
