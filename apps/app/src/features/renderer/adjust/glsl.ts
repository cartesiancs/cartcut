/**
 * The finishing adjustments in GLSL.
 *
 * A restatement of `adjust/finishMath.ts#finishPixel`, in the same order, and
 * **generated** from that module's constants rather than retyped: the blur
 * taps, the tent weights and every scale in `adjust/spec.ts` are interpolated
 * into the source here, so a constant changed in one place cannot leave the
 * shader behind. `glsl.test.ts` checks the generated text carries them.
 *
 * What cannot be generated is the formula itself, and that is checked the
 * only honest way — against the CPU oracle on real pixels, on a real GPU, in
 * `tests/e2e/specs/adjust.spec.ts`.
 *
 * Two views of the layer are bound. `uSource` is straight colour, for the
 * pixel being finished, for the reason `lut/glsl.ts` gives. `uPremult` is the
 * same layer uploaded premultiplied, for the blur taps — averaging straight
 * colour across the clip's edge would read the transparent surroundings as
 * black picture and sharpen a rim onto the border (`cpu.ts` says more).
 */

import { BLUR_TAPS, TENT_3X3 } from "../../adjust/finishMath";
import { LUMA } from "../../lut/colorMath";
import {
  FADE_BLACK,
  FADE_DESATURATE,
  FADE_WHITE,
  VIGNETTE_INNER,
  VIGNETTE_OUTER,
  VIGNETTE_STRENGTH,
} from "../../adjust/spec";

/** A float literal GLSL ES 1.0 accepts: always a point, never an exponent. */
export function glslFloat(v: number): string {
  if (!Number.isFinite(v)) {
    throw new Error(`not a finite float: ${v}`);
  }
  const fixed = v.toFixed(10).replace(/0+$/, "");
  return fixed.endsWith(".") ? `${fixed}0` : fixed;
}

const LUMA_GLSL = `vec3(${LUMA.map(glslFloat).join(", ")})`;

/** Every uniform the finish program reads. Tests assert each one is declared. */
export const FINISH_UNIFORM = {
  source: "uSource",
  premult: "uPremult",
  blurred: "uBlurred",
  size: "uSize",
  clarity: "uClarity",
  sharpen: "uSharpen",
  particles: "uParticles",
  fade: "uFade",
  vignette: "uVignette",
  sharpenStep: "uSharpenStep",
  toLocalX: "uToLocalX",
  toLocalY: "uToLocalY",
  box: "uBox",
  grainCell: "uGrainCell",
  grainOffset: "uGrainOffset",
} as const;

export const BLUR_UNIFORM = {
  source: "uSource",
  texel: "uTexel",
  direction: "uDir",
  fromColor: "uFromColor",
} as const;

/** `_p` → `_uv`, the quad every preset draws on. */
export const FINISH_VERTEX_SHADER = `
attribute vec2 _p;
varying vec2 _uv;
void main() {
  _uv = 0.5 * (_p + 1.0);
  gl_Position = vec4(_p, 0.0, 1.0);
}
`;

const blurTaps = BLUR_TAPS.map(
  (tap) => `
  s = texture2D(uSource, _uv + uDir * uTexel * ${glslFloat(tap.offset)});
  la += ${glslFloat(tap.weight)} * mix(s.r, dot(s.rgb, LUMA), uFromColor);
  a += ${glslFloat(tap.weight)} * mix(s.g, s.a, uFromColor);`,
).join("");

/**
 * One separable pass of clarity's blur.
 *
 * The first pass reads the premultiplied layer (`uFromColor = 1`) and writes
 * `(L·a, a)` — luma is linear, so the luma of premultiplied colour already is
 * `L·a`. The second reads that (`uFromColor = 0`) and blurs it the other way.
 * `uDir` is the tap spacing in device pixels along one axis.
 */
export const BLUR_FRAGMENT_SHADER = `
precision highp float;
varying vec2 _uv;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uFromColor;
const vec3 LUMA = ${LUMA_GLSL};
void main() {
  float la = 0.0;
  float a = 0.0;
  vec4 s;${blurTaps}
  gl_FragColor = vec4(la, a, 0.0, 1.0);
}
`;

const tentTaps = TENT_3X3.map(
  (tap) => `
    s = texture2D(uPremult, _uv + vec2(${glslFloat(tap.dx)}, ${glslFloat(tap.dy)}) * st);
    sum += s.rgb * ${glslFloat(tap.weight)};
    total += s.a * ${glslFloat(tap.weight)};`,
).join("");

/**
 * `finishPixel`, stage for stage.
 *
 * Device position is recovered from `_uv` with y flipped: the layer was
 * uploaded with `UNPACK_FLIP_Y_WEBGL`, so texture row 0 is the canvas's
 * *bottom* row. The kernels are symmetric and do not care; the vignette and
 * the grain, which need to know where they are, do.
 */
export const FINISH_FRAGMENT_SHADER = `
precision highp float;
varying vec2 _uv;
uniform sampler2D uSource;
uniform sampler2D uPremult;
uniform sampler2D uBlurred;
uniform vec2 uSize;
uniform float uClarity;
uniform float uSharpen;
uniform float uParticles;
uniform float uFade;
uniform float uVignette;
uniform float uSharpenStep;
uniform vec3 uToLocalX;
uniform vec3 uToLocalY;
uniform vec2 uBox;
uniform float uGrainCell;
uniform vec2 uGrainOffset;
const vec3 LUMA = ${LUMA_GLSL};

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float midtoneWeight(float l) {
  float d = 2.0 * clamp(l, 0.0, 1.0) - 1.0;
  return 1.0 - d * d;
}

float grainWeight(float l) {
  return 1.0 - abs(2.0 * clamp(l, 0.0, 1.0) - 1.0);
}

void main() {
  vec4 texel = texture2D(uSource, _uv);
  vec3 src = texel.rgb;
  vec3 c = src;

  if (uClarity > 0.0) {
    vec4 bl = texture2D(uBlurred, _uv);
    float l = dot(c, LUMA);
    float lb = bl.g > 0.000001 ? bl.r / bl.g : l;
    c += vec3((l - lb) * uClarity * midtoneWeight(l));
  }

  if (uSharpen > 0.0) {
    vec2 st = vec2(uSharpenStep) / uSize;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    vec4 s;${tentTaps}
    vec3 blurred = total > 0.000001 ? sum / total : src;
    c += (src - blurred) * uSharpen;
  }

  if (uFade > 0.0) {
    float black = ${glslFloat(FADE_BLACK)} * uFade;
    float scale = 1.0 - black - ${glslFloat(FADE_WHITE)} * uFade;
    c = vec3(black) + c * scale;
    float l = dot(c, LUMA);
    c = vec3(l) + (c - vec3(l)) * (1.0 - ${glslFloat(FADE_DESATURATE)} * uFade);
  }

  vec2 device = vec2(_uv.x * uSize.x, (1.0 - _uv.y) * uSize.y);
  vec3 h = vec3(device, 1.0);
  vec2 local = vec2(dot(uToLocalX, h), dot(uToLocalY, h));

  if (uVignette != 0.0) {
    vec2 p = (local / uBox - 0.5) * 2.0;
    float r = sqrt(dot(p, p) / 2.0);
    float k = smoothstep(${glslFloat(VIGNETTE_INNER)}, ${glslFloat(VIGNETTE_OUTER)}, r)
      * abs(uVignette) * ${glslFloat(VIGNETTE_STRENGTH)};
    c = uVignette > 0.0 ? c * (1.0 - k) : c + (vec3(1.0) - c) * k;
  }

  if (uParticles > 0.0) {
    float n = hash12(floor(local / uGrainCell) + uGrainOffset);
    c += vec3((n - 0.5) * uParticles * grainWeight(dot(c, LUMA)));
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
}
`;
