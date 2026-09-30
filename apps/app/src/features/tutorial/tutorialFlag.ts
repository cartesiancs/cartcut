/**
 * Where "the user has finished, or skipped, the tutorial" is recorded.
 *
 * The same two stores and the same forgiving functions as the tour's flag
 * (`onboarding/onboardingFlag.ts`), on a key of its own.
 */

import {
  ONBOARDING_RESTART_EVENT,
  browserFlagPort,
  browserOnboardingFlagPort,
  isOnboardingComplete,
  markOnboardingComplete,
  resetOnboarding,
  type OnboardingFlagPort,
} from "../onboarding/onboardingFlag";

/** Renaming it would show the tutorial again to everyone who finished it. */
export const TUTORIAL_STORE_KEY = "TUTORIAL_COMPLETED";

/**
 * Fired on `window` to run the tutorial again from its first step. Help ▸
 * Show Tutorial sends it; the flag is not cleared, since only the end of the
 * tour reads it. Help ▸ Reset Onboarding is the one that clears it, below.
 */
export const TUTORIAL_RESTART_EVENT = "tutorial:restart";

export const browserTutorialFlagPort: OnboardingFlagPort = browserFlagPort(
  TUTORIAL_STORE_KEY,
  "tutorial",
);

export const isTutorialComplete = (
  port: OnboardingFlagPort = browserTutorialFlagPort,
): Promise<boolean> => isOnboardingComplete(port);

export const markTutorialComplete = (
  port: OnboardingFlagPort = browserTutorialFlagPort,
): Promise<void> => markOnboardingComplete(port);

/**
 * Help ▸ Reset Onboarding: the user is new again, tour and tutorial both.
 *
 * Both flags are cleared before the tour is announced, because the tutorial
 * reads its own flag when the tour ends, and a leftover "done" would stop it
 * from following. The tour is announced whatever the clearing did, as the
 * settings panel always has: a build that cannot write storage still shows it.
 *
 * Here rather than in `onboarding/`, which knows nothing of the tutorial.
 */
export async function resetOnboardingAndTutorial(
  onboarding: OnboardingFlagPort = browserOnboardingFlagPort,
  tutorial: OnboardingFlagPort = browserTutorialFlagPort,
  announce: () => void = () =>
    window.dispatchEvent(new CustomEvent(ONBOARDING_RESTART_EVENT)),
): Promise<void> {
  // Neither rejects: see `onboardingFlag.ts#bothOf`.
  await Promise.all([resetOnboarding(onboarding), resetOnboarding(tutorial)]);
  announce();
}
