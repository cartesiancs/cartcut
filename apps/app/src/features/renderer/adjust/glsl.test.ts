import { describe, expect, it } from "vitest";

import { BLUR_TAPS, TENT_3X3 } from "../../adjust/finishMath";
import {
  FADE_BLACK,
  FADE_DESATURATE,
  FADE_WHITE,
  VIGNETTE_INNER,
  VIGNETTE_OUTER,
  VIGNETTE_STRENGTH,
} from "../../adjust/spec";
import { LUMA } from "../../lut/colorMath";
import {
  BLUR_FRAGMENT_SHADER,
  BLUR_UNIFORM,
  FINISH_FRAGMENT_SHADER,
  FINISH_UNIFORM,
  FINISH_VERTEX_SHADER,
  glslFloat,
} from "./glsl";

/**
 * The finish shaders cannot run here, so this checks the two things that can
 * be checked from the text: that it is well-formed, and that every constant it
 * shares with `finishMath.ts` arrived. The formula itself is compared against
 * the CPU oracle on a real GPU by `tests/e2e/specs/adjust.spec.ts`.
 */

const SHADERS = {
  vertex: FINISH_VERTEX_SHADER,
  blur: BLUR_FRAGMENT_SHADER,
  finish: FINISH_FRAGMENT_SHADER,
};

function balanced(source: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of source) {
    if (ch === open) depth++;
    if (ch === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe("glslFloat", () => {
  it("always writes a decimal point", () => {
    expect(glslFloat(1)).toBe("1.0");
    expect(glslFloat(-4)).toBe("-4.0");
    expect(glslFloat(0)).toBe("0.0");
    expect(glslFloat(0.5)).toBe("0.5");
    expect(glslFloat(0.0625)).toBe("0.0625");
  });

  it("never writes an exponent, which GLSL ES 1.0 rejects in some drivers", () => {
    for (const v of [1e-7, 3e-9, 12345678.9, 0.02699548325659403]) {
      expect(glslFloat(v)).not.toMatch(/e/i);
    }
  });

  it("refuses a non-finite value rather than writing NaN into a shader", () => {
    expect(() => glslFloat(Number.NaN)).toThrow();
    expect(() => glslFloat(Infinity)).toThrow();
  });
});

describe("well-formed", () => {
  for (const [name, source] of Object.entries(SHADERS)) {
    it(`${name}: no unexpanded template, balanced braces and parentheses`, () => {
      expect(source).not.toContain("${");
      expect(source).not.toMatch(/undefined|NaN/);
      expect(balanced(source, "{", "}")).toBe(true);
      expect(balanced(source, "(", ")")).toBe(true);
    });
  }

  it("the fragment shaders ask for highp", () => {
    expect(BLUR_FRAGMENT_SHADER).toContain("precision highp float;");
    expect(FINISH_FRAGMENT_SHADER).toContain("precision highp float;");
  });

  it("declares every uniform the applier sets", () => {
    for (const name of Object.values(FINISH_UNIFORM)) {
      expect(FINISH_FRAGMENT_SHADER).toMatch(
        new RegExp(`uniform (float|vec2|vec3|sampler2D) ${name};`),
      );
    }
    for (const name of Object.values(BLUR_UNIFORM)) {
      expect(BLUR_FRAGMENT_SHADER).toMatch(
        new RegExp(`uniform (float|vec2|vec3|sampler2D) ${name};`),
      );
    }
  });

  it("writes alpha through untouched", () => {
    expect(FINISH_FRAGMENT_SHADER).toContain("gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);");
  });
});

describe("constants shared with finishMath", () => {
  it("carries every blur tap", () => {
    for (const tap of BLUR_TAPS) {
      expect(BLUR_FRAGMENT_SHADER).toContain(`uTexel * ${glslFloat(tap.offset)}`);
      expect(BLUR_FRAGMENT_SHADER).toContain(glslFloat(tap.weight));
    }
    expect(BLUR_FRAGMENT_SHADER.match(/texture2D/g)).toHaveLength(BLUR_TAPS.length);
  });

  it("carries every tent tap", () => {
    for (const tap of TENT_3X3) {
      expect(FINISH_FRAGMENT_SHADER).toContain(
        `vec2(${glslFloat(tap.dx)}, ${glslFloat(tap.dy)}) * st`,
      );
    }
  });

  it("carries the fade and vignette scales", () => {
    for (const v of [
      FADE_BLACK,
      FADE_WHITE,
      FADE_DESATURATE,
      VIGNETTE_INNER,
      VIGNETTE_OUTER,
      VIGNETTE_STRENGTH,
    ]) {
      expect(FINISH_FRAGMENT_SHADER).toContain(glslFloat(v));
    }
  });

  it("uses Rec.709 luma in both programs", () => {
    const literal = `vec3(${LUMA.map(glslFloat).join(", ")})`;
    expect(BLUR_FRAGMENT_SHADER).toContain(literal);
    expect(FINISH_FRAGMENT_SHADER).toContain(literal);
  });

  it("uses the same sine-free hash as the CPU", () => {
    expect(FINISH_FRAGMENT_SHADER).toContain("fract(vec3(p.xyx) * 0.1031)");
    expect(FINISH_FRAGMENT_SHADER).toContain("p3 += dot(p3, p3.yzx + 33.33);");
    expect(FINISH_FRAGMENT_SHADER).toContain("fract((p3.x + p3.y) * p3.z)");
    expect(FINISH_FRAGMENT_SHADER).not.toMatch(/\bsin\(/);
  });

  it("runs the stages in finishPixel's order", () => {
    const order = [
      "uClarity > 0.0",
      "uSharpen > 0.0",
      "uFade > 0.0",
      "uVignette != 0.0",
      "uParticles > 0.0",
    ].map((marker) => FINISH_FRAGMENT_SHADER.indexOf(marker));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
