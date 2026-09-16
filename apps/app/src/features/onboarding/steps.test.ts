import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ONBOARDING_CARD, ONBOARDING_STEPS, nextStep } from "./steps";

// The paths are written relative to `apps/app/index.html`, which is what the
// renderer loads.
const indexDir = path.resolve(__dirname, "../../..");

describe("onboarding steps", () => {
  it("is the five cards from the design, with only the last one final", () => {
    expect(ONBOARDING_STEPS).toHaveLength(5);
    expect(ONBOARDING_STEPS.map((step) => step.isLast)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("opens on the wordmark and titles every card after it", () => {
    const [first, ...rest] = ONBOARDING_STEPS;

    expect(first.titleKey).toBeUndefined();
    expect(first.subtitleKey).toBe("onboarding.welcome_subtitle");

    for (const step of rest) {
      expect(step.titleKey).toBeTruthy();
      expect(step.subtitleKey).toBeUndefined();
    }
  });

  it("clamps at the last card rather than running off the end", () => {
    const last = ONBOARDING_STEPS.length - 1;

    expect(nextStep(0)).toBe(1);
    expect(nextStep(last)).toBe(last);
    expect(ONBOARDING_STEPS[nextStep(last)]).toBeDefined();
  });

  // The two kinds of art are placed by different rules, and the difference is
  // load-bearing: a screenshot that lost its scrim would put the title and the
  // buttons straight onto the picture.
  it("gives every screenshot a scrim and a place, and neither to the drawings", () => {
    for (const step of ONBOARDING_STEPS) {
      const isScreenshot = step.art.src.endsWith(".webp");

      expect(Boolean(step.scrim), `scrim on ${step.art.src}`).toBe(
        isScreenshot,
      );
      expect(step.art.left !== undefined, `left on ${step.art.src}`).toBe(
        isScreenshot,
      );
    }

    expect(
      ONBOARDING_STEPS.filter((step) => step.art.src.endsWith(".webp")),
    ).toHaveLength(3);
  });

  // The webps are already cropped to the part of the window the card reveals,
  // so a box that stops short leaves a band of bare card colour where the
  // design has picture, and one that overruns crops the picture twice.
  it("runs every screenshot to the card's far corner", () => {
    for (const step of ONBOARDING_STEPS) {
      if (!step.art.src.endsWith(".webp")) continue;
      if (step.art.left === undefined) continue;

      // The first card's window is drawn whole, inside the card; the other two
      // are cropped to it and so have to reach both edges.
      const reachesRight = step.art.left + step.art.width;
      if (reachesRight !== ONBOARDING_CARD.width) continue;

      expect(step.art.top + step.art.height, `bottom of ${step.art.src}`).toBe(
        ONBOARDING_CARD.height,
      );
    }

    // Two of the three, so the rule above is exercised rather than skipped.
    expect(
      ONBOARDING_STEPS.filter(
        (step) =>
          step.art.left !== undefined &&
          step.art.left + step.art.width === ONBOARDING_CARD.width,
      ),
    ).toHaveLength(2);
  });

  // Every piece of art has to fit the card it is drawn on, whichever way it is
  // placed.
  it("keeps every placement inside the card", () => {
    for (const step of ONBOARDING_STEPS) {
      const left = step.art.left ?? (ONBOARDING_CARD.width - step.art.width) / 2;

      expect(left, `left of ${step.art.src}`).toBeGreaterThanOrEqual(0);
      expect(
        left + step.art.width,
        `right of ${step.art.src}`,
      ).toBeLessThanOrEqual(ONBOARDING_CARD.width);
      expect(
        step.art.top + step.art.height,
        `bottom of ${step.art.src}`,
      ).toBeLessThanOrEqual(ONBOARDING_CARD.height);
    }
  });

  // The scrim runs from `top` to the card's bottom edge, and `fadeFrom` is a
  // percentage of that band. A stop at or past the end one would leave a hard
  // edge where the gradient stops instead of a fade.
  it("starts every scrim's fade above the stop the card colour lands on", () => {
    for (const step of ONBOARDING_STEPS) {
      if (!step.scrim) continue;

      expect(step.scrim.fadeFrom).toBeGreaterThanOrEqual(0);
      expect(step.scrim.fadeFrom).toBeLessThan(92.972);
      expect(step.scrim.top).toBeGreaterThan(0);
      expect(step.scrim.top).toBeLessThan(ONBOARDING_CARD.height);
    }
  });

  // The paths are only ever resolved by the browser at runtime, where a typo
  // is a silently broken image rather than an error.
  it("points at files that are actually committed", () => {
    for (const step of ONBOARDING_STEPS) {
      const resolved = path.resolve(indexDir, step.art.src);
      expect(fs.existsSync(resolved), `missing ${step.art.src}`).toBe(true);
    }
  });

  // Only the drawings. A screenshot's box is the region of the card it fills,
  // which its file matches to within a fraction of a pixel but not exactly, and
  // `object-fit: cover` is what closes that gap.
  it("keeps each drawing at the aspect ratio it was drawn at", () => {
    const drawings = ONBOARDING_STEPS.filter((step) =>
      step.art.src.endsWith(".svg"),
    );
    expect(drawings).toHaveLength(2);

    for (const step of drawings) {
      const svg = fs.readFileSync(
        path.resolve(indexDir, step.art.src),
        "utf-8",
      );
      const viewBox = svg.match(/viewBox="([\d.\s-]+)"/)?.[1];
      expect(viewBox, `no viewBox in ${step.art.src}`).toBeTruthy();

      const [, , width, height] = viewBox!.trim().split(/\s+/).map(Number);
      const drawn = step.art.width / step.art.height;

      expect(Math.abs(drawn - width / height)).toBeLessThan(0.01);
    }
  });
});
