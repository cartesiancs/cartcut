import { describe, expect, it } from "vitest";
import {
  ART_RISE_PX,
  ART_RISE_SPRING,
  ART_SLIDE_PX,
  ART_SLIDE_SPRING,
  BUTTON_MORPH_SPRING,
  BUTTON_WIDTH_PX,
  CARD_GUTTER_PX,
  FADE_MS,
  TITLE_BOTTOM_PX,
  ONBOARDING_MOTION,
  WIDE_BUTTON_WIDTH_PX,
  onboardingMotionStyle,
} from "./motion";
import { ONBOARDING_CARD, ONBOARDING_STEPS } from "./steps";
import { springOvershoot, springPosition } from "./spring";

describe("onboarding motion", () => {
  // Each of the three springs was chosen for a reason that is a fact about the
  // card, so each reason is stated here rather than left in a comment.
  describe("the reasons the springs were picked", () => {
    it("bounces the rise by enough pixels to see", () => {
      const bounce = springOvershoot(ART_RISE_SPRING) * ART_RISE_PX;

      expect(bounce).toBeGreaterThan(6);
    });

    // The rise overshoots upwards, and the art it carries starts 133px down.
    // Far enough and the picture would jump into the title above it.
    it("keeps the rise's overshoot clear of the title", () => {
      const rising = ONBOARDING_STEPS.find((step) => step.art.enter === "bottom");
      expect(rising, "no step rises").toBeTruthy();

      const bounce = springOvershoot(ART_RISE_SPRING) * ART_RISE_PX;
      const highestTop = rising!.art.top - bounce;

      expect(highestTop).toBeGreaterThan(TITLE_BOTTOM_PX);
    });

    // The two sliding screenshots are cropped flush to a card edge. Any
    // overshoot pulls the picture off that edge and shows bare card through it.
    it("gives the slide no overshoot at all", () => {
      expect(springOvershoot(ART_SLIDE_SPRING)).toBe(0);
    });

    it("keeps the morph's overshoot inside the card's gutter", () => {
      const travel = WIDE_BUTTON_WIDTH_PX - BUTTON_WIDTH_PX;
      const overshootPx = springOvershoot(BUTTON_MORPH_SPRING) * travel;

      // Right-anchored, so the overshoot grows leftwards into the gutter.
      expect(overshootPx).toBeGreaterThan(4);
      expect(overshootPx).toBeLessThan(CARD_GUTTER_PX);
    });

    it("widens the button quickly, as the design asks", () => {
      expect(ONBOARDING_MOTION.morphMs).toBeLessThan(500);
    });
  });

  describe("the geometry the springs were picked against", () => {
    it("agrees with the card the steps are laid out on", () => {
      expect(BUTTON_WIDTH_PX + CARD_GUTTER_PX * 2).toBeLessThan(
        ONBOARDING_CARD.width,
      );
      expect(WIDE_BUTTON_WIDTH_PX).toBe(
        ONBOARDING_CARD.width - CARD_GUTTER_PX * 2,
      );
    });

    // A slide that starts further out than the picture bleeds would show the
    // card behind it at the first frame.
    it("slides in from a distance the card can hide", () => {
      expect(ART_SLIDE_PX).toBeGreaterThan(0);
      expect(ART_SLIDE_PX).toBeLessThan(ONBOARDING_CARD.width / 4);
    });
  });

  describe("timings", () => {
    it("has the art still arriving after the contents have faded up", () => {
      // The fade masks the start of the travel; if the entrance finished
      // first, the art would simply appear and the motion would be wasted.
      expect(ONBOARDING_MOTION.riseMs).toBeGreaterThan(FADE_MS);
      expect(ONBOARDING_MOTION.slideMs).toBeGreaterThan(FADE_MS);
    });

    it("has the rise already bouncing back by the time it is fully opaque", () => {
      expect(springPosition(ART_RISE_SPRING, FADE_MS / 1000)).toBeGreaterThan(1);
    });

    it("holds the entrance class for at least as long as the longest entrance", () => {
      expect(ONBOARDING_MOTION.enterMs).toBeGreaterThanOrEqual(
        ONBOARDING_MOTION.riseMs,
      );
      expect(ONBOARDING_MOTION.enterMs).toBeGreaterThanOrEqual(
        ONBOARDING_MOTION.slideMs,
      );
    });
  });

  describe("the inline style handed to CSS", () => {
    const style = onboardingMotionStyle();

    it("carries every number the stylesheet reads", () => {
      for (const name of [
        "--onboarding-fade",
        "--onboarding-rise",
        "--onboarding-rise-ease",
        "--onboarding-rise-from",
        "--onboarding-slide",
        "--onboarding-slide-ease",
        "--onboarding-slide-from",
        "--onboarding-morph",
        "--onboarding-morph-ease",
      ]) {
        expect(style, `missing ${name}`).toContain(`${name}: `);
      }
    });

    it("gives every duration and distance a unit", () => {
      for (const declaration of style.split("; ")) {
        const [name, value] = declaration.split(": ");
        if (name.endsWith("-ease")) {
          expect(value.startsWith("linear(")).toBe(true);
          continue;
        }
        expect(value, name).toMatch(/^\d+(px|ms)$/);
      }
    });

    // A stray `"` or `;` would be dropped silently by the style parser and the
    // animation would fall back to its default timing with nothing logged.
    it("is a style attribute's worth of declarations and nothing else", () => {
      expect(style).not.toContain(";;");
      expect(style).not.toMatch(/["'<>]/);
    });
  });

  // The stylesheet has one rule per direction; a step naming a fourth would
  // simply not animate, silently.
  it("animates exactly the directions the stylesheet has rules for", () => {
    const directions = ONBOARDING_STEPS.map((step) => step.art.enter).filter(
      Boolean,
    );

    expect(directions).toEqual(["bottom", "right", "left"]);
  });
});
