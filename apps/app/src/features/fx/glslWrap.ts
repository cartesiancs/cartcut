/**
 * Turning a preset's fragment source into a program the pipeline can compile.
 *
 * ## Transitions use the `gl-transitions` contract, unchanged
 *
 * An author writes one function and nothing else:
 *
 * ```glsl
 * vec4 transition(vec2 uv) {
 *   return mix(getFromColor(uv), getToColor(uv), progress);
 * }
 * ```
 *
 * and the host supplies `from`, `to`, `progress`, `ratio`, `_fromR`, `_toR`,
 * the two `get*Color` helpers, and `main`.
 *
 * Inventing our own contract here — `u_from` / `u_to` / `u_progress`, say —
 * would have cost the entire existing ecosystem. `gl-transitions` publishes
 * around eighty transitions against exactly this interface; adopting it means
 * every one of them drops into `userData/presets/` and works with no edit at
 * all, and that a third-party author already knows how to write for this app.
 * The point of the preset system is extensibility, and a private dialect is the
 * one decision that would have undercut it.
 *
 * Authors declare their own parameter uniforms, as they do upstream, so this
 * wrapper must NOT emit declarations for them — two declarations of one name is
 * a compile error. `presetValidate.ts` checks that each declared parameter is
 * actually present in the source, so the mismatch surfaces when the preset
 * loads rather than as a shader log at first paint.
 *
 * ## Effects use the same shape with one input
 *
 * An adjustment layer reads what is already drawn beneath it:
 *
 * ```glsl
 * vec4 effect(vec2 uv) {
 *   return vec4(getSourceColor(uv).rgb * 1.2, 1.0);
 * }
 * ```
 *
 * No aspect correction is needed on this side: the compositor renders into a
 * scratch canvas at project resolution, so the source texture and the output
 * are the same shape by construction. That is also why `ratio` and the two
 * `_*R` uniforms are constants for transitions here — both clips are drawn to
 * project-resolution buffers before they are ever sampled.
 *
 * Pure string work, DOM-free, and tested as such. The GLSL cannot be compiled
 * under `environment: "node"`, which is the same split `filter/parse.test.ts`
 * lives with: the string handling is tested, the shader is verified by running
 * the app.
 */

import type { FxParamSpec } from "./presetTypes";

/**
 * Names the host owns in a transition program.
 *
 * A parameter that shadowed one of these would either redeclare it — a compile
 * error — or silently capture the host's value. Rejected at validation.
 */
export const RESERVED_TRANSITION_UNIFORMS = [
  "from",
  "to",
  "progress",
  "ratio",
  "_fromR",
  "_toR",
  "_uv",
  "_p",
] as const;

/** The same, for an effect program. */
export const RESERVED_EFFECT_UNIFORMS = [
  "source",
  "original",
  "intensity",
  "resolution",
  "time",
  "_uv",
  "_p",
] as const;

export function reservedUniformsFor(
  kind: "effect" | "transition",
): readonly string[] {
  return kind === "transition"
    ? RESERVED_TRANSITION_UNIFORMS
    : RESERVED_EFFECT_UNIFORMS;
}

/**
 * The `gl-transitions` vertex shader, verbatim.
 *
 * `_p` spans the clip cube and `_uv` is it remapped to 0..1, which is the space
 * every upstream transition samples in. A preset that declares a `mesh` may
 * replace this, and then it owns writing `_uv` itself.
 */
export const TRANSITION_VERTEX_SHADER = [
  "attribute vec2 _p;",
  "varying vec2 _uv;",
  "void main() {",
  "  gl_Position = vec4(_p, 0.0, 1.0);",
  "  _uv = vec2(0.5, 0.5) * (_p + vec2(1.0, 1.0));",
  "}",
].join("\n");

/** The same quad, for effects. */
export const EFFECT_VERTEX_SHADER = TRANSITION_VERTEX_SHADER;

const TRANSITION_PREAMBLE = [
  "precision highp float;",
  "",
  "varying vec2 _uv;",
  "uniform sampler2D from, to;",
  "uniform float progress, ratio, _fromR, _toR;",
  "",
  "// Upstream's aspect-preserving samplers. Both textures arrive at project",
  "// resolution here, so the corrections resolve to identity — they are kept",
  "// so that a shader copied from gl-transitions is byte-identical.",
  "vec4 getFromColor(vec2 uv) {",
  "  return texture2D(from, 0.5 + (uv - 0.5) * vec2(",
  "    min(ratio / _fromR, 1.0),",
  "    min(_fromR / ratio, 1.0)",
  "  ));",
  "}",
  "vec4 getToColor(vec2 uv) {",
  "  return texture2D(to, 0.5 + (uv - 0.5) * vec2(",
  "    min(ratio / _toR, 1.0),",
  "    min(_toR / ratio, 1.0)",
  "  ));",
  "}",
].join("\n");

const TRANSITION_EPILOGUE = [
  "void main() {",
  "  gl_FragColor = transition(_uv);",
  "}",
].join("\n");

const EFFECT_PREAMBLE = [
  "precision highp float;",
  "",
  "varying vec2 _uv;",
  "// What this pass reads: the frame beneath the effect on a single-pass",
  "// preset, or the previous pass's output on a multi-pass one.",
  "uniform sampler2D source;",
  "// The untouched frame, on every pass. A final combine pass needs both —",
  "// bloom, halation and tilt-shift are all `mix(original, blurred, ...)`.",
  "uniform sampler2D original;",
  "// 0..1, the element's `intensity` field scaled. Always present, whatever",
  "// the preset declares, so every effect can be faded without saying so.",
  "uniform float intensity;",
  "uniform vec2 resolution;",
  "// Seconds since the effect started, snapped to the frame grid so the",
  "// preview and the render animate identically. See `fx/effectTime.ts`.",
  "uniform float time;",
  "",
  "vec4 getSourceColor(vec2 uv) {",
  "  return texture2D(source, uv);",
  "}",
  "vec4 getOriginalColor(vec2 uv) {",
  "  return texture2D(original, uv);",
  "}",
].join("\n");

const EFFECT_EPILOGUE = [
  "void main() {",
  "  gl_FragColor = effect(_uv);",
  "}",
].join("\n");

/**
 * The entry point a preset of this kind must define.
 *
 * Checked by `presetValidate.ts`, because a source without it compiles to a
 * link error about a missing symbol rather than to anything an author can act
 * on.
 */
export function entryPointOf(kind: "effect" | "transition"): string {
  return kind === "transition" ? "transition" : "effect";
}

/**
 * Whether `source` declares `uniform ... name;`.
 *
 * Deliberately tolerant about whitespace, precision qualifiers and array
 * suffixes, because the point is to catch a parameter the author forgot to
 * declare — not to police formatting. A false negative here rejects a preset
 * that would have worked, so the pattern errs towards matching.
 */
export function declaresUniform(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `uniform`, optional precision qualifier, a type, then the name — possibly
  // in a comma-separated list, possibly with an array suffix.
  const pattern = new RegExp(
    "\\buniform\\b[^;]*\\b" + escaped + "\\b\\s*(\\[[^\\]]*\\])?\\s*[,;]",
  );
  return pattern.test(source);
}

/** Whether `source` defines the entry point, e.g. `vec4 transition(vec2 uv)`. */
export function declaresEntryPoint(source: string, entry: string): boolean {
  const pattern = new RegExp("\\bvec4\\s+" + entry + "\\s*\\(");
  return pattern.test(source);
}

const GLSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Comments stripped, so a commented-out uniform is not mistaken for one. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Every uniform the source declares, as `name -> GLSL type`.
 *
 * Handles the comma-separated form (`uniform float a, b;`) because upstream
 * shaders use it, and strips comments first — `gl-transitions` shaders carry
 * their defaults in trailing comments like `// = vec2(0.0, 1.0)`, and a naive
 * scan reads those as more declarations.
 */
export function declaredUniforms(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern =
    /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([^;]+);/g;

  let match = pattern.exec(withoutComments(source));
  while (match != null) {
    const type = match[1];
    for (const raw of match[2].split(",")) {
      const name = raw.trim().replace(/\[[^\]]*\]$/, "").trim();
      if (name !== "" && GLSL_IDENTIFIER.test(name)) {
        out[name] = type;
      }
    }
    match = pattern.exec(withoutComments(source));
  }
  return out;
}

/** The declared type of one uniform, or `null` when it is not declared. */
export function uniformTypeOf(source: string, name: string): string | null {
  return declaredUniforms(source)[name] ?? null;
}

export type WrapInput = {
  kind: "effect" | "transition";
  /** The author's source, exactly as it sits on disk. */
  source: string;
  /**
   * Samplers the preset ships textures for. Declared by the host rather than
   * the author, because the author cannot know we bind them — unlike
   * parameters, which upstream shaders already declare themselves.
   */
  textureUniforms?: string[];
  /** The sampler a `precompute` result binds to, if the preset asked for one. */
  precomputeUniform?: string | null;
};

/**
 * Assemble the fragment shader that actually gets compiled.
 *
 * Parameter uniforms are **not** emitted — the author's source declares them,
 * which is what keeps an unmodified `gl-transitions` shader compiling.
 */
export function wrapFragmentShader(input: WrapInput): string {
  const { kind, source, textureUniforms = [], precomputeUniform } = input;

  const extra: string[] = [];
  for (const uniform of textureUniforms) {
    extra.push("uniform sampler2D " + uniform + ";");
  }
  if (precomputeUniform != null && precomputeUniform !== "") {
    extra.push("uniform sampler2D " + precomputeUniform + ";");
  }

  const preamble =
    kind === "transition" ? TRANSITION_PREAMBLE : EFFECT_PREAMBLE;
  const epilogue =
    kind === "transition" ? TRANSITION_EPILOGUE : EFFECT_EPILOGUE;

  return [
    preamble,
    ...(extra.length > 0 ? ["", extra.join("\n")] : []),
    "",
    "// ---- preset source ----",
    source.trim(),
    "// ---- end preset source ----",
    "",
    epilogue,
    "",
  ].join("\n");
}

/** The vertex shader to compile: the preset's own, or the standard quad. */
export function vertexShaderFor(
  kind: "effect" | "transition",
  presetVertex?: string,
): string {
  if (presetVertex != null && presetVertex.trim() !== "") {
    return presetVertex;
  }
  return kind === "transition"
    ? TRANSITION_VERTEX_SHADER
    : EFFECT_VERTEX_SHADER;
}

/**
 * A `#rrggbb` string as the three 0-1 floats a `vec3` uniform wants.
 *
 * Returns `null` rather than throwing on malformed input: this runs per frame
 * with whatever the document holds, and one bad colour should mute a parameter,
 * not tear down the compositor.
 */
export function colorToVec3(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match == null) {
    return null;
  }
  const value = parseInt(match[1], 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

/**
 * The uniform value for one parameter, given what the element stores.
 *
 * Falls back to the declared default whenever the stored value is the wrong
 * shape — a project written against an older version of the preset, or a
 * hand-edited `.ngt`. A preset that changed a parameter from `number` to
 * `select` must not make the clip unrenderable.
 */
export function uniformValueOf(
  param: FxParamSpec,
  stored: number | string | boolean | number[] | undefined,
): number | number[] {
  switch (param.type) {
    case "number":
      return typeof stored === "number" && Number.isFinite(stored)
        ? stored
        : param.default;
    case "bool":
      return (typeof stored === "boolean" ? stored : param.default) ? 1 : 0;
    case "select": {
      const allowed = param.options.some((option) => option.value === stored);
      return allowed ? (stored as number) : param.default;
    }
    case "point": {
      const valid =
        Array.isArray(stored) &&
        stored.length === 2 &&
        stored.every((n) => typeof n === "number" && Number.isFinite(n));
      return valid ? (stored as number[]) : [...param.default];
    }
    case "color":
    default: {
      const value = typeof stored === "string" ? stored : param.default;
      return colorToVec3(value) ?? colorToVec3(param.default) ?? [0, 0, 0];
    }
  }
}
