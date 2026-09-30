/**
 * Where "the user has finished, or skipped, the tutorial" is recorded.
 *
 * The same two stores and the same forgiving functions as the tour's flag
 * (`onboarding/onboardingFlag.ts`), on a key of its own.
 */

import {
  browserFlagPort,
  isOnboardingComplete,
  markOnboardingComplete,
  type OnboardingFlagPort,
} from "../onboarding/onboardingFlag";

/** Renaming it would show the tutorial again to everyone who finished it. */
export const TUTORIAL_STORE_KEY = "TUTORIAL_COMPLETED";

/**
 * Fired on `window` to run the tutorial again from its first step. Help ▸
 * Show Tutorial sends it; the flag is not cleared, since only the end of the
 * tour reads it.
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
