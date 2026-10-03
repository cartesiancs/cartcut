import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "../../../../../electron/extension/permissions";
import {
  listingStatus,
  matchesQuery,
  PERMISSION_CHIPS,
  permissionChip,
  settingLabel,
  STATUS_LABELS,
} from "./listing";

describe("listingStatus", () => {
  it("reads off before anything the host reported", () => {
    expect(listingStatus({ enabled: false, phase: "active" })).toBe("off");
    expect(listingStatus({ enabled: false, phase: "failed" })).toBe("off");
  });

  it("maps each host phase", () => {
    expect(listingStatus({ enabled: true, phase: "failed" })).toBe("failed");
    expect(listingStatus({ enabled: true, phase: "activating" })).toBe("starting");
    expect(listingStatus({ enabled: true, phase: "active" })).toBe("active");
  });

  it("calls every other phase idle, including one it has never heard of", () => {
    for (const phase of ["discovered", "validated", "deactivating", "something-new"]) {
      expect(listingStatus({ enabled: true, phase })).toBe("idle");
    }
  });

  it("has a word for every status it can answer", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ["active", "failed", "idle", "off", "starting"].sort(),
    );
  });
});

describe("settingLabel", () => {
  it("drops the namespace and capitalises the leaf", () => {
    expect(settingLabel("hello.greeting")).toBe("Greeting");
    expect(settingLabel("hello.shout")).toBe("Shout");
  });

  it("splits camel case, dashes and underscores into words", () => {
    expect(settingLabel("acme.shoutLoud")).toBe("Shout loud");
    expect(settingLabel("acme.max-count")).toBe("Max count");
    expect(settingLabel("acme.retry_after_ms")).toBe("Retry after ms");
  });

  it("keeps an acronym as written", () => {
    expect(settingLabel("acme.maxFPS")).toBe("Max FPS");
  });

  it("falls back to the key when there is no leaf to read", () => {
    expect(settingLabel("acme.")).toBe("acme.");
    expect(settingLabel("plain")).toBe("Plain");
  });
});

describe("permission chips", () => {
  it("cover exactly the permissions main knows", () => {
    expect(Object.keys(PERMISSION_CHIPS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("draw an unknown id as itself", () => {
    expect(permissionChip("telepathy")).toEqual({ icon: "shield", label: "telepathy" });
    expect(permissionChip("net")).toEqual({ icon: "language", label: "Internet" });
  });
});

describe("matchesQuery", () => {
  it("keeps everything for an empty or blank query", () => {
    expect(matchesQuery("", "Hello")).toBe(true);
    expect(matchesQuery("   ", "Hello")).toBe(true);
  });

  it("matches any field, ignoring case and the query's own padding", () => {
    expect(matchesQuery(" HEL ", "Hello", "acme.hello")).toBe(true);
    expect(matchesQuery("acme", "Hello", "acme.hello")).toBe(true);
    expect(matchesQuery("wobble", "Hello", "acme.hello")).toBe(false);
  });
});
