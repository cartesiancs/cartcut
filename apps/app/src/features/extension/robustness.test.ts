/**
 * The three places the extension system sits on somebody else's hot path.
 *
 * Each of these guards exists because of *where* it runs, not because a
 * throw is reachable today. The keybinding seam is on the path of every
 * keystroke in the editor, the context menu is built as one string, and the
 * thumbnail cache outlives the extension that filled it. A regression in any
 * of the three would look like the editor breaking rather than like an
 * extension misbehaving, which is the failure this subsystem is supposed to
 * make impossible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shapePreviewSamples } from "../animation/presetPreview";
import {
  __clearAnimationPresetsForTesting,
  animationPresets,
  removeAnimationPresetsOf,
  setAnimationPresetsOf,
  validateAnimationPreset,
} from "./animationPresets";
import { contributionStore } from "./contributions";
import { dispatchExtensionKeybinding } from "./keybindingSeam";

function presetJson(name: string, rotationEnd: number) {
  return {
    schema: 1,
    name,
    defaultMs: 600,
    rotation: [
      { at: 0, value: 0 },
      { at: 1, value: rotationEnd },
    ],
  };
}

function shapeOf(name: string, rotationEnd: number) {
  const result = validateAnimationPreset("acme.hello", name + ".json", presetJson(name, rotationEnd));
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.preset;
}

describe("the thumbnail cache follows the preset", () => {
  beforeEach(() => {
    __clearAnimationPresetsForTesting();
  });

  it("recomputes after an extension reloads with a changed move", () => {
    // The developer loop: edit the preset's JSON, save, the host restarts.
    // The id is the same and the move is not, so a cache that kept its entry
    // would show the previous move until the app was restarted.
    const first = shapeOf("wobble", 10);
    setAnimationPresetsOf("acme.hello", [{ fileName: "wobble.json", json: presetJson("wobble", 10) }]);
    const before = shapePreviewSamples(first.id, first.shape);

    setAnimationPresetsOf("acme.hello", [{ fileName: "wobble.json", json: presetJson("wobble", -80) }]);
    const second = shapeOf("wobble", -80);
    const after = shapePreviewSamples(second.id, second.shape);

    expect(second.id).toBe(first.id);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it("recomputes after the extension is removed and comes back", () => {
    const first = shapeOf("wobble", 10);
    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: presetJson("wobble", 10) }]);
    const before = shapePreviewSamples(first.id, first.shape);

    removeAnimationPresetsOf("acme.hello");
    const second = shapeOf("wobble", -80);
    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: presetJson("wobble", -80) }]);

    expect(JSON.stringify(shapePreviewSamples(second.id, second.shape))).not.toBe(
      JSON.stringify(before),
    );
  });

  it("leaves another extension's entry alone", () => {
    setAnimationPresetsOf("a.one", [{ fileName: "w.json", json: presetJson("wobble", 10) }]);
    setAnimationPresetsOf("b.two", [{ fileName: "w.json", json: presetJson("wobble", 10) }]);
    removeAnimationPresetsOf("a.one");
    expect(animationPresets().map((preset) => preset.extId)).toEqual(["b.two"]);
  });
});

describe("the keybinding seam never throws", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    contributionStore.getState().clear();
    warn.mockClear();
  });

  afterEach(() => {
    contributionStore.getState().clear();
  });

  it("answers false for an event that is missing everything", () => {
    // It runs from a `window` keydown listener, so whatever reaches the
    // handler reaches this. Answering false hands the key back to the editor.
    expect(dispatchExtensionKeybinding({} as never)).toBe(false);
    expect(dispatchExtensionKeybinding({ code: "" })).toBe(false);
    expect(dispatchExtensionKeybinding(null as never)).toBe(false);
  });

  it("answers false rather than throwing when the store is hostile", () => {
    const broken = contributionStore.getState();
    // A getter that throws stands in for anything that could go wrong between
    // here and the binding table. The editor's own arrow keys must survive it.
    const spy = vi.spyOn(contributionStore, "getState").mockImplementation(() => {
      throw new Error("the store is gone");
    });
    try {
      expect(dispatchExtensionKeybinding({ code: "KeyH", metaKey: true, altKey: true })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    void broken;
  });

  it("says something when it declines, so the cause is findable", () => {
    const spy = vi.spyOn(contributionStore, "getState").mockImplementation(() => {
      throw new Error("the store is gone");
    });
    try {
      dispatchExtensionKeybinding({ code: "KeyH", metaKey: true });
    } finally {
      spy.mockRestore();
    }
    expect(warn).toHaveBeenCalled();
  });
});
