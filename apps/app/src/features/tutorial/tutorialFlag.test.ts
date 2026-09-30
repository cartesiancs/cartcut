import { describe, expect, it } from "vitest";
import {
  ONBOARDING_COMPLETE_EVENT,
  ONBOARDING_RESTART_EVENT,
  ONBOARDING_STORE_KEY,
  isOnboardingComplete,
  type OnboardingFlagPort,
} from "../onboarding/onboardingFlag";
import {
  TUTORIAL_RESTART_EVENT,
  TUTORIAL_STORE_KEY,
  browserTutorialFlagPort,
  resetOnboardingAndTutorial,
} from "./tutorialFlag";

/** One flag in memory, both halves set, logging each clear as it lands. */
function flag(name: string, log: string[]): OnboardingFlagPort & {
  mirror: string | null;
  stored: boolean | null;
} {
  const port = {
    name,
    mirror: "true" as string | null,
    stored: true as boolean | null,
    readMirror: () => port.mirror,
    writeMirror: (value: string) => void (port.mirror = value),
    clearMirror: () => {
      port.mirror = null;
      log.push(`${name} mirror`);
    },
    readStored: async () =>
      port.stored === null ? undefined : { value: port.stored },
    writeStored: (value: boolean) => void (port.stored = value),
    clearStored: async () => {
      port.stored = null;
      log.push(`${name} stored`);
    },
    warn: () => {},
  };
  return port;
}

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

describe("resetting onboarding", () => {
  it("forgets the tour and the tutorial, then shows the tour", async () => {
    const log: string[] = [];
    const tour = flag("tour", log);
    const tutorial = flag("tutorial", log);

    await resetOnboardingAndTutorial(tour, tutorial, () => log.push("announce"));

    await expect(isOnboardingComplete(tour)).resolves.toBe(false);
    await expect(isOnboardingComplete(tutorial)).resolves.toBe(false);
    // The tutorial reads its flag when the tour ends, so both have to be clear
    // before the tour is back on screen.
    expect(log[log.length - 1]).toBe("announce");
    expect(log).toHaveLength(5);
  });

  it("still shows the tour when storage refuses the reset", async () => {
    const refused: OnboardingFlagPort = {
      readMirror: () => null,
      writeMirror: () => {},
      clearMirror: () => {
        throw new Error("storage refused");
      },
      readStored: async () => undefined,
      writeStored: () => {},
      clearStored: () => Promise.reject(new Error("ipc is gone")),
      warn: () => {},
    };
    let announced = false;

    await resetOnboardingAndTutorial(refused, refused, () => {
      announced = true;
    });

    expect(announced).toBe(true);
  });
});
