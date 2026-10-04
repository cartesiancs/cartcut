import { describe, expect, it } from "vitest";
import {
  coerceInlineProgram,
  diagnosticOf,
  hashProgram,
  inlinePresetId,
  programFromInput,
  sameProgram,
  toRawPayload,
  type InlineProgramInput,
} from "./inlineProgram";
import { canonicalProgramText, stableStringify } from "./programHash";
import {
  MAX_INLINE_SOURCE_BYTES,
  validatePreset,
} from "./presetValidate";

export const AMOUNT_EFFECT = [
  "uniform float amount;",
  "vec4 effect(vec2 uv) {",
  "  vec4 c = getSourceColor(uv);",
  "  return vec4(c.rgb * amount, c.a);",
  "}",
].join("\n");

function effectInput(over: Partial<InlineProgramInput> = {}): InlineProgramInput {
  return {
    kind: "effect",
    name: "Dim",
    render: { type: "shader", fragment: AMOUNT_EFFECT },
    params: [
      {
        key: "amount",
        label: "Amount",
        uniform: "amount",
        type: "number",
        default: 0.5,
        min: 0,
        max: 2,
      },
    ],
    ...over,
  };
}

function coerced(input: unknown) {
  const result = coerceInlineProgram(input);
  if (!result.ok) {
    throw new Error("expected success: " + JSON.stringify(result.errors));
  }
  return result;
}

function refused(input: unknown) {
  const result = coerceInlineProgram(input);
  if (result.ok) {
    throw new Error("expected the program to be refused");
  }
  return result.errors;
}

describe("stableStringify", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,1]},"b":1}',
    );
  });

  it("drops undefined members the way JSON.stringify does", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("the hash", () => {
  it("does not depend on key order", () => {
    const a = programFromInput(effectInput());
    const reordered = {
      sources: { ...a.sources },
      manifest: Object.fromEntries(Object.entries(a.manifest).reverse()),
    };
    expect(hashProgram(reordered)).toBe(hashProgram(a));
  });

  it("moves when one character of a source moves", () => {
    const a = programFromInput(effectInput());
    const b = programFromInput(
      effectInput({
        render: { type: "shader", fragment: AMOUNT_EFFECT.replace("c.a", "1.0") },
      }),
    );
    expect(hashProgram(a)).not.toBe(hashProgram(b));
  });

  it("treats an empty asset map and an absent one as one program", () => {
    const a = programFromInput(effectInput());
    expect(canonicalProgramText({ ...a, assets: {} })).toBe(
      canonicalProgramText(a),
    );
  });

  it("ignores an id in the manifest, which is derived from it", () => {
    const a = programFromInput(effectInput());
    expect(
      hashProgram({ ...a, manifest: { ...a.manifest, id: "inline.x" } }),
    ).toBe(hashProgram(a));
  });
});

describe("programFromInput", () => {
  it("unpacks passes into fixed file names", () => {
    const content = programFromInput(
      effectInput({
        render: {
          type: "shader",
          fragment: AMOUNT_EFFECT,
          passes: [{ fragment: "a" }, { fragment: "b", constants: { k: 1 } }],
        },
      }),
    );
    expect(Object.keys(content.sources).sort()).toEqual([
      "main.frag",
      "pass0.frag",
      "pass1.frag",
    ]);
    expect((content.manifest.render as any).passes).toEqual([
      { source: "pass0.frag" },
      { source: "pass1.frag", constants: { k: 1 } },
    ]);
  });

  it("gives each kind a category its list accepts", () => {
    expect(programFromInput(effectInput()).manifest.category).toBe("stylize");
    expect(
      programFromInput(effectInput({ kind: "transition" })).manifest.category,
    ).toBe("distort");
  });
});

describe("coerceInlineProgram", () => {
  it("stores a valid effect with an id that is its hash", () => {
    const { program, warnings } = coerced(effectInput());
    expect(program.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(warnings).toEqual([]);
    const validated = validatePreset(toRawPayload(program));
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.preset.id).toBe(inlinePresetId(program.hash));
      expect(validated.preset.origin).toBe("inline");
    }
  });

  it("gives two equal programs the same id", () => {
    expect(coerced(effectInput()).program.hash).toBe(
      coerced(effectInput()).program.hash,
    );
  });

  it("refuses a source without the entry point, naming the file", () => {
    const errors = refused(
      effectInput({
        render: { type: "shader", fragment: "uniform float amount; void f() {}" },
      }),
    );
    expect(errors).toContainEqual({
      file: "main.frag",
      message: "must define `vec4 effect(vec2 uv)`",
    });
  });

  it("refuses a parameter the shader never declares", () => {
    const errors = refused(
      effectInput({
        render: {
          type: "shader",
          fragment: "vec4 effect(vec2 uv) { return getSourceColor(uv); }",
        },
      }),
    );
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /declares uniform `amount`, which no stage/,
    );
  });

  it("refuses passes on a transition", () => {
    const errors = refused({
      kind: "transition",
      name: "x",
      render: {
        type: "shader",
        fragment:
          "vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress); }",
        passes: [{ fragment: "vec4 transition(vec2 uv) { return vec4(1.0); }" }],
      },
    });
    expect(errors.map((e) => e.message)).toContain(
      "render.passes: only an effect may declare passes",
    );
  });

  it("refuses an oversized source", () => {
    const big = AMOUNT_EFFECT + "\n// " + "x".repeat(MAX_INLINE_SOURCE_BYTES);
    const errors = refused(effectInput({ render: { type: "shader", fragment: big } }));
    expect(errors.some((e) => /more than/.test(e.message))).toBe(true);
  });

  it("refuses a malformed input before trying to build it", () => {
    expect(refused(null)).toEqual([{ message: "program: must be an object" }]);
    expect(
      refused({ kind: "effect", name: "", render: { type: "shader", fragment: "" } })
        .map((e) => e.message),
    ).toEqual([
      "name: must be a non-empty string",
      "render.fragment: must be GLSL source",
    ]);
  });
});

describe("the validator's inline rules", () => {
  it("refuses an inline id that does not match the content", () => {
    const { program } = coerced(effectInput());
    const payload = toRawPayload({ ...program, hash: "0000000000000000" });
    const result = validatePreset(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/hash of its content/);
    }
  });

  it("refuses an installed preset that borrows the inline prefix", () => {
    const { program } = coerced(effectInput());
    const payload = { ...toRawPayload(program), origin: "user" as const };
    const result = validatePreset(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/reserved for programs carried on a clip/);
    }
  });

  it("refuses textures and meshes, which name files an inline program has not got", () => {
    const { program } = coerced(effectInput());
    const manifest = {
      ...program.manifest,
      render: {
        type: "shader",
        source: "main.frag",
        textures: [{ uniform: "noise", source: "noise.png" }],
      },
    };
    const sources = program.sources;
    const assets = { "noise.png": "/abs/noise.png" };
    const hash = hashProgram({ manifest: manifest as any, sources, assets });
    const result = validatePreset(
      toRawPayload({ hash, manifest: manifest as any, sources, assets }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/render.textures: not available/);
    }
  });
});

describe("diagnosticOf", () => {
  it("pulls a leading file name out of a message", () => {
    expect(diagnosticOf("main.frag: oops", { "main.frag": "" })).toEqual({
      file: "main.frag",
      message: "oops",
    });
    expect(diagnosticOf("render.type: oops", { "main.frag": "" })).toEqual({
      message: "render.type: oops",
    });
  });
});

describe("sameProgram", () => {
  it("compares content, not identity or the stored hash", () => {
    const { program } = coerced(effectInput());
    expect(sameProgram(program, { ...program })).toBe(true);
    expect(sameProgram(program, { ...program, hash: "x" })).toBe(true);
    expect(
      sameProgram(program, {
        ...program,
        sources: { "main.frag": AMOUNT_EFFECT + " " },
      }),
    ).toBe(false);
    expect(sameProgram(null, undefined)).toBe(true);
    expect(sameProgram(program, null)).toBe(false);
  });
});
