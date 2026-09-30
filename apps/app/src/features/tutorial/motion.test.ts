import { describe, expect, it } from "vitest";
import { springOvershoot } from "../motion/spring";
import {
  CARD_ENTER_SPRING,
  CHECK_MS,
  DONE_FLASH_MS,
  FALLBACK_SETTLE_MS,
  TUTORIAL_MOTION,
  tutorialMotionStyle,
} from "./motion";

describe("tutorial motion", () => {
  // The card arrives next to its target; an overshoot would push the arrow
  // into the thing it points at.
  it("brings the card in without overshooting", () => {
    expect(springOvershoot(CARD_ENTER_SPRING)).toBe(0);
    expect(TUTORIAL_MOTION.enterEase.startsWith("linear(")).toBe(true);
  });

  it("lets the check mark finish inside the flash", () => {
    expect(CHECK_MS).toBeLessThan(DONE_FLASH_MS);
  });

  // Longer than Bootstrap's 150ms tab fade, or switching tabs would throw the
  // card to the fallback for a few frames.
  it("waits out a tab pane's fade before falling back", () => {
    expect(FALLBACK_SETTLE_MS).toBeGreaterThan(150);
  });

  it("hands the stylesheet its numbers", () => {
    expect(tutorialMotionStyle()).toBe(
      `--tutorial-pulse: ${TUTORIAL_MOTION.pulseMs}ms; --tutorial-check: ${CHECK_MS}ms`,
    );
  });
});
