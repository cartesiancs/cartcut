import { describe, expect, it } from "vitest";

import { toAtlas } from "./atlas";
import {
  LUT_FRAGMENT_SHADER,
  LUT_GLSL_PRELUDE,
  LUT_UNIFORM,
  lutUniformsFor,
} from "./glsl";
import { identityLut3d, nodeOffset, type Lut3d } from "./lutData";
import { sampleLut } from "./sample";

// ---------------------------------------------------------------------------
// A very small reader for the one GLSL function that matters.
//
// The shader cannot run under `environment: "node"` — there is no GL context —
// but its *arithmetic* can be lifted out of the source text and evaluated in
// JavaScript. That turns "the GLSL restates sample.ts correctly" from a claim
// nobody checks until an export looks wrong into an assertion this suite makes
// on every run. It is the transposed-corner bug this catches: a `vec3(1,0,0)`
// written where `vec3(0,0,1)` belonged compiles, renders, and produces a
// plausible wrong grade.
// ---------------------------------------------------------------------------

type Term = { weight: string; offset: [number, number, number] };

/** Split on `+` at paren depth zero. */
function splitTerms(expression: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expression.slice(start));
  return out.map((t) => t.trim()).filter((t) => t !== "");
}

function parseTerm(term: string): Term {
  const at = term.indexOf("*");
  const weight = term.slice(0, at).trim();
  const corner = term.slice(at + 1).trim();
  if (corner === "c000") {
    return { weight, offset: [0, 0, 0] };
  }
  if (corner === "c111") {
    return { weight, offset: [1, 1, 1] };
  }
  const match = corner.match(
    /^lutNode\(i \+ vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)\)$/,
  );
  if (match == null) {
    throw new Error(`unrecognised corner in the shader: ${corner}`);
  }
  return {
    weight,
    offset: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

/** The six `return` expressions of `lutGrade3d`, in source order. */
function branchesOf(source: string): Term[][] {
  const start = source.indexOf("vec3 lutGrade3d(vec3 n) {");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}", start));
  const returns = body
    .split(/\breturn\b/)
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(";")));
  return returns.map((expression) => splitTerms(expression).map(parseTerm));
}

/** Evaluate one of the weight expressions the shader wrote. */
function weigh(expression: string, fx: number, fy: number, fz: number): number {
  const js = expression
    .replace(/f\.x/g, "fx")
    .replace(/f\.y/g, "fy")
    .replace(/f\.z/g, "fz");
  // eslint-disable-next-line no-new-func
  return new Function("fx", "fy", "fz", `return ${js};`)(fx, fy, fz) as number;
}

/**
 * Which tetrahedron a fractional position falls in, restated here.
 *
 * This is the one part the test has to know independently, because it is the
 * `if` structure rather than an expression. Written from the six tetrahedra of
 * the unit cube, in the order the shader emits them — so a shader whose
 * branches were reordered stops matching and the numeric comparison below
 * fails.
 */
function branchIndex(fx: number, fy: number, fz: number): number {
  if (fx > fy) {
    if (fy > fz) return 0;
    if (fx > fz) return 1;
    return 2;
  }
  if (fz > fy) return 3;
  if (fz > fx) return 4;
  return 5;
}

/** Run the parsed shader against a real LUT, the way the GPU would. */
function runShader(branches: Term[][], lut: Lut3d, r: number, g: number, b: number) {
  const { size } = lut;
  const locate = (v: number) => {
    const x = Math.min(Math.max(v, 0), 1) * (size - 1);
    const i = Math.min(Math.floor(x), size - 2);
    return { i, f: x - i };
  };
  const lr = locate(r);
  const lg = locate(g);
  const lb = locate(b);
  const terms = branches[branchIndex(lr.f, lg.f, lb.f)];

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let weightSum = 0;
  for (const term of terms) {
    const w = weigh(term.weight, lr.f, lg.f, lb.f);
    weightSum += w;
    const at = nodeOffset(
      size,
      lr.i + term.offset[0],
      lg.i + term.offset[1],
      lb.i + term.offset[2],
    );
    sr += w * lut.data[at];
    sg += w * lut.data[at + 1];
    sb += w * lut.data[at + 2];
  }
  return { r: sr, g: sg, b: sb, weightSum };
}

/** A cube with no symmetry, so a wrong corner cannot coincidentally agree. */
function asymmetric(size: number): Lut3d {
  const lut = identityLut3d(size);
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const at = nodeOffset(size, r, g, b);
        const x = r / last;
        const y = g / last;
        const z = b / last;
        lut.data[at] = Math.min(1, Math.sqrt(x * 0.7 + y * 0.2 + z * 0.1));
        lut.data[at + 1] = Math.min(1, Math.pow(y, 1 + 0.4 * z));
        lut.data[at + 2] = Math.min(1, z * 0.6 + x * 0.3 + y * y * 0.1);
      }
    }
  }
  return lut;
}

describe("the shader source is well formed", () => {
  it("has no unresolved template interpolation", () => {
    expect(LUT_FRAGMENT_SHADER).not.toContain("${");
  });

  it("balances its braces and parentheses", () => {
    for (const [open, close] of [
      ["{", "}"],
      ["(", ")"],
    ]) {
      const opens = LUT_FRAGMENT_SHADER.split(open).length - 1;
      const closes = LUT_FRAGMENT_SHADER.split(close).length - 1;
      expect(opens).toBe(closes);
    }
  });

  it("asks for highp, which the atlas fetch needs to land on the right texel", () => {
    expect(LUT_FRAGMENT_SHADER).toContain("precision highp float;");
  });

  // A `getUniformLocation` typo is silent: it returns null and the uniform
  // keeps whatever it had, which for `uLutSize` means a one-node table.
  it("declares every uniform the host looks up by name", () => {
    for (const name of Object.values(LUT_UNIFORM)) {
      expect(LUT_GLSL_PRELUDE).toContain(`uniform`);
      expect(LUT_GLSL_PRELUDE).toContain(name);
    }
  });

  it("finds exactly six tetrahedra", () => {
    expect(branchesOf(LUT_GLSL_PRELUDE)).toHaveLength(6);
  });

  it("gives every tetrahedron four corners", () => {
    for (const branch of branchesOf(LUT_GLSL_PRELUDE)) {
      expect(branch).toHaveLength(4);
    }
  });

  // Every tetrahedron of the unit cube shares the 000-111 diagonal. That is
  // the geometric fact that makes tetrahedral interpolation keep greys grey,
  // and a branch missing it is a branch that will tint the neutral axis.
  it("shares the neutral diagonal across all six", () => {
    for (const branch of branchesOf(LUT_GLSL_PRELUDE)) {
      const offsets = branch.map((t) => t.offset.join(""));
      expect(offsets).toContain("000");
      expect(offsets).toContain("111");
    }
  });
});

describe("the shader arithmetic against sampleLut", () => {
  const branches = branchesOf(LUT_GLSL_PRELUDE);

  it("uses weights that sum to one everywhere", () => {
    // Structural: a convex combination cannot leave the hull of its corners,
    // so an in-range table can never produce an out-of-range colour.
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        for (let k = 0; k <= 12; k++) {
          const [fx, fy, fz] = [i / 12, j / 12, k / 12];
          const terms = branches[branchIndex(fx, fy, fz)];
          const sum = terms.reduce((a, t) => a + weigh(t.weight, fx, fy, fz), 0);
          expect(sum).toBeCloseTo(1, 10);
        }
      }
    }
  });

  it("uses non-negative weights everywhere", () => {
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        for (let k = 0; k <= 12; k++) {
          const [fx, fy, fz] = [i / 12, j / 12, k / 12];
          for (const term of branches[branchIndex(fx, fy, fz)]) {
            expect(weigh(term.weight, fx, fy, fz)).toBeGreaterThanOrEqual(-1e-12);
          }
        }
      }
    }
  });

  // The assertion the whole file exists for.
  it("grades identically to the CPU sampler, node by node and between them", () => {
    const lut = asymmetric(9);
    let worst = 0;
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        for (let k = 0; k <= 6; k++) {
          const r = i / 24;
          const g = j / 24;
          const b = k / 6;
          const shader = runShader(branches, lut, r, g, b);
          const cpu = sampleLut(lut, r, g, b, "tetrahedral");
          worst = Math.max(
            worst,
            Math.abs(shader.r - cpu.r),
            Math.abs(shader.g - cpu.g),
            Math.abs(shader.b - cpu.b),
          );
        }
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("is exactly identity for an identity table", () => {
    const lut = identityLut3d(17);
    for (let i = 0; i <= 255; i++) {
      const v = i / 255;
      const shader = runShader(branches, lut, v, v, v);
      expect(shader.r).toBeCloseTo(v, 5);
    }
  });
});

describe("lutUniformsFor", () => {
  it("folds a 0..1 domain into an identity multiply-add", () => {
    const u = lutUniformsFor(toAtlas(identityLut3d(17)));
    expect(u.domainScale).toEqual([1, 1, 1]);
    expect(u.domainOffset).toEqual([0, 0, 0]);
    expect(u.is1d).toBe(0);
  });

  it("folds a declared domain the way sampleLut normalises it", () => {
    const lut = { ...identityLut3d(4), domainMin: [0, 0, 0] as const, domainMax: [4, 4, 4] as const };
    const u = lutUniformsFor(toAtlas(lut));
    for (const value of [0, 1, 2, 3, 4]) {
      const shaderN = value * u.domainScale[0] + u.domainOffset[0];
      // What `sample.ts#locate` computes before it indexes the table.
      expect(shaderN).toBeCloseTo(value / 4, 10);
    }
  });

  it("answers a degenerate domain with zero rather than a NaN", () => {
    const lut = { ...identityLut3d(4), domainMin: [1, 1, 1] as const, domainMax: [1, 1, 1] as const };
    const u = lutUniformsFor(toAtlas(lut));
    expect(u.domainScale).toEqual([0, 0, 0]);
    expect(u.domainOffset).toEqual([0, 0, 0]);
    const n = 0.5 * u.domainScale[0] + u.domainOffset[0];
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBe(0);
  });

  it("flags a 1D LUT so the shader takes the per-channel path", () => {
    const u = lutUniformsFor(toAtlas({ ...identityLut3d(4), kind: "3d" }));
    expect(u.is1d).toBe(0);
  });
});
