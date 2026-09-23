import { describe, expect, it } from "vitest";

import {
  activationEventFor,
  initialExtension,
  matchesActivation,
  reduceExtension,
  type ExtensionRecord,
} from "./extensionState";

const validated = (): ExtensionRecord =>
  reduceExtension(initialExtension("acme.hello"), { type: "validated" });

describe("reduceExtension", () => {
  it("walks discovered to active", () => {
    let record = validated();
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    expect(record.phase).toBe("activating");
    record = reduceExtension(record, { type: "activated" });
    expect(record).toMatchObject({ phase: "active", activatedBy: "onStartup", error: null });
  });

  it("keeps the error when activation throws", () => {
    let record = validated();
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    record = reduceExtension(record, { type: "activationFailed", error: "Cannot find module 'left-pad'" });
    expect(record).toMatchObject({ phase: "failed", error: "Cannot find module 'left-pad'" });
  });

  it("refuses to start a second activation while the first is in flight", () => {
    // Two triggers arriving together must not run `activate()` twice. The
    // loader queues the second invoke behind the first instead.
    let record = validated();
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    const again = reduceExtension(record, { type: "activate", trigger: "onCommand:x" });
    expect(again).toBe(record);
  });

  it("never activates a disabled extension", () => {
    let record = reduceExtension(validated(), { type: "setEnabled", enabled: false });
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    expect(record.phase).toBe("validated");
  });

  it("lets a disable land on an activation that is hanging", () => {
    // Without this the only way out of a wedged `activate()` is restarting the
    // whole host, which takes every other extension down with it.
    let record = validated();
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    record = reduceExtension(record, { type: "deactivate" });
    expect(record.phase).toBe("deactivating");
  });

  it("returns to validated after deactivating, so it can wake again", () => {
    let record = validated();
    record = reduceExtension(record, { type: "activate", trigger: "onStartup" });
    record = reduceExtension(record, { type: "activated" });
    record = reduceExtension(record, { type: "deactivate" });
    record = reduceExtension(record, { type: "deactivated" });
    expect(record).toMatchObject({ phase: "validated", activatedBy: null });

    record = reduceExtension(record, { type: "activate", trigger: "onCommand:x" });
    expect(record.phase).toBe("activating");
  });

  it("declines by identity when an event does not apply", () => {
    const record = validated();
    expect(reduceExtension(record, { type: "activated" })).toBe(record);
    expect(reduceExtension(record, { type: "deactivated" })).toBe(record);
    expect(reduceExtension(record, { type: "validated" })).toBe(record);
    expect(reduceExtension(record, { type: "setEnabled", enabled: true })).toBe(record);
  });

  it("marks an invalid manifest failed from any phase", () => {
    expect(reduceExtension(initialExtension("a.b"), { type: "invalid", error: "bad" })).toMatchObject({
      phase: "failed",
      error: "bad",
    });
  });
});

describe("matchesActivation", () => {
  it("matches each trigger to its own event", () => {
    expect(matchesActivation(["onStartup"], { kind: "startup" })).toBe(true);
    expect(matchesActivation(["onProjectOpen"], { kind: "projectOpen" })).toBe(true);
    expect(matchesActivation(["onCommand:a.b"], { kind: "command", id: "a.b" })).toBe(true);
    expect(matchesActivation(["onView:panel"], { kind: "view", id: "panel" })).toBe(true);
    expect(matchesActivation(["onFiletype:mp4"], { kind: "filetype", ext: "mp4" })).toBe(true);
  });

  it("does not match a different id of the same kind", () => {
    expect(matchesActivation(["onCommand:a.b"], { kind: "command", id: "a.c" })).toBe(false);
  });

  it("matches everything on a star", () => {
    expect(matchesActivation(["*"], { kind: "filetype", ext: "mov" })).toBe(true);
  });

  it("never activates an extension that declared nothing", () => {
    // Loud rather than convenient: an extension with no activation events is a
    // mistake its author can see, where activating everything at startup is a
    // cost every user pays and nobody attributes.
    expect(matchesActivation([], { kind: "startup" })).toBe(false);
  });

  it("names the event a trigger corresponds to", () => {
    expect(activationEventFor({ kind: "command", id: "x" })).toBe("onCommand:x");
  });
});
