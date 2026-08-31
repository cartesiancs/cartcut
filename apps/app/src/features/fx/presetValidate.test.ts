import { describe, it, expect } from "vitest";
import { isSafeRelativePath, validatePreset } from "./presetValidate";
import { defaultParamsOf, type RawPresetPayload } from "./presetTypes";

const TRANSITION_SOURCE = [
  "vec4 transition(vec2 uv) {",
  "  return mix(getFromColor(uv), getToColor(uv), progress);",
  "}",
].join("\n");

const EFFECT_SOURCE = [
  "vec4 effect(vec2 uv) {",
  "  return getSourceColor(uv);",
  "}",
].join("\n");

function payload(
  manifest: unknown,
  over: Partial<RawPresetPayload> = {},
): RawPresetPayload {
  return {
    id: "test",
    dir: "/presets/test",
    origin: "user",
    manifestJson:
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    sources: { "shader.frag": TRANSITION_SOURCE },
    assets: {},
    ...over,
  };
}

function baseManifest(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    id: "com.example.test",
    kind: "transition",
    name: "Test",
    category: "dissolve",
    render: { type: "shader", source: "shader.frag" },
    params: [],
    ...over,
  };
}

function expectErrors(result: ReturnType<typeof validatePreset>): string[] {
  if (result.ok) {
    throw new Error("expected validation to fail, but it succeeded");
  }
  return result.errors;
}

describe("a well-formed preset", () => {
  it("validates and carries its files through", () => {
    const result = validatePreset(payload(baseManifest()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.preset.id).toBe("com.example.test");
    expect(result.preset.kind).toBe("transition");
    expect(result.preset.origin).toBe("user");
    expect(result.preset.sources["shader.frag"]).toBe(TRANSITION_SOURCE);
  });
});

describe("the schema gate", () => {
  it("rejects unparseable JSON without throwing", () => {
    const errors = expectErrors(validatePreset(payload("{ not json")));
    expect(errors[0]).toContain("not valid JSON");
  });

  it("rejects a future schema version", () => {
    const errors = expectErrors(
      validatePreset(payload(baseManifest({ schema: 2 }))),
    );
    expect(errors[0]).toContain("schema");
  });

  it("rejects a missing or malformed id", () => {
    expect(
      expectErrors(validatePreset(payload(baseManifest({ id: "" })))).join(),
    ).toContain("id");
    expect(
      expectErrors(
        validatePreset(payload(baseManifest({ id: "../escape" }))),
      ).join(),
    ).toContain("id");
  });

  it("rejects an unknown kind", () => {
    const errors = expectErrors(
      validatePreset(payload(baseManifest({ kind: "filter" }))),
    );
    expect(errors.join()).toContain("kind");
  });
});

describe("path safety", () => {
  it("recognises a plain name and a subfolder", () => {
    expect(isSafeRelativePath("shader.frag")).toBe(true);
    expect(isSafeRelativePath("shaders/wipe.frag")).toBe(true);
  });

  it("refuses anything that could leave the folder", () => {
    expect(isSafeRelativePath("../shader.frag")).toBe(false);
    expect(isSafeRelativePath("a/../../b")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:/Windows/system32")).toBe(false);
    expect(isSafeRelativePath("a\\b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("./x")).toBe(false);
  });

  it("rejects a manifest that points outside the preset", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: { type: "shader", source: "../../../etc/passwd" },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("inside the preset");
  });

  it("rejects a reference to a file that was not enumerated", () => {
    // The loader only reads known extensions, so this is also how a manifest
    // naming `evil.js` fails: the file is simply not there to be referenced.
    const errors = expectErrors(
      validatePreset(
        payload(baseManifest({ render: { type: "shader", source: "evil.js" } })),
      ),
    );
    expect(errors.join()).toContain("not a shader file here");
  });
});

describe("render blocks", () => {
  it("refuses an overlay transition — there is no second input to mix", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: { type: "overlay", source: "clip.mp4" },
          }),
          { assets: { "clip.mp4": "/presets/test/clip.mp4" } },
        ),
      ),
    );
    expect(errors.join()).toContain("must be a shader, not an overlay");
  });

  it("accepts an overlay effect", () => {
    const result = validatePreset(
      payload(
        baseManifest({
          kind: "effect",
          category: "texture",
          render: {
            type: "overlay",
            source: "rain.mp4",
            loop: true,
            blend: "screen",
            fit: "cover",
          },
        }),
        { assets: { "rain.mp4": "/presets/test/rain.mp4" }, sources: {} },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.render).toMatchObject({
      type: "overlay",
      source: "rain.mp4",
      blend: "screen",
    });
  });

  it("accepts a mesh and a vertex shader, the 3D escape hatch", () => {
    const result = validatePreset(
      payload(
        baseManifest({
          render: {
            type: "shader",
            source: "shader.frag",
            vertex: "shader.vert",
            mesh: { kind: "grid", cols: 20, rows: 20 },
          },
        }),
        {
          sources: {
            "shader.frag": TRANSITION_SOURCE,
            "shader.vert": "attribute vec2 _p; void main() {}",
          },
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.render).toMatchObject({
      mesh: { kind: "grid", cols: 20, rows: 20 },
      vertex: "shader.vert",
    });
  });

  it("bounds grid subdivision", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              mesh: { kind: "grid", cols: 10000, rows: 2 },
            },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("1..256");
  });

  it("binds shipped textures to samplers", () => {
    const result = validatePreset(
      payload(
        baseManifest({
          render: {
            type: "shader",
            source: "shader.frag",
            textures: [{ uniform: "lumaMask", source: "mask.png" }],
          },
        }),
        { assets: { "mask.png": "/presets/test/mask.png" } },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.render).toMatchObject({
      textures: [{ uniform: "lumaMask", source: "mask.png" }],
    });
  });

  it("refuses a texture bound to a host-owned name", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              textures: [{ uniform: "from", source: "mask.png" }],
            },
          }),
          { assets: { "mask.png": "/presets/test/mask.png" } },
        ),
      ),
    );
    expect(errors.join()).toContain("supplied by the host");
  });
});

describe("precompute — the closed-enum answer to a JS hook", () => {
  it("accepts the implemented kind", () => {
    const result = validatePreset(
      payload(
        baseManifest({
          render: {
            type: "shader",
            source: "shader.frag",
            precompute: { kind: "luma", source: "mask.png" },
          },
        }),
        { assets: { "mask.png": "/presets/test/mask.png" } },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("says a reserved kind is unimplemented rather than unknown", () => {
    // The difference matters: "unknown" sends an author hunting for a typo.
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              precompute: { kind: "opticalFlow" },
            },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("not implemented in this build");
  });

  it("rejects a kind that is not in the enum at all", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              precompute: { kind: "runMyJavaScript" },
            },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("must be one of");
  });
});

describe("parameters", () => {
  function withParams(params: unknown[], source: string) {
    return payload(baseManifest({ params }), {
      sources: { "shader.frag": source },
    });
  }

  const numberParam = {
    key: "amount",
    label: "Amount",
    type: "number",
    uniform: "amount",
    default: 0.5,
    min: 0,
    max: 1,
  };

  it("accepts all four kinds", () => {
    const source = [
      "uniform float amount;",
      "uniform vec3 tint;",
      "uniform float flag;",
      "uniform float mode;",
      TRANSITION_SOURCE,
    ].join("\n");

    const result = validatePreset(
      withParams(
        [
          numberParam,
          { key: "tint", label: "Tint", type: "color", uniform: "tint", default: "#ffffff" },
          { key: "flag", label: "Flag", type: "bool", uniform: "flag", default: true },
          {
            key: "mode",
            label: "Mode",
            type: "select",
            uniform: "mode",
            default: 1,
            options: [
              { value: 0, label: "A" },
              { value: 1, label: "B" },
            ],
          },
        ],
        source,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(defaultParamsOf(result.preset)).toEqual({
      amount: 0.5,
      tint: "#ffffff",
      flag: true,
      mode: 1,
    });
  });

  it("rejects an unknown parameter type", () => {
    const errors = expectErrors(
      validatePreset(
        withParams(
          [{ ...numberParam, type: "curve" }],
          "uniform float amount;\n" + TRANSITION_SOURCE,
        ),
      ),
    );
    expect(errors.join()).toContain("`type` must be one of");
  });

  it("rejects a default outside min..max", () => {
    const errors = expectErrors(
      validatePreset(
        withParams(
          [{ ...numberParam, default: 5 }],
          "uniform float amount;\n" + TRANSITION_SOURCE,
        ),
      ),
    );
    expect(errors.join()).toContain("outside");
  });

  it("rejects a select default that is not an option", () => {
    const errors = expectErrors(
      validatePreset(
        withParams(
          [
            {
              key: "mode",
              label: "Mode",
              type: "select",
              uniform: "mode",
              default: 9,
              options: [{ value: 0, label: "A" }],
            },
          ],
          "uniform float mode;\n" + TRANSITION_SOURCE,
        ),
      ),
    );
    expect(errors.join()).toContain("one of the option values");
  });

  it("rejects a uniform that shadows a host name", () => {
    const errors = expectErrors(
      validatePreset(
        withParams(
          [{ ...numberParam, uniform: "progress" }],
          "uniform float progress;\n" + TRANSITION_SOURCE,
        ),
      ),
    );
    expect(errors.join()).toContain("supplied by the host");
  });

  it("rejects a gl_ prefixed uniform", () => {
    const errors = expectErrors(
      validatePreset(
        withParams([{ ...numberParam, uniform: "gl_Thing" }], TRANSITION_SOURCE),
      ),
    );
    expect(errors.join()).toContain("reserved by GLSL");
  });

  it("rejects a uniform that is not a GLSL identifier", () => {
    const errors = expectErrors(
      validatePreset(
        withParams([{ ...numberParam, uniform: "2fast" }], TRANSITION_SOURCE),
      ),
    );
    expect(errors.join()).toContain("GLSL identifier");
  });

  it("rejects duplicate keys and duplicate uniforms", () => {
    const source = "uniform float amount;\nuniform float other;\n" + TRANSITION_SOURCE;
    expect(
      expectErrors(
        validatePreset(withParams([numberParam, numberParam], source)),
      ).join(),
    ).toContain("duplicate key");

    expect(
      expectErrors(
        validatePreset(
          withParams(
            [numberParam, { ...numberParam, key: "other" }],
            source,
          ),
        ),
      ).join(),
    ).toContain("duplicate uniform");
  });
});

describe("cross-checking the manifest against the shader", () => {
  it("rejects a parameter the shader never declares", () => {
    // Caught at load rather than at first paint, so an author sees "you
    // declared `amount` but the shader never does" instead of a control that
    // silently does nothing.
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            params: [
              {
                key: "amount",
                label: "Amount",
                type: "number",
                uniform: "amount",
                default: 0.5,
                min: 0,
                max: 1,
              },
            ],
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("no stage of this preset declares");
  });

  it("accepts a uniform only the vertex shader reads", () => {
    // The reason the check spans stages rather than reading `render.source`
    // alone. A mesh preset does its work in the vertex shader — a cube's
    // `direction` chooses which way it turns, and the fragment stage has no
    // use for it. Requiring a decorative re-declaration there was the previous
    // behaviour, and it is exactly the kind of rule an author cannot guess.
    const result = validatePreset(
      payload(
        baseManifest({
          render: {
            type: "shader",
            source: "shader.frag",
            vertex: "shader.vert",
            mesh: { kind: "cube" },
          },
          params: [
            {
              key: "direction",
              label: "Direction",
              type: "number",
              uniform: "direction",
              default: 0,
              min: 0,
              max: 3,
            },
          ],
        }),
        {
          sources: {
            "shader.frag": TRANSITION_SOURCE,
            "shader.vert": [
              "attribute vec2 _p;",
              "varying vec2 _uv;",
              "uniform float direction;",
              "void main() {",
              "  gl_Position = vec4(_p * direction, 0.0, 1.0);",
              "  _uv = _p * 0.5 + 0.5;",
              "}",
            ].join("\n"),
          },
        },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("still refuses a vertex uniform nothing binds", () => {
    // The reverse check has to span stages too, or widening the first one would
    // have opened a hole: a vertex shader reading an unbound uniform gets zero
    // and silently collapses the geometry.
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              vertex: "shader.vert",
              mesh: { kind: "cube" },
            },
          }),
          {
            sources: {
              "shader.frag": TRANSITION_SOURCE,
              "shader.vert": [
                "attribute vec2 _p;",
                "varying vec2 _uv;",
                "uniform float twist;",
                "void main() {",
                "  gl_Position = vec4(_p * twist, 0.0, 1.0);",
                "  _uv = _p * 0.5 + 0.5;",
                "}",
              ].join("\n"),
            },
          },
        ),
      ),
    );
    expect(errors.join()).toContain("`twist`");
  });

  it("wants a vertex shader from any mesh that is not a quad", () => {
    // The host's vertex shader maps a screen-filling quad. Handed a lattice it
    // draws overlapping copies of the frame — which compiles and links, so
    // nothing downstream would report it.
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              mesh: { kind: "grid", cols: 8, rows: 8 },
            },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("render.vertex");
  });

  it("rejects a shader with no entry point", () => {
    const errors = expectErrors(
      validatePreset(
        payload(baseManifest(), {
          sources: { "shader.frag": "vec4 nope(vec2 uv) { return vec4(0.0); }" },
        }),
      ),
    );
    expect(errors.join()).toContain("vec4 transition(vec2 uv)");
  });

  it("wants `effect` from an effect and `transition` from a transition", () => {
    const asEffect = validatePreset(
      payload(baseManifest({ kind: "effect", category: "color" }), {
        sources: { "shader.frag": EFFECT_SOURCE },
      }),
    );
    expect(asEffect.ok).toBe(true);

    const mismatched = expectErrors(
      validatePreset(
        payload(baseManifest({ kind: "effect", category: "color" }), {
          sources: { "shader.frag": TRANSITION_SOURCE },
        }),
      ),
    );
    expect(mismatched.join()).toContain("vec4 effect(vec2 uv)");
  });
});

/**
 * An unmodified shader from the `gl-transitions` catalogue.
 *
 * The whole reason for adopting upstream's contract instead of inventing one.
 * If this needed a single edit to load, the claim that eighty existing
 * transitions drop straight in would be false.
 */
describe("porting a gl-transitions shader unchanged", () => {
  // github.com/gl-transitions/gl-transitions — "Directional", Gunnar Roth.
  const DIRECTIONAL = [
    "// Author: Gunnar Roth",
    "// Based on work of Ben Lucas",
    "uniform vec2 direction; // = vec2(0.0, 1.0)",
    "",
    "vec4 transition (vec2 uv) {",
    "  vec2 p = uv + progress * sign(direction);",
    "  vec2 f = fract(p);",
    "  return mix(",
    "    getToColor(f),",
    "    getFromColor(f),",
    "    step(0.0, p.y) * step(p.y, 1.0) * step(0.0, p.x) * step(p.x, 1.0)",
    "  );",
    "}",
  ].join("\n");

  it("loads with a manifest and no edit to the shader", () => {
    const result = validatePreset(
      payload(
        baseManifest({
          id: "org.gl-transitions.directional",
          name: "Directional",
          params: [
            {
              key: "direction",
              label: "Direction",
              type: "point",
              uniform: "direction",
              default: [0, 1],
              min: -1,
              max: 1,
            },
          ],
        }),
        { sources: { "shader.frag": DIRECTIONAL } },
      ),
    );

    if (!result.ok) {
      throw new Error("should have loaded:\n  " + result.errors.join("\n  "));
    }
    expect(defaultParamsOf(result.preset)).toEqual({ direction: [0, 1] });
  });

  it("is refused when the manifest leaves a uniform unbound", () => {
    // Upstream carries defaults in a trailing comment, which nothing reads. An
    // unbound uniform reads zero — a `direction` of (0,0) makes this transition
    // do nothing — and no error would be raised anywhere at run time.
    const errors = expectErrors(
      validatePreset(
        payload(baseManifest({ params: [] }), {
          sources: { "shader.frag": DIRECTIONAL },
        }),
      ),
    );
    expect(errors.join()).toContain("would read zero at run time");
  });

  it("is refused when the parameter binds the wrong GLSL type", () => {
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            params: [
              {
                key: "direction",
                label: "Direction",
                type: "number",
                uniform: "direction",
                default: 0,
                min: -1,
                max: 1,
              },
            ],
          }),
          { sources: { "shader.frag": DIRECTIONAL } },
        ),
      ),
    );
    expect(errors.join()).toContain("binds a float");
    expect(errors.join()).toContain("declares `direction` as vec2");
  });
});

describe("multi-pass", () => {
  const BLUR = "uniform vec2 dir;\nvec4 effect(vec2 uv){ return getSourceColor(uv); }";
  const COMBINE = "vec4 effect(vec2 uv){ return mix(getOriginalColor(uv), getSourceColor(uv), 0.5); }";

  function multiPass(passes: unknown, sources?: Record<string, string>) {
    return payload(
      baseManifest({
        kind: "effect",
        category: "blur",
        render: { type: "shader", source: "combine.frag", passes },
      }),
      {
        sources: sources ?? {
          "combine.frag": COMBINE,
          "blur.frag": BLUR,
        },
      },
    );
  }

  it("accepts a chain and keeps its order", () => {
    const result = validatePreset(
      multiPass([
        { source: "blur.frag", constants: { dir: [1, 0] } },
        { source: "blur.frag", constants: { dir: [0, 1] } },
      ]),
    );
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    const render = result.preset.render;
    if (render.type !== "shader") throw new Error("not a shader");
    expect(render.passes).toEqual([
      { source: "blur.frag", constants: { dir: [1, 0] } },
      { source: "blur.frag", constants: { dir: [0, 1] } },
    ]);
    // `source` stays the final pass.
    expect(render.source).toBe("combine.frag");
  });

  it("lets one shader file serve several passes", () => {
    // The point of `constants`: a separable blur is the same code run twice on
    // different axes, and without this it would be two near-identical files —
    // exactly the duplication the catalogue rules forbid.
    const result = validatePreset(
      multiPass([
        { source: "blur.frag", constants: { dir: [1, 0] } },
        { source: "blur.frag", constants: { dir: [0, 1] } },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts scalar and vector constants", () => {
    const result = validatePreset(
      multiPass([{ source: "blur.frag", constants: { dir: [1, 0], amount: 4 } }]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a constant that is not a number or 2-4 numbers", () => {
    for (const bad of ["x", [1], [1, 2, 3, 4, 5], true, null]) {
      const errors = expectErrors(
        validatePreset(multiPass([{ source: "blur.frag", constants: { dir: bad } }])),
      );
      expect(errors.join()).toContain("must be a number or 2-4 numbers");
    }
  });

  it("rejects a pass naming a file that is not a shader here", () => {
    const errors = expectErrors(
      validatePreset(multiPass([{ source: "nope.frag" }])),
    );
    expect(errors.join()).toContain("not a shader file here");
  });

  it("rejects a pass pointing outside the preset", () => {
    const errors = expectErrors(
      validatePreset(multiPass([{ source: "../../etc/passwd" }])),
    );
    expect(errors.join()).toContain("inside the preset");
  });

  it("bounds the pipeline length", () => {
    const errors = expectErrors(
      validatePreset(
        multiPass(Array.from({ length: 9 }, () => ({ source: "blur.frag" }))),
      ),
    );
    expect(errors.join()).toContain("at most 8 passes");
  });

  it("refuses passes on a transition", () => {
    // A transition mixes two inputs and hands back one image; there is no
    // previous-pass output for a second step to read.
    const errors = expectErrors(
      validatePreset(
        payload(
          baseManifest({
            render: {
              type: "shader",
              source: "shader.frag",
              passes: [{ source: "shader.frag" }],
            },
          }),
        ),
      ),
    );
    expect(errors.join()).toContain("only an effect may declare passes");
  });

  it("leaves a single-pass preset with no passes field at all", () => {
    // Every preset written before multi-pass existed must keep taking the
    // original code path.
    const result = validatePreset(
      payload(baseManifest({ kind: "effect", category: "color" }), {
        sources: { "shader.frag": EFFECT_SOURCE },
      }),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const render = result.preset.render;
    if (render.type !== "shader") throw new Error("not a shader");
    expect("passes" in render).toBe(false);
  });
});

describe("category", () => {
  it("is required", () => {
    const { category: _dropped, ...without } = baseManifest();
    const errors = expectErrors(validatePreset(payload(without)));
    expect(errors.join()).toContain("category");
  });

  it("is checked against the right list for the kind", () => {
    // `blur` is an effect category; a transition may not claim it.
    const errors = expectErrors(
      validatePreset(payload(baseManifest({ category: "blur" }))),
    );
    expect(errors.join()).toContain("for a transition");

    const okAsEffect = validatePreset(
      payload(baseManifest({ kind: "effect", category: "blur" }), {
        sources: { "shader.frag": EFFECT_SOURCE },
      }),
    );
    expect(okAsEffect.ok).toBe(true);
  });

  it("rejects one that is in neither list", () => {
    const errors = expectErrors(
      validatePreset(payload(baseManifest({ category: "sparkles" }))),
    );
    expect(errors.join()).toContain("must be one of");
  });
});

describe("the lut kind", () => {
  function lutManifest(over: Record<string, unknown> = {}) {
    return {
      schema: 1,
      id: "com.example.grade",
      kind: "lut",
      name: "Grade",
      category: "film",
      render: { type: "lut", source: "lut.cube" },
      ...over,
    };
  }

  /** What the scanner reports for a LUT: the file as a path, unread. */
  const lutPayload = (manifest: unknown, over: Record<string, unknown> = {}) =>
    payload(manifest, {
      sources: {},
      assets: { "lut.cube": "/presets/test/lut.cube" },
      ...over,
    });

  it("validates with no shader, no entry point and no parameters", () => {
    // The point of a third kind: every LUT preset runs the app's own shader, so
    // there is nothing here to compile and nothing to cross-check against.
    const result = validatePreset(lutPayload(lutManifest()));
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.preset.kind).toBe("lut");
    expect(result.preset.render).toEqual({ type: "lut", source: "lut.cube" });
    expect(result.preset.params).toEqual([]);
  });

  it("accepts an image LUT as its source", () => {
    const result = validatePreset(
      lutPayload(lutManifest({ render: { type: "lut", source: "hald.png" } }), {
        assets: { "hald.png": "/presets/test/hald.png" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a source that is not in the folder", () => {
    const errors = expectErrors(
      validatePreset(lutPayload(lutManifest(), { assets: {} })),
    );
    expect(errors.join(" ")).toMatch(/not a \.cube, \.3dl or image file here/);
  });

  it("refuses a source that tries to leave the folder", () => {
    // The same rule every other path in a manifest follows.
    const errors = expectErrors(
      validatePreset(
        lutPayload(
          lutManifest({ render: { type: "lut", source: "../../../etc/passwd" } }),
        ),
      ),
    );
    expect(errors.join(" ")).toMatch(/must be a path inside the preset/);
  });

  it("refuses a lut preset that renders a shader", () => {
    const errors = expectErrors(
      validatePreset(
        lutPayload(lutManifest({ render: { type: "shader", source: "shader.frag" } })),
      ),
    );
    expect(errors.join(" ")).toMatch(/a lut preset must be `lut`/);
  });

  it("refuses an effect preset that renders a lut", () => {
    const errors = expectErrors(
      validatePreset(
        lutPayload(
          lutManifest({
            kind: "effect",
            category: "color",
            render: { type: "lut", source: "lut.cube" },
          }),
        ),
      ),
    );
    expect(errors.join(" ")).toMatch(/only a `lut` preset may render a lut/);
  });

  it("holds a lut to the lut categories, not the effect ones", () => {
    const errors = expectErrors(
      validatePreset(lutPayload(lutManifest({ category: "stylize" }))),
    );
    expect(errors.join(" ")).toMatch(/must be one of .*log-convert/);
  });

  it("names all three kinds when it does not recognise one", () => {
    const errors = expectErrors(
      validatePreset(lutPayload(lutManifest({ kind: "colour" }))),
    );
    expect(errors.join(" ")).toMatch(/`effect`, `transition` or `lut`/);
  });
});
