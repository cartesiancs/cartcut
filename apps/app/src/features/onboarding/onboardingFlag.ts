/**
 * Where "the user has seen the tour" is recorded, and the three things anyone
 * does to it.
 *
 * The flag is kept in two places and they are not interchangeable.
 * `electron-store` is the record that matters, but the web and demo builds stub
 * `store.get` out to a string, so it is mirrored into `localStorage`, and
 * **either one saying "done" hides the tour**.
 *
 * That "either" is the whole reason this is a module and not three lines at
 * each call site: a reset that clears one record and not the other is
 * indistinguishable, from the outside, from a reset that did nothing. Both
 * halves are attempted whatever the other does, and a build where one of them
 * throws is the ordinary case rather than the exotic one.
 */

/** The key both records use. */
export const ONBOARDING_STORE_KEY = "ONBOARDING_COMPLETED";

/**
 * Fired on `window` to put the tour back on screen from the first card.
 *
 * The overlay listens; the settings panel fires it after clearing the flag.
 * An event rather than a `querySelector` and a method call so that neither of
 * the two knows the other's tag name.
 */
export const ONBOARDING_RESTART_EVENT = "onboarding:restart";

/**
 * The two stores, each reached through one call.
 *
 * Every method here may throw or reject, and the functions below are what
 * handles that: `localStorage` throws outright in a window with site data
 * blocked, and `store` is IPC to another process.
 */
export type OnboardingFlagPort = {
  readMirror(): string | null;
  writeMirror(value: string): void;
  clearMirror(): void;
  readStored(): Promise<{ value?: unknown } | null | undefined>;
  writeStored(value: boolean): unknown;
  clearStored(): unknown;
  warn(message: string, error: unknown): void;
};

/**
 * Has the user finished, or skipped, the tour?
 *
 * Either record saying so is enough. A record that cannot be *read* is not
 * "done": a browser refusing storage means the tour shows again, which is a
 * good deal better than a crash on the first frame of the editor.
 */
export async function isOnboardingComplete(
  port: OnboardingFlagPort,
): Promise<boolean> {
  try {
    if (port.readMirror() === "true") return true;
  } catch (error) {
    // Not fatal, and not a reason to skip the store: the mirror is the copy,
    // and the store is the record.
    port.warn("onboarding: could not read the mirrored flag", error);
  }

  try {
    const stored = await port.readStored();
    return stored?.value === true;
  } catch (error) {
    port.warn("onboarding: could not read the completion flag", error);
    return false;
  }
}

/** Records that the tour is done, in both places. */
export async function markOnboardingComplete(
  port: OnboardingFlagPort,
): Promise<void> {
  await bothOf(
    port,
    () => port.writeMirror("true"),
    () => port.writeStored(true),
    "record",
  );
}

/**
 * Clears both records, so the tour runs again the next time it is asked for.
 *
 * Both, and not just the store: `isOnboardingComplete` short-circuits on the
 * mirror, so a leftover `"true"` there hides the tour no matter what the store
 * now says.
 */
export async function resetOnboarding(
  port: OnboardingFlagPort,
): Promise<void> {
  await bothOf(
    port,
    () => port.clearMirror(),
    () => port.clearStored(),
    "clear",
  );
}

/**
 * Runs both halves, letting neither failure stop the other, and never
 * rejecting: there is nothing a caller can do about a storage error that
 * `warn` has not already done, and a tour that refuses to close because its
 * bookkeeping failed would be the worse bug.
 */
async function bothOf(
  port: OnboardingFlagPort,
  mirror: () => void,
  stored: () => unknown,
  verb: string,
): Promise<void> {
  try {
    mirror();
  } catch (error) {
    port.warn(`onboarding: could not ${verb} the mirrored flag`, error);
  }

  try {
    await stored();
  } catch (error) {
    port.warn(`onboarding: could not ${verb} the stored flag`, error);
  }
}

/**
 * The real two stores.
 *
 * Each method reaches `window` when it is called rather than at module load,
 * so importing this from a suite costs nothing and a build without
 * `electronAPI` fails at the call that needs it.
 */
export const browserOnboardingFlagPort: OnboardingFlagPort = {
  readMirror: () => window.localStorage.getItem(ONBOARDING_STORE_KEY),
  writeMirror: (value) =>
    window.localStorage.setItem(ONBOARDING_STORE_KEY, value),
  clearMirror: () => window.localStorage.removeItem(ONBOARDING_STORE_KEY),
  readStored: () => window.electronAPI.req.store.get(ONBOARDING_STORE_KEY),
  writeStored: (value) =>
    window.electronAPI.req.store.set(ONBOARDING_STORE_KEY, value),
  clearStored: () => window.electronAPI.req.store.delete(ONBOARDING_STORE_KEY),
  warn: (message, error) => console.warn(message, error),
};
