import { describe, expect, it } from "vitest";
import { springOvershoot, springPosition } from "./spring";
import {
  HOVER_EXIT_MS,
  HOVER_FADE_MS,
  HOVER_FROM,
  HOVER_MOTION,
  HOVER_MOTION_PROPERTIES,
  HOVER_SPRING,
  installHoverMotion,
} from "./hoverSpring";

/**
 * Each number in `hoverSpring.ts` was picked for a reason about the tiles, so
 * the reasons are stated here rather than left in a comment nothing checks.
 */
describe("asset tile hover motion", () => {
  it("overshoots, or the spring is a fade with a scale attached", () => {
    expect(springOvershoot(HOVER_SPRING)).toBeGreaterThan(0.05);
  });

  // The band is inset 0 on a tile between 60px and 200px across, and the tiles
  // clip, so the overshoot is the one part of the motion that is paid for in
  // curve rather than in pixels. It still has to be a bounce and not a jump:
  // a peak the tile has to swallow whole reads as a scale that overshot and
  // was cut off.
  it("keeps the overshoot to a bounce rather than a jump", () => {
    const peak = 1 + springOvershoot(HOVER_SPRING) * (1 - HOVER_FROM);

    expect(peak).toBeGreaterThan(1.005);
    expect(peak).toBeLessThan(1.025);
  });

  // A pointer crossing a grid rests on a tile for a moment at a time. A spring
  // still visibly settling when the next one starts reads as lag.
  it("settles in about the time a pointer spends on one tile", () => {
    expect(HOVER_MOTION.enterMs).toBeLessThan(320);
  });

  it("lights the tile well before the scale has settled", () => {
    expect(HOVER_FADE_MS).toBeLessThan(HOVER_MOTION.enterMs);

    const travelled = springPosition(HOVER_SPRING, HOVER_FADE_MS / 1000);
    expect(travelled).toBeGreaterThan(0.9);
  });

  it("leaves faster than it arrives", () => {
    expect(HOVER_EXIT_MS).toBeLessThan(HOVER_MOTION.enterMs);
  });

  // The easing is a list of samples, and `linear()` reads the first and last as
  // the endpoints. Either one off its value and the scale jumps on the frame
  // the transition starts or ends.
  it("pins the easing to its endpoints, with the overshoot inside it", () => {
    const points = HOVER_MOTION.enterEase
      .replace(/^linear\(|\)$/g, "")
      .split(", ")
      .map(Number);

    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1);
  });

  describe("the install", () => {
    const record = () => {
      const written = new Map<string, string>();
      return {
        written,
        port: { setProperty: (n: string, v: string) => void written.set(n, v) },
      };
    };

    it("writes every number in the table, and only those", () => {
      const { written, port } = record();
      installHoverMotion(port);

      expect(written.size).toBe(HOVER_MOTION_PROPERTIES.length);
      expect(written.get("--asset-hover-from")).toBe(String(HOVER_FROM));
      expect(written.get("--asset-hover-enter")).toBe(`${HOVER_MOTION.enterMs}ms`);
      expect(written.get("--asset-hover-fade")).toBe(`${HOVER_FADE_MS}ms`);
      expect(written.get("--asset-hover-exit")).toBe(`${HOVER_EXIT_MS}ms`);
      expect(written.get("--asset-hover-ease")).toMatch(/^linear\(/);
    });

    // Every name the stylesheet reads is `--asset-hover-*`. A property written
    // under any other prefix is a value the CSS silently falls back on.
    it("names every property for the stylesheet that reads them", () => {
      for (const [name] of HOVER_MOTION_PROPERTIES) {
        expect(name.startsWith("--asset-hover-")).toBe(true);
      }
    });
  });
});
