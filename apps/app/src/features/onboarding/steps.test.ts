import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ONBOARDING_STEPS, nextStep, prevStep } from "./steps";

describe("onboarding steps", () => {
  it("is the four cards from the design, with only the last one final", () => {
    expect(ONBOARDING_STEPS).toHaveLength(4);
    expect(ONBOARDING_STEPS.map((step) => step.isLast)).toEqual([
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

  it("clamps at the first card on the way back", () => {
    // Only the first card offers Skip; the rest go back, and there is nowhere
    // to go back to from the first.
    expect(prevStep(2)).toBe(1);
    expect(prevStep(0)).toBe(0);
    expect(ONBOARDING_STEPS[prevStep(0)]).toBeDefined();
  });

  // The paths are only ever resolved by the browser at runtime, where a typo
  // is a silently broken image rather than an error.
  it("points at files that are actually committed", () => {
    // The paths are written relative to `apps/app/index.html`, which is what
    // the renderer loads.
    const indexDir = path.resolve(__dirname, "../../..");

    for (const step of ONBOARDING_STEPS) {
      const resolved = path.resolve(indexDir, step.art.src);
      expect(fs.existsSync(resolved), `missing ${step.art.src}`).toBe(true);
    }
  });

  it("keeps each illustration at the aspect ratio it was drawn at", () => {
    const indexDir = path.resolve(__dirname, "../../..");

    for (const step of ONBOARDING_STEPS) {
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
