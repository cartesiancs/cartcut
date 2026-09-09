import { describe, expect, it } from "vitest";
import { overlayScopeKey } from "./overlaySource";

const NUL = String.fromCharCode(0);

/**
 * The `<video>` half of this module needs a DOM, so it stays e2e-only. What
 * can be pinned here is the property the whole scoping rests on: a preview
 * handle and an export handle for the same effect are different keys, and the
 * preview's sweep can tell them apart.
 */
describe("overlayScopeKey", () => {
  it("gives two scopes different keys for the same effect and source", () => {
    const preview = overlayScopeKey("", "fx1", "/presets/grain/loop.mp4");
    const exported = overlayScopeKey(
      "export:17",
      "fx1",
      "/presets/grain/loop.mp4",
    );

    expect(preview).not.toBe(exported);
  });

  it("separates on a character neither an element id nor a path can hold", () => {
    // "|" already separates elementId from source and a path is free to
    // contain one, so the scope is split on NUL instead.
    const key = overlayScopeKey("", "fx1", "/a|b.mp4");
    expect(key.indexOf(NUL)).toBe(0);
    expect(key).toBe(NUL + "fx1|/a|b.mp4");
  });

  it("keeps ids distinct that a naive concatenation would collide", () => {
    // Without a separator, ("export:1", "a") and ("export:1a", "") would be
    // the same string.
    expect(overlayScopeKey("export:1", "a", "s")).not.toBe(
      overlayScopeKey("export:1a", "", "s"),
    );
  });

  it("is stable for the same three inputs", () => {
    expect(overlayScopeKey("export:9", "fx1", "/s.mp4")).toBe(
      overlayScopeKey("export:9", "fx1", "/s.mp4"),
    );
  });
});
