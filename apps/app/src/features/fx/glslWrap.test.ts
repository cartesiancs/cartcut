import { describe, it, expect } from "vitest";
import {
  EFFECT_VERTEX_SHADER,
  RESERVED_EFFECT_UNIFORMS,
  RESERVED_TRANSITION_UNIFORMS,
  TRANSITION_VERTEX_SHADER,
  colorToVec3,
  declaresEntryPoint,
  declaresUniform,
  entryPointOf,
  reservedUniformsFor,
  uniformValueOf,
  vertexShaderFor,
  wrapFragmentShader,
} from "./glslWrap";
import type { FxParamSpec } from "./presetTypes";

describe("the gl-transitions contract", () => {
  const upstream = [
    "// A transition copied from gl-transitions, unedited.",
    "uniform float smoothness;",
    "vec4 transition(vec2 uv) {",
    "  return mix(getFromColor(uv), getToColor(uv), progress * smoothness);",
    "}",
  ].join("\n");

  const wrapped = wrapFragmentShader({ kind: "transition", source: upstream });

  it("supplies the uniforms upstream shaders expect by name", () => {
    // These exact names are the contract. Renaming any of them to something
    // like `u_from` would break every shader in the ecosystem.
    expect(wrapped).toContain("uniform sampler2D from, to;");
    expect(wrapped).toContain(
      "uniform float progress, ratio, _fromR, _toR;",
    );
  });

  it("supplies both aspect-correcting samplers", () => {
    expect(wrapped).toContain("vec4 getFromColor(vec2 uv)");
    expect(wrapped).toContain("vec4 getToColor(vec2 uv)");
  });

  it("calls the author's entry point from main", () => {
    expect(wrapped).toContain("gl_FragColor = transition(_uv);");
  });

  it("includes the author's source verbatim", () => {
    expect(wrapped).toContain(upstream.trim());
  });

  it("does NOT redeclare the author's parameter uniforms", () => {
    // The single most important property here. Upstream shaders declare their
    // own parameters, so a wrapper that also emitted `uniform float smoothness`
    // would produce a duplicate declaration and fail to compile — silently
    // excluding the entire existing ecosystem.
    const declarations = wrapped.match(/uniform float smoothness;/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("declares host-bound textures, which the author cannot know about", () => {
    const withTexture = wrapFragmentShader({
      kind: "transition",
      source: upstream,
      textureUniforms: ["lumaMask"],
    });
    expect(withTexture).toContain("uniform sampler2D lumaMask;");
  });

  it("declares a precompute sampler when one was requested", () => {
    const withPrecompute = wrapFragmentShader({
      kind: "transition",
      source: upstream,
      precomputeUniform: "_precomputed",
    });
    expect(withPrecompute).toContain("uniform sampler2D _precomputed;");
  });

  it("emits no texture block when there are none", () => {
    expect(wrapped).not.toContain("uniform sampler2D lumaMask");
  });
});

describe("the effect contract", () => {
  const source = [
    "uniform float amount;",
    "vec4 effect(vec2 uv) {",
    "  return getSourceColor(uv) * amount;",
    "}",
  ].join("\n");

  const wrapped = wrapFragmentShader({ kind: "effect", source });

  it("gives the shader the frame beneath it as `source`", () => {
    expect(wrapped).toContain("uniform sampler2D source;");
    expect(wrapped).toContain("vec4 getSourceColor(vec2 uv)");
  });

  it("always supplies `intensity`, whatever the preset declares", () => {
    expect(wrapped).toContain("uniform float intensity;");
  });

  it("supplies the frame size for pixel-space work", () => {
    expect(wrapped).toContain("uniform vec2 resolution;");
  });

  it("calls `effect`, not `transition`", () => {
    expect(wrapped).toContain("gl_FragColor = effect(_uv);");
    expect(wrapped).not.toContain("transition(_uv)");
  });
});

describe("entryPointOf / reservedUniformsFor", () => {
  it("names the function each kind must define", () => {
    expect(entryPointOf("transition")).toBe("transition");
    expect(entryPointOf("effect")).toBe("effect");
  });

  it("reserves the host's names per kind", () => {
    expect(reservedUniformsFor("transition")).toBe(
      RESERVED_TRANSITION_UNIFORMS,
    );
    expect(reservedUniformsFor("effect")).toBe(RESERVED_EFFECT_UNIFORMS);
    expect(reservedUniformsFor("transition")).toContain("progress");
    expect(reservedUniformsFor("effect")).toContain("intensity");
  });
});

describe("vertexShaderFor", () => {
  it("uses the standard quad by default", () => {
    expect(vertexShaderFor("transition")).toBe(TRANSITION_VERTEX_SHADER);
    expect(vertexShaderFor("effect")).toBe(EFFECT_VERTEX_SHADER);
  });

  it("maps the clip cube to the 0..1 space transitions sample in", () => {
    expect(TRANSITION_VERTEX_SHADER).toContain(
      "_uv = vec2(0.5, 0.5) * (_p + vec2(1.0, 1.0));",
    );
  });

  it("hands over to a preset's own vertex shader when it ships one", () => {
    const custom = "attribute vec2 _p; void main() {}";
    expect(vertexShaderFor("transition", custom)).toBe(custom);
  });

  it("ignores an empty override rather than compiling nothing", () => {
    expect(vertexShaderFor("transition", "   ")).toBe(
      TRANSITION_VERTEX_SHADER,
    );
  });
});

describe("declaresUniform", () => {
  it("finds a plain declaration", () => {
    expect(declaresUniform("uniform float amount;", "amount")).toBe(true);
  });

  it("finds one in a comma-separated list", () => {
    expect(declaresUniform("uniform float a, b, c;", "b")).toBe(true);
  });

  it("tolerates a precision qualifier and odd spacing", () => {
    expect(declaresUniform("uniform  highp   vec3   tint ;", "tint")).toBe(
      true,
    );
  });

  it("does not match a mere mention in the body", () => {
    expect(declaresUniform("vec4 effect(vec2 uv){ return vec4(amount); }", "amount"))
      .toBe(false);
  });

  it("does not match a longer name that contains it", () => {
    expect(declaresUniform("uniform float amountTwo;", "amount")).toBe(false);
  });
});

describe("declaresEntryPoint", () => {
  it("finds the function", () => {
    expect(declaresEntryPoint("vec4 transition(vec2 uv) {}", "transition"))
      .toBe(true);
    expect(declaresEntryPoint("vec4  effect (vec2 uv) {}", "effect")).toBe(true);
  });

  it("rejects a source that never defines it", () => {
    expect(declaresEntryPoint("vec4 other(vec2 uv) {}", "transition")).toBe(
      false,
    );
  });
});

describe("colorToVec3", () => {
  it("splits a hex colour into 0-1 components", () => {
    expect(colorToVec3("#ff0000")).toEqual([1, 0, 0]);
    expect(colorToVec3("#000000")).toEqual([0, 0, 0]);
    expect(colorToVec3("ffffff")).toEqual([1, 1, 1]);
  });

  it("returns null rather than throwing on nonsense", () => {
    // Runs per frame against whatever the document holds; one bad colour must
    // mute a parameter, not tear down the compositor.
    expect(colorToVec3("red")).toBeNull();
    expect(colorToVec3("#fff")).toBeNull();
    expect(colorToVec3("")).toBeNull();
  });
});

describe("uniformValueOf", () => {
  const number: FxParamSpec = {
    key: "a",
    label: "A",
    uniform: "a",
    type: "number",
    default: 5,
    min: 0,
    max: 10,
  };
  const bool: FxParamSpec = {
    key: "b",
    label: "B",
    uniform: "b",
    type: "bool",
    default: true,
  };
  const select: FxParamSpec = {
    key: "c",
    label: "C",
    uniform: "c",
    type: "select",
    default: 1,
    options: [
      { value: 0, label: "Zero" },
      { value: 1, label: "One" },
    ],
  };
  const color: FxParamSpec = {
    key: "d",
    label: "D",
    uniform: "d",
    type: "color",
    default: "#00ff00",
  };

  it("passes a well-formed stored value straight through", () => {
    expect(uniformValueOf(number, 7)).toBe(7);
    expect(uniformValueOf(bool, false)).toBe(0);
    expect(uniformValueOf(select, 0)).toBe(0);
    expect(uniformValueOf(color, "#ff0000")).toEqual([1, 0, 0]);
  });

  it("falls back to the default when the stored value is the wrong shape", () => {
    // A project written against an older version of the preset, or one whose
    // parameter changed type. It must render, not fail.
    expect(uniformValueOf(number, "seven" as never)).toBe(5);
    expect(uniformValueOf(bool, 1 as never)).toBe(1);
    expect(uniformValueOf(color, 12 as never)).toEqual([0, 1, 0]);
  });

  it("rejects a select value that is not one of the options", () => {
    expect(uniformValueOf(select, 99)).toBe(1);
  });

  it("falls back when nothing is stored at all", () => {
    expect(uniformValueOf(number, undefined)).toBe(5);
    expect(uniformValueOf(select, undefined)).toBe(1);
  });

  it("refuses NaN, which would poison the uniform silently", () => {
    expect(uniformValueOf(number, NaN)).toBe(5);
  });
});
