import { beforeEach, describe, expect, it } from "vitest";

import {
  ANIMATION_PRESET_SCHEMA,
  MAX_STOPS,
  __clearAnimationPresetsForTesting,
  animationPresetById,
  animationPresets,
  isExtensionPresetId,
  removeAnimationPresetsOf,
  setAnimationPresetsOf,
  subscribeAnimationPresets,
  validateAnimationPreset,
} from "./animationPresets";

const good = (overrides: Record<string, unknown> = {}) => ({
  schema: ANIMATION_PRESET_SCHEMA,
  name: "wobble",
  label: "Wobble",
  defaultMs: 600,
  rotation: [
    { at: 0, value: 0, easing: "ease_out" },
    { at: 0.5, value: -4 },
    { at: 1, value: 0 },
  ],
  ...overrides,
});

function expectOk(json: unknown) {
  const result = validateAnimationPreset("acme.hello", "wobble.json", json);
  if (!result.ok) {
    throw new Error("expected a valid preset, got: " + result.errors.join("; "));
  }
  return result.preset;
}

function errorsOf(json: unknown): string[] {
  const result = validateAnimationPreset("acme.hello", "f.json", json);
  return result.ok ? [] : result.errors;
}

describe("validateAnimationPreset", () => {
  it("accepts a plain preset and namespaces its id", () => {
    // Two extensions naming a move `wobble` have to be two presets, not a
    // collision, and an id has to say which extension it came from.
    const preset = expectOk(good());
    expect(preset.id).toBe("ext:acme.hello:wobble");
    expect(preset.label).toBe("Wobble");
    expect(preset.shape.rotation).toHaveLength(3);
  });

  it("falls back to the name when there is no label", () => {
    expect(expectOk(good({ label: "  " })).label).toBe("wobble");
  });

  it("refuses a schema version it does not read", () => {
    expect(errorsOf(good({ schema: 2 })).join()).toContain("schema");
  });

  it("refuses a name that could not be an id", () => {
    for (const name of ["", "has space", "9leading", "a".repeat(80)]) {
      expect([name, errorsOf(good({ name })).length > 0]).toEqual([name, true]);
    }
  });

  it("refuses a preset that drives nothing", () => {
    expect(errorsOf({ schema: 1, name: "x", defaultMs: 100 }).join()).toContain("at least one");
  });

  it("needs at least two stops to describe a move", () => {
    expect(errorsOf(good({ rotation: [{ at: 0, value: 1 }] })).join()).toContain("two stops");
  });

  it("caps the number of stops", () => {
    // Not a limit any real preset meets. It is what stops a hand-edited file
    // asking the baker for a hundred thousand keyframes on one property.
    const many = Array.from({ length: MAX_STOPS + 1 }, (_, index) => ({
      at: index / (MAX_STOPS + 1),
      value: index,
    }));
    expect(errorsOf(good({ rotation: many })).join()).toContain("cap");
  });

  it("requires stops in order, so a curve cannot double back", () => {
    const errors = errorsOf(
      good({ rotation: [{ at: 0, value: 0 }, { at: 0.8, value: 1 }, { at: 0.2, value: 2 }] }),
    );
    expect(errors.join()).toContain("after the stop before it");
  });

  it("requires `at` to be a fraction of the preset's own duration", () => {
    expect(errorsOf(good({ rotation: [{ at: 0, value: 0 }, { at: 600, value: 1 }] })).join()).toContain(
      "0 to 1",
    );
  });

  it("refuses an easing this app does not have", () => {
    const errors = errorsOf(
      good({ rotation: [{ at: 0, value: 0, easing: "bouncy" }, { at: 1, value: 1 }] }),
    );
    expect(errors.join()).toContain("bouncy");
  });

  it("reads a position curve with x and y", () => {
    const preset = expectOk(
      good({
        rotation: undefined,
        position: [
          { at: 0, x: -100, y: 0 },
          { at: 1, x: 0, y: 0 },
        ],
        positionUnit: "box",
      }),
    );
    expect(preset.shape.position).toHaveLength(2);
    expect(preset.shape.positionUnit).toBe("box");
  });

  it("refuses a position stop missing an axis", () => {
    const errors = errorsOf(
      good({ rotation: undefined, position: [{ at: 0, x: 1 }, { at: 1, x: 0, y: 0 }] }),
    );
    expect(errors.join()).toContain("numeric");
  });

  it("refuses focusable on anything that already moves the clip", () => {
    // Focus works by counter-animating position, so a preset that moves has
    // nowhere to put it. The built-in table states the rule; this checks it.
    const errors = errorsOf(
      good({
        rotation: undefined,
        focusable: true,
        scale: [{ at: 0, value: 10 }, { at: 1, value: 12 }],
        position: [{ at: 0, x: 0, y: 0 }, { at: 1, x: 5, y: 5 }],
      }),
    );
    expect(errors.join()).toContain("focusable");
  });

  it("allows focusable on a scale-only preset", () => {
    const preset = expectOk(
      good({ rotation: undefined, focusable: true, scale: [{ at: 0, value: 10 }, { at: 1, value: 12 }] }),
    );
    expect(preset.shape.focusable).toBe(true);
  });

  it("omits every optional field it was not given", () => {
    // The optional-field rule: absent means default, so a shape carries only
    // what the file actually said.
    const shape = expectOk(good()).shape;
    expect("fromEnd" in shape).toBe(false);
    expect("positionUnit" in shape).toBe(false);
    expect("focusable" in shape).toBe(false);
    expect("scale" in shape).toBe(false);
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, undefined, 42, "text", []]) {
      expect([String(value), errorsOf(value).length > 0]).toEqual([String(value), true]);
    }
  });

  it("collects every error rather than stopping at the first", () => {
    expect(errorsOf({ schema: 9, name: "!", defaultMs: -1 }).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the registry", () => {
  beforeEach(() => {
    __clearAnimationPresetsForTesting();
  });

  it("holds what it accepted and reports what it refused", () => {
    const failures = setAnimationPresetsOf("acme.hello", [
      { fileName: "wobble.json", json: good() },
      { fileName: "broken.json", json: { schema: 1 } },
    ]);
    expect(animationPresets().map((preset) => preset.id)).toEqual(["ext:acme.hello:wobble"]);
    expect(failures.map((failure) => failure.fileName)).toEqual(["broken.json"]);
  });

  it("replaces an extension's presets rather than accumulating them", () => {
    setAnimationPresetsOf("acme.hello", [{ fileName: "a.json", json: good({ name: "one" }) }]);
    setAnimationPresetsOf("acme.hello", [{ fileName: "b.json", json: good({ name: "two" }) }]);
    expect(animationPresets().map((preset) => preset.name)).toEqual(["two"]);
  });

  it("keeps two extensions apart", () => {
    setAnimationPresetsOf("a.one", [{ fileName: "w.json", json: good() }]);
    setAnimationPresetsOf("b.two", [{ fileName: "w.json", json: good() }]);
    expect(animationPresets()).toHaveLength(2);

    removeAnimationPresetsOf("a.one");
    expect(animationPresets().map((preset) => preset.extId)).toEqual(["b.two"]);
  });

  it("finds one by its namespaced id", () => {
    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: good() }]);
    expect(animationPresetById("ext:acme.hello:wobble")?.name).toBe("wobble");
    expect(animationPresetById("wobble")).toBeNull();
  });

  it("tells subscribers when the set changes, and not otherwise", () => {
    let calls = 0;
    const stop = subscribeAnimationPresets(() => {
      calls += 1;
    });

    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: good() }]);
    expect(calls).toBe(1);

    removeAnimationPresetsOf("nobody.here");
    expect(calls).toBe(1);

    stop();
    removeAnimationPresetsOf("acme.hello");
    expect(calls).toBe(1);
  });
});

describe("isExtensionPresetId", () => {
  it("tells a contributed name from a built-in one", () => {
    expect(isExtensionPresetId("ext:acme.hello:wobble")).toBe(true);
    expect(isExtensionPresetId("fade_in")).toBe(false);
  });
});
