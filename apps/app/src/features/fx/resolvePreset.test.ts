import { beforeEach, describe, expect, it } from "vitest";
import { coerceInlineProgram, hashProgram } from "./inlineProgram";
import { __setPresetsForTesting } from "./presetRegistry";
import type { FxPreset } from "./presetTypes";
import {
  __clearResolvedProgramsForTesting,
  inlineDiagnostics,
  resolvePreset,
} from "./resolvePreset";

const EFFECT = "vec4 effect(vec2 uv) { return getSourceColor(uv); }";

function program(fragment = EFFECT) {
  const result = coerceInlineProgram({
    kind: "effect",
    name: "Pass",
    render: { type: "shader", fragment },
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.program;
}

const INSTALLED: FxPreset = {
  schema: 1,
  id: "com.example.installed",
  kind: "effect",
  name: "Installed",
  category: "color",
  thumbnailPath: null,
  render: { type: "shader", source: "a.frag" },
  params: [],
  origin: "builtin",
  sources: { "a.frag": EFFECT },
  assets: {},
};

beforeEach(() => {
  __setPresetsForTesting([INSTALLED]);
  __clearResolvedProgramsForTesting();
});

describe("resolvePreset", () => {
  it("answers an installed preset from the registry", () => {
    expect(resolvePreset({ presetId: INSTALLED.id })).toBe(INSTALLED);
    expect(resolvePreset({ presetId: "com.example.missing" })).toBeNull();
  });

  it("builds an inline preset from the element's program", () => {
    const p = program();
    const preset = resolvePreset({ presetId: "inline." + p.hash, program: p });
    expect(preset?.origin).toBe("inline");
    expect(preset?.id).toBe("inline." + p.hash);
    expect(preset?.sources["main.frag"]).toBe(EFFECT);
  });

  it("answers the same object for the same program, every time", () => {
    const p = program();
    const a = resolvePreset({ presetId: "inline." + p.hash, program: p });
    const b = resolvePreset({ presetId: "inline." + p.hash, program: { ...p } });
    expect(b).toBe(a);
  });

  it("follows the program when the id and the hash disagree", () => {
    const p = program();
    const preset = resolvePreset({ presetId: "inline.0000000000000000", program: p });
    expect(preset?.id).toBe("inline." + p.hash);
  });

  it("follows the content when the stored hash is stale", () => {
    const p = program();
    const edited = {
      ...p,
      sources: { "main.frag": EFFECT.replace("return", "return 0.5 *") },
    };
    const preset = resolvePreset({ presetId: "inline." + p.hash, program: edited });
    expect(preset).not.toBeNull();
    expect(preset?.id).toBe("inline." + hashProgram(edited));
  });

  it("does not let two programs that claim one hash share a result", () => {
    const a = program();
    const b = { ...program(EFFECT.replace("return", "return 0.5 *")), hash: a.hash };
    const first = resolvePreset({ presetId: "inline." + a.hash, program: a });
    const second = resolvePreset({ presetId: "inline." + a.hash, program: b });
    expect(second).not.toBe(first);
    expect(second?.sources["main.frag"]).toContain("0.5 *");
  });

  it("answers null for an invalid program and says why", () => {
    const p = program();
    const broken = { ...p, sources: { "main.frag": "void f() {}" } };
    expect(resolvePreset({ presetId: "inline." + p.hash, program: broken })).toBeNull();
    const { errors } = inlineDiagnostics({ presetId: "x", program: broken });
    expect(errors[0]).toEqual({
      file: "main.frag",
      message: "must define `vec4 effect(vec2 uv)`",
    });
  });

  it("answers null for an inline id with no program, without throwing", () => {
    expect(resolvePreset({ presetId: "inline.abc" })).toBeNull();
    expect(inlineDiagnostics({ presetId: "inline.abc" }).errors).toHaveLength(1);
    expect(
      resolvePreset({ presetId: "inline.abc", program: { junk: true } as any }),
    ).toBeNull();
    expect(resolvePreset(null)).toBeNull();
  });

  it("reports nothing for an installed preset", () => {
    expect(inlineDiagnostics({ presetId: INSTALLED.id })).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
