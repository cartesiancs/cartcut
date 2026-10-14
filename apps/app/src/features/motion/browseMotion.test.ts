import { describe, expect, it } from "vitest";
import { springOvershoot, springPosition } from "./spring";
import {
  BROWSE_MOTION,
  BROWSE_MOTION_PROPERTIES,
  SEARCH_SPRING,
  hideStep,
  installBrowseMotion,
  revealStep,
} from "./browseMotion";

/**
 * The switch is a sequence, and each number is there to keep one step from
 * stepping on another. These say which, so a retune that breaks the order
 * fails here rather than looking slightly wrong in the app.
 */
describe("asset browser switch motion", () => {
  // The field's left edge stops at the bar's padding; any overshoot carries
  // it past the tiles' left edge for a few frames.
  it("opens the field without passing its width", () => {
    expect(springOvershoot(SEARCH_SPRING)).toBe(0);
  });

  it("starts the field while the folder is still fading, so the two overlap", () => {
    expect(BROWSE_MOTION.growDelayMs).toBeGreaterThan(0);
    expect(BROWSE_MOTION.growDelayMs).toBeLessThan(BROWSE_MOTION.outMs);
  });

  // The cloud tiles start `revealLeadMs` after the swap, which is `outMs`
  // after the click. By then the field should be well under way, or the
  // tiles arrive under a bar that has not changed yet.
  it("has the field about a third open when the first cloud tile shows", () => {
    const sinceGrow = BROWSE_MOTION.outMs + BROWSE_MOTION.revealLeadMs - BROWSE_MOTION.growDelayMs;
    const open = springPosition(SEARCH_SPRING, sinceGrow / 1000);

    expect(open).toBeGreaterThan(0.25);
    expect(open).toBeLessThan(0.95);
  });

  it("fades the folder back only once the field has mostly closed over it", () => {
    expect(BROWSE_MOTION.inDelayMs).toBeGreaterThan(BROWSE_MOTION.shrinkMs / 2);
    expect(BROWSE_MOTION.inDelayMs).toBeLessThan(BROWSE_MOTION.shrinkMs);
  });

  it("leaves faster than it arrives, so going back is not a wait", () => {
    expect(BROWSE_MOTION.hideMs + BROWSE_MOTION.hideSpreadMs).toBeLessThan(
      BROWSE_MOTION.revealMs + BROWSE_MOTION.revealSpreadMs,
    );
  });

  it("cascades down on the way in and up on the way out", () => {
    expect(revealStep(false).order).toBe("down");
    expect(hideStep(false).order).toBe("up");
  });

  // A tile waiting its turn must already be hidden, or it shows at full
  // strength and blinks out to start; one leaving must stay gone until the
  // swap removes it.
  it("holds the hidden end of each fade through the wait around it", () => {
    expect(revealStep(false).fill).toBe("backwards");
    expect(hideStep(false).fill).toBe("forwards");
  });

  // One keyframe means "from whatever it shows now", which is what lets a
  // tile still arriving leave from where its own fade had got to.
  it("leaves from where each block is rather than from full strength", () => {
    expect(hideStep(false).keyframes).toHaveLength(1);
    expect(hideStep(true).keyframes).toHaveLength(1);
  });

  it("drops the travel and the stagger for reduced motion, and keeps the fade", () => {
    for (const step of [revealStep(true, 80), hideStep(true)]) {
      expect(step.spreadMs).toBe(0);
      expect(step.leadMs).toBe(0);
      expect(step.keyframes.some((frame) => "transform" in frame)).toBe(false);
      expect(step.keyframes.some((frame) => frame.opacity === 0)).toBe(true);
    }
    expect(revealStep(false).keyframes.some((frame) => "transform" in frame)).toBe(true);
  });

  it("hands the stylesheet every name it reads", () => {
    const set: Record<string, string> = {};
    installBrowseMotion({ setProperty: (name, value) => (set[name] = value) });

    expect(Object.keys(set)).toEqual(BROWSE_MOTION_PROPERTIES.map(([name]) => name));
    expect(set["--browse-grow"]).toBe(`${BROWSE_MOTION.growMs}ms`);
    expect(set["--browse-grow-ease"]).toMatch(/^linear\(0, .*, 1\)$/);
  });
});
