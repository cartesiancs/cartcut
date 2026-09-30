import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_COMPLETE_EVENT,
  ONBOARDING_RESTART_EVENT,
  ONBOARDING_STORE_KEY,
  browserFlagPort,
  browserOnboardingFlagPort,
  isOnboardingComplete,
  markOnboardingComplete,
  resetOnboarding,
  type OnboardingFlagPort,
} from "./onboardingFlag";

type Fake = OnboardingFlagPort & {
  mirror: string | null;
  stored: boolean | null;
  warnings: string[];
  reads: number;
};

/**
 * Both records, in memory, plus counters for the two things worth asserting
 * that a return value cannot show: that the store is not consulted once the
 * mirror has answered, and what was warned about.
 */
function fakePort(
  initial: { mirror?: string | null; stored?: boolean | null } = {},
): Fake {
  const port: Fake = {
    mirror: initial.mirror ?? null,
    stored: initial.stored ?? null,
    warnings: [],
    reads: 0,

    readMirror: () => port.mirror,
    writeMirror: (value) => void (port.mirror = value),
    clearMirror: () => void (port.mirror = null),
    readStored: async () => {
      port.reads += 1;
      return port.stored === null ? undefined : { value: port.stored };
    },
    writeStored: async (value) => void (port.stored = value),
    clearStored: async () => void (port.stored = null),
    warn: (message) => void port.warnings.push(message),
  };

  return port;
}

/** A port whose every call fails, to stand in for storage being refused. */
function brokenPort(over: Partial<OnboardingFlagPort> = {}): OnboardingFlagPort {
  const boom = () => {
    throw new Error("storage refused");
  };

  return {
    readMirror: boom,
    writeMirror: boom,
    clearMirror: boom,
    readStored: boom as never,
    writeStored: boom,
    clearStored: boom,
    warn: () => {},
    ...over,
  };
}

describe("onboarding flag", () => {
  it("is the key the app has always written", () => {
    // Renaming it would show every existing user the tour again.
    expect(ONBOARDING_STORE_KEY).toBe("ONBOARDING_COMPLETED");
  });

  describe("reading", () => {
    it("is not complete when neither record says so", async () => {
      await expect(isOnboardingComplete(fakePort())).resolves.toBe(false);
    });

    it("is complete when only the store says so", async () => {
      const port = fakePort({ stored: true });
      await expect(isOnboardingComplete(port)).resolves.toBe(true);
    });

    it("is complete when only the mirror says so, without asking the store", async () => {
      const port = fakePort({ mirror: "true" });

      await expect(isOnboardingComplete(port)).resolves.toBe(true);
      expect(port.reads).toBe(0);
    });

    it("reads the store anyway when the mirror throws", async () => {
      const port = fakePort({ stored: true });
      const thrown = brokenPort({ readStored: port.readStored });

      await expect(isOnboardingComplete(thrown)).resolves.toBe(true);
    });

    // A browser that refuses storage should show the tour again, not break the
    // editor before it has drawn a frame.
    it("is not complete, rather than throwing, when both records are refused", async () => {
      await expect(isOnboardingComplete(brokenPort())).resolves.toBe(false);
    });

    it("treats anything but true as not complete", async () => {
      for (const stored of [false, null]) {
        await expect(
          isOnboardingComplete(fakePort({ stored: stored as boolean | null })),
        ).resolves.toBe(false);
      }
      for (const mirror of ["", "false", "TRUE", "1"]) {
        await expect(isOnboardingComplete(fakePort({ mirror }))).resolves.toBe(
          false,
        );
      }
    });
  });

  describe("marking complete", () => {
    it("writes both records", async () => {
      const port = fakePort();
      await markOnboardingComplete(port);

      expect(port.mirror).toBe("true");
      expect(port.stored).toBe(true);
      await expect(isOnboardingComplete(port)).resolves.toBe(true);
    });

    it("still writes the store when the mirror is refused", async () => {
      const port = fakePort();
      const half = brokenPort({
        writeStored: port.writeStored,
        readMirror: port.readMirror,
        readStored: port.readStored,
      });

      await markOnboardingComplete(half);
      expect(port.stored).toBe(true);
    });

    it("never rejects, whatever storage does", async () => {
      await expect(markOnboardingComplete(brokenPort())).resolves.toBeUndefined();
    });
  });

  describe("resetting", () => {
    it("clears both records, so the tour shows again", async () => {
      const port = fakePort({ mirror: "true", stored: true });

      await resetOnboarding(port);

      expect(port.mirror).toBeNull();
      expect(port.stored).toBeNull();
      await expect(isOnboardingComplete(port)).resolves.toBe(false);
    });

    // The one that actually bites: `isOnboardingComplete` short-circuits on the
    // mirror, so clearing only the store leaves the tour just as hidden as
    // before while the button reports success.
    it("clears the store even when the mirror is refused, and says so", async () => {
      const port = fakePort({ mirror: "true", stored: true });
      const warnings: string[] = [];
      const half: OnboardingFlagPort = {
        ...port,
        clearMirror: () => {
          throw new Error("storage refused");
        },
        warn: (message) => void warnings.push(message),
      };

      await resetOnboarding(half);

      expect(port.stored).toBeNull();
      expect(warnings).toEqual([
        "onboarding: could not clear the mirrored flag",
      ]);
    });

    it("clears the mirror even when the store is refused, and says so", async () => {
      const port = fakePort({ mirror: "true", stored: true });
      const warnings: string[] = [];
      const half: OnboardingFlagPort = {
        ...port,
        clearStored: () => Promise.reject(new Error("ipc is gone")),
        warn: (message) => void warnings.push(message),
      };

      await resetOnboarding(half);

      expect(port.mirror).toBeNull();
      expect(warnings).toEqual(["onboarding: could not clear the stored flag"]);
    });

    it("never rejects, whatever storage does", async () => {
      await expect(resetOnboarding(brokenPort())).resolves.toBeUndefined();
    });

    it("names the flag it could not clear, when the port has a name", async () => {
      const warnings: string[] = [];
      await resetOnboarding(
        brokenPort({
          name: "tutorial",
          warn: (message) => void warnings.push(message),
        }),
      );

      expect(warnings).toEqual([
        "tutorial: could not clear the mirrored flag",
        "tutorial: could not clear the stored flag",
      ]);
    });

    it("undoes a completion exactly", async () => {
      const port = fakePort();

      await markOnboardingComplete(port);
      await expect(isOnboardingComplete(port)).resolves.toBe(true);

      await resetOnboarding(port);
      await expect(isOnboardingComplete(port)).resolves.toBe(false);
    });
  });

  describe("the browser port", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Both stores as plain maps, behind the two globals the port reaches. */
    function stubStores() {
      const local = new Map<string, string>();
      const stored = new Map<string, unknown>();

      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => local.get(key) ?? null,
          setItem: (key: string, value: string) => void local.set(key, value),
          removeItem: (key: string) => void local.delete(key),
        },
        electronAPI: {
          req: {
            store: {
              get: async (key: string) =>
                stored.has(key) ? { value: stored.get(key) } : { status: 0 },
              set: async (key: string, value: unknown) =>
                void stored.set(key, value),
              delete: async (key: string) => void stored.delete(key),
            },
          },
        },
      });

      return { local, stored };
    }

    it("reads and writes only its own key, in both stores", async () => {
      const { local, stored } = stubStores();
      const port = browserFlagPort("SOME_FLAG", "some");

      await markOnboardingComplete(port);

      expect([...local.keys()]).toEqual(["SOME_FLAG"]);
      expect([...stored.keys()]).toEqual(["SOME_FLAG"]);
      await expect(isOnboardingComplete(port)).resolves.toBe(true);
      await expect(isOnboardingComplete(browserOnboardingFlagPort)).resolves.toBe(
        false,
      );

      await resetOnboarding(port);
      expect(local.size + stored.size).toBe(0);
    });

    it("keeps the tour on its own key", async () => {
      const { local, stored } = stubStores();

      await markOnboardingComplete(browserOnboardingFlagPort);

      expect(local.get(ONBOARDING_STORE_KEY)).toBe("true");
      expect(stored.get(ONBOARDING_STORE_KEY)).toBe(true);
      expect(browserOnboardingFlagPort.name).toBe("onboarding");
    });
  });

  it("has two different events for starting over and for having finished", () => {
    expect(ONBOARDING_COMPLETE_EVENT).not.toBe(ONBOARDING_RESTART_EVENT);
  });
});
