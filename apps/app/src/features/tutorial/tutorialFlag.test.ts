import { describe, expect, it } from "vitest";
import {
  ONBOARDING_COMPLETE_EVENT,
  ONBOARDING_RESTART_EVENT,
  ONBOARDING_STORE_KEY,
} from "../onboarding/onboardingFlag";
import {
  TUTORIAL_RESTART_EVENT,
  TUTORIAL_STORE_KEY,
  browserTutorialFlagPort,
} from "./tutorialFlag";

describe("tutorial flag", () => {
  it("is its own key, apart from the tour's", () => {
    // Renaming it would show the tutorial again to everyone who finished it.
    expect(TUTORIAL_STORE_KEY).toBe("TUTORIAL_COMPLETED");
    expect(TUTORIAL_STORE_KEY).not.toBe(ONBOARDING_STORE_KEY);
    expect(browserTutorialFlagPort.name).toBe("tutorial");
  });

  it("is restarted by an event of its own", () => {
    expect(
      new Set([
        TUTORIAL_RESTART_EVENT,
        ONBOARDING_RESTART_EVENT,
        ONBOARDING_COMPLETE_EVENT,
      ]).size,
    ).toBe(3);
  });
});
