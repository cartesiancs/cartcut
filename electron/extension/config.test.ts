import { describe, expect, it } from "vitest";

import { coerceConfigValue, resolveConfig, type ConfigSchema } from "./config";

const SCHEMA: ConfigSchema = {
  "a.factor": { type: "number", default: 1.4, minimum: 1, maximum: 3 },
  "a.tracker": { type: "string", enum: ["mouse", "face"], default: "mouse" },
  "a.enabled": { type: "boolean", default: true },
  "a.steps": { type: "integer", default: 4, minimum: 1 },
  "a.label": { type: "string" },
};

describe("resolveConfig", () => {
  it("fills every declared key from its default", () => {
    expect(resolveConfig(SCHEMA, {})).toEqual({
      "a.factor": 1.4,
      "a.tracker": "mouse",
      "a.enabled": true,
      "a.steps": 4,
      "a.label": "",
    });
  });

  it("keeps a stored value that fits", () => {
    expect(resolveConfig(SCHEMA, { "a.factor": 2 })["a.factor"]).toBe(2);
  });

  it("falls back rather than converting a wrong type", () => {
    // Converting would make `"true"` become `true` and a setting silently
    // change meaning across a version.
    expect(resolveConfig(SCHEMA, { "a.enabled": "true" })["a.enabled"]).toBe(true);
    expect(resolveConfig(SCHEMA, { "a.factor": "2" })["a.factor"]).toBe(1.4);
  });

  it("falls back for a value outside its range", () => {
    expect(resolveConfig(SCHEMA, { "a.factor": 99 })["a.factor"]).toBe(1.4);
  });

  it("falls back for a value outside its enum", () => {
    expect(resolveConfig(SCHEMA, { "a.tracker": "elbow" })["a.tracker"]).toBe("mouse");
  });

  it("refuses a fractional integer", () => {
    expect(resolveConfig(SCHEMA, { "a.steps": 2.5 })["a.steps"]).toBe(4);
  });

  it("drops a key the schema no longer declares", () => {
    const values = resolveConfig(SCHEMA, { "a.removed": 1 });
    expect("a.removed" in values).toBe(false);
  });

  it("survives a hand-edited file that is not an object", () => {
    // It runs at activation, so throwing here would stop the extension from
    // loading rather than stopping it from being configured.
    expect(resolveConfig(SCHEMA, "not json at all")["a.factor"]).toBe(1.4);
    expect(resolveConfig(SCHEMA, null)["a.factor"]).toBe(1.4);
  });
});

describe("coerceConfigValue", () => {
  it("accepts a value that fits", () => {
    expect(coerceConfigValue(SCHEMA, "a.factor", 2)).toEqual({ ok: true, value: 2 });
  });

  it("names the setting when it refuses", () => {
    expect(coerceConfigValue(SCHEMA, "a.factor", 99)).toMatchObject({ ok: false });
    expect(coerceConfigValue(SCHEMA, "nope", 1)).toMatchObject({ ok: false });
  });
});
