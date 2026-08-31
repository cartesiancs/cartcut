/**
 * `sample.ts`, restated in GLSL.
 *
 * There are two GPU consumers — the per-clip applier (`renderer/lut/gpu.ts`)
 * and the adjustment-layer branch of the FX compositor — and they must grade
 * identically, so the sampling lives here once and both include it.
 *
 * ## What makes this trustworthy
 *
 * It is a *restatement*, so it can disagree with the CPU version, and the two
 * disagreeing silently is the failure mode that matters: a preview that does
 * not match the export. Three things guard it, in increasing strength:
 *
 *  1. `atlas.test.ts` proves the texture layout is lossless and that
 *     `atlasNodeOffset` — which `lutNode` below mirrors line for line — puts
 *     each node where the shader looks for it.
 *  2. `tests/e2e/specs/lut.spec.ts` compares a preview frame against an export
 *     frame with no encoder in between, so any divergence between the two GPU
 *     call sites is a hard failure.
 *  3. The same spec then decodes the delivered file and checks it against a
 *     third implementation of the LUT maths written inside the spec itself.
 *
 * ## Three things that are not stylistic
 *
 * **`highp` is required, not preferred.** The atlas of a 64³ LUT is 512 texels
 * across and the fetch computes a texel centre by division; `mediump`
 * guarantees only ten bits of mantissa, which is not enough to land on the
 * right texel, and the failure looks like faint blocky noise rather than like a
 * precision problem.
 *
 * **The domain is folded into a scale and an offset host-side.** Doing
 * `(c - min) / (max - min)` in the shader means dividing by zero for a
 * degenerate domain, and a `NaN` there survives every subsequent `clamp` and
 * `mix` to blacken the pixel. `lutUniformsFor` resolves that once on the CPU,
 * where the case can simply be answered.
 *
 * **The grade is applied to straight, not premultiplied, colour.** A LUT
 * applied to `rgb` that has already been scaled by `a` grades a
 * half-transparent white as though it were grey, and soft clip edges pick up a
 * dark fringe. Both GPU call sites are configured so that no un-premultiplying
 * is needed here, and it is worth stating the two flags that make that true,
 * because either one flipped would break it silently:
 *
 *  - the context is created with `premultipliedAlpha: false`, so what the
 *    shader writes is interpreted as straight when the drawing buffer is later
 *    `drawImage`d back onto the 2D canvas;
 *  - `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is left at its default of `false`, so a
 *    canvas uploaded with `texImage2D` arrives straight rather than premultiplied.
 *
 * The CPU applier needs no equivalent: `getImageData` is defined to return
 * straight values, so both paths grade the same numbers.
 */

import type { LutAtlas } from "./atlas";

/**
 * Uniform names, prefixed so a preset's own parameters cannot collide.
 *
 * Exported rather than only living in the GLSL because `gpu.ts` and the
 * compositor both look these up, and a typo in a `getUniformLocation` string is
 * silent — it returns `null` and the uniform keeps whatever value it had, which
 * for `uLutSize` means grading through a one-node table. `glsl.test.ts` pins
 * that every name here is declared in the source below.
 */
export const LUT_UNIFORM = {
  texture: "uLutTexture",
  atlasSize: "uLutAtlasSize",
  size: "uLutSize",
  cols: "uLutCols",
  domainScale: "uLutDomainScale",
  domainOffset: "uLutDomainOffset",
  is1d: "uLutIs1d",
  amount: "uLutAmount",
} as const;

/** Every sampler the prelude declares, in binding order. */
export const LUT_SAMPLERS = [LUT_UNIFORM.texture] as const;

/**
 * Declarations and the sampling functions.
 *
 * Ends with `lutGrade(vec3) -> vec3`, which takes an **unpremultiplied**
 * colour and returns the graded one at full strength. The intensity mix and the
 * alpha handling belong to the caller.
 */
export const LUT_GLSL_PRELUDE = `
uniform sampler2D uLutTexture;
uniform vec2 uLutAtlasSize;
uniform float uLutSize;
uniform float uLutCols;
uniform vec3 uLutDomainScale;
uniform vec3 uLutDomainOffset;
uniform float uLutIs1d;
uniform float uLutAmount;

// One node of the cube. Mirrors atlas.ts#atlasNodeOffset: blue picks the tile,
// red runs across it, green runs down it. NEAREST sampling and an exact texel
// centre, so this is a fetch and not a filter — hardware bilinear here would
// blend across the boundary between two blue slices and produce a seam.
vec3 lutNode(vec3 idx) {
  float col = floor(mod(idx.z, uLutCols));
  float row = floor(idx.z / uLutCols);
  vec2 texel = vec2(col * uLutSize + idx.x, row * uLutSize + idx.y) + vec2(0.5);
  return texture2D(uLutTexture, texel / uLutAtlasSize).rgb;
}

// One node of a 1D LUT, which is a single row of three independent curves.
vec3 lutNode1d(float i) {
  return texture2D(uLutTexture, vec2(i + 0.5, 0.5) / uLutAtlasSize).rgb;
}

vec3 lutGrade1d(vec3 n) {
  vec3 x = n * (uLutSize - 1.0);
  vec3 i = min(floor(x), vec3(uLutSize - 2.0));
  vec3 f = x - i;
  // Three separate lookups: each channel runs through its own curve, so the
  // red output is read at the red input's position and nowhere else. This is
  // why a 1D LUT is not widened into a cube — see lutData.ts.
  vec3 lo = vec3(lutNode1d(i.r).r, lutNode1d(i.g).g, lutNode1d(i.b).b);
  vec3 hi = vec3(
    lutNode1d(i.r + 1.0).r,
    lutNode1d(i.g + 1.0).g,
    lutNode1d(i.b + 1.0).b
  );
  return mix(lo, hi, f);
}

// Tetrahedral interpolation, in the barycentric form: four corners and four
// weights that sum to one. Restates sample.ts#tetrahedral branch for branch —
// the six cases are the six tetrahedra the unit cube splits into, and they all
// share the neutral diagonal, which is what keeps greys grey.
vec3 lutGrade3d(vec3 n) {
  vec3 x = n * (uLutSize - 1.0);
  vec3 i = min(floor(x), vec3(uLutSize - 2.0));
  vec3 f = x - i;

  vec3 c000 = lutNode(i);
  vec3 c111 = lutNode(i + vec3(1.0, 1.0, 1.0));

  if (f.x > f.y) {
    if (f.y > f.z) {
      return (1.0 - f.x) * c000
           + (f.x - f.y) * lutNode(i + vec3(1.0, 0.0, 0.0))
           + (f.y - f.z) * lutNode(i + vec3(1.0, 1.0, 0.0))
           + f.z * c111;
    } else if (f.x > f.z) {
      return (1.0 - f.x) * c000
           + (f.x - f.z) * lutNode(i + vec3(1.0, 0.0, 0.0))
           + (f.z - f.y) * lutNode(i + vec3(1.0, 0.0, 1.0))
           + f.y * c111;
    } else {
      return (1.0 - f.z) * c000
           + (f.z - f.x) * lutNode(i + vec3(0.0, 0.0, 1.0))
           + (f.x - f.y) * lutNode(i + vec3(1.0, 0.0, 1.0))
           + f.y * c111;
    }
  } else {
    if (f.z > f.y) {
      return (1.0 - f.z) * c000
           + (f.z - f.y) * lutNode(i + vec3(0.0, 0.0, 1.0))
           + (f.y - f.x) * lutNode(i + vec3(0.0, 1.0, 1.0))
           + f.x * c111;
    } else if (f.z > f.x) {
      return (1.0 - f.y) * c000
           + (f.y - f.z) * lutNode(i + vec3(0.0, 1.0, 0.0))
           + (f.z - f.x) * lutNode(i + vec3(0.0, 1.0, 1.0))
           + f.x * c111;
    } else {
      return (1.0 - f.y) * c000
           + (f.y - f.x) * lutNode(i + vec3(0.0, 1.0, 0.0))
           + (f.x - f.z) * lutNode(i + vec3(1.0, 1.0, 0.0))
           + f.z * c111;
    }
  }
}

// The grade, at full strength, on an unpremultiplied colour.
vec3 lutGrade(vec3 color) {
  vec3 n = clamp(color * uLutDomainScale + uLutDomainOffset, 0.0, 1.0);
  return uLutIs1d > 0.5 ? lutGrade1d(n) : lutGrade3d(n);
}

// The grade applied to a straight RGBA texel, at uLutAmount strength.
//
// Alpha is carried through untouched: a LUT is a colour transform and has
// nothing to say about coverage. A fully transparent pixel still gets graded,
// which costs nothing and avoids a branch — its colour is invisible either way.
vec4 lutApplyStraight(vec4 texel) {
  vec3 graded = mix(texel.rgb, lutGrade(texel.rgb), uLutAmount);
  return vec4(clamp(graded, 0.0, 1.0), texel.a);
}
`;

/**
 * The whole fragment shader for the per-clip applier.
 *
 * A full-screen pass over one isolated clip layer: read, grade, write. The
 * adjustment-layer path does not use this — it goes through the FX compositor's
 * own program plumbing — but both include `LUT_GLSL_PRELUDE`, which is where
 * all the arithmetic lives.
 */
export const LUT_FRAGMENT_SHADER = [
  "precision highp float;",
  "varying vec2 _uv;",
  "uniform sampler2D uSource;",
  LUT_GLSL_PRELUDE,
  "void main() {",
  "  gl_FragColor = lutApplyStraight(texture2D(uSource, _uv));",
  "}",
].join("\n");

/** The vertex shader the applier draws its quad with. */
export const LUT_VERTEX_SHADER = [
  "attribute vec2 _p;",
  "varying vec2 _uv;",
  "void main() {",
  "  gl_Position = vec4(_p, 0.0, 1.0);",
  "  _uv = vec2(0.5, 0.5) * (_p + vec2(1.0, 1.0));",
  "}",
].join("\n");

/** What the host has to upload for a given atlas. */
export type LutUniformValues = {
  atlasWidth: number;
  atlasHeight: number;
  size: number;
  cols: number;
  domainScale: [number, number, number];
  domainOffset: [number, number, number];
  is1d: number;
};

/**
 * Fold the LUT's domain into a multiply-add.
 *
 * `n = clamp(c * scale + offset, 0, 1)` is the shader's whole normalisation
 * step, and it has no division to go wrong. A degenerate domain — `min` equal
 * to `max`, which `sample.ts` answers as "everything maps to the bottom of the
 * table" — becomes a scale and offset of zero, which says the same thing
 * without producing a `NaN` on the way.
 */
export function lutUniformsFor(atlas: LutAtlas): LutUniformValues {
  const domainScale: [number, number, number] = [0, 0, 0];
  const domainOffset: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const span = atlas.domainMax[c] - atlas.domainMin[c];
    if (span !== 0) {
      domainScale[c] = 1 / span;
      // `-0 / span` is `-0`, which behaves identically as a uniform but reads
      // as a different value in a snapshot or a debug dump. Normalise it.
      const offset = -atlas.domainMin[c] / span;
      domainOffset[c] = offset === 0 ? 0 : offset;
    }
  }
  return {
    atlasWidth: atlas.width,
    atlasHeight: atlas.height,
    size: atlas.size,
    cols: atlas.cols,
    domainScale,
    domainOffset,
    is1d: atlas.kind === "1d" ? 1 : 0,
  };
}
