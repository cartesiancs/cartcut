/**
 * What a preset is, as a type.
 *
 * A preset is **declarative data plus GLSL, and never JavaScript**. That is a
 * security boundary, not a style preference: presets are downloaded and
 * installed by users, and they are consumed in an Electron renderer where
 * `window.electronAPI` is in scope. GLSL has no I/O and cannot reach any of it;
 * a `prepare()` hook would hand a stranger's code the filesystem.
 *
 * The schema therefore has to be expressive enough that authors do not *want*
 * an escape hatch. What it covers:
 *
 *  - a fragment shader, in the `gl-transitions` dialect (see `glslWrap.ts`)
 *  - an optional vertex shader and mesh, for transitions that need real
 *    geometry rather than a full-screen quad — a cube rotation or a page curl
 *  - extra textures the preset ships with, for luma wipes and light leaks
 *  - a `precompute` request, naming one of a **closed set** of analyses the app
 *    implements — the answer to "but optical flow needs code"
 *  - parameters, in four kinds, each of which the panel can render and each of
 *    which binds to exactly one GLSL uniform
 *
 * These types live in the renderer and nowhere else. The main process is a dumb
 * file server that reads bytes and knows nothing about any of this — which is
 * what keeps the `electron/` -> `apps/app/src` import ban from forcing a
 * hand-maintained duplicate of the schema, the way `ffmpegArgs.ts` has to
 * duplicate `isAudible`.
 */

/** The parameter kinds a panel can render and a shader can consume. */
export type FxParamType =
  | "number"
  | "color"
  | "bool"
  | "select"
  | "point";

type FxParamBase = {
  /** Stable key in `element.params`. */
  key: string;
  /** Shown next to the control. */
  label: string;
  /** The GLSL uniform this drives. The shader must declare it itself. */
  uniform: string;
};

export type FxNumberParam = FxParamBase & {
  type: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
};

/** Bound to a `vec3` of 0-1 components. Authored as `#rrggbb`. */
export type FxColorParam = FxParamBase & {
  type: "color";
  default: string;
};

/** Bound to a `float`, 0.0 or 1.0 — GLSL ES 1.00 has no `bool` uniform sugar. */
export type FxBoolParam = FxParamBase & {
  type: "bool";
  default: boolean;
};

export type FxSelectOption = { value: number; label: string };

/** A closed list of named numbers, e.g. a wipe direction. Bound to a `float`. */
export type FxSelectParam = FxParamBase & {
  type: "select";
  default: number;
  options: FxSelectOption[];
};

/**
 * Bound to a `vec2`.
 *
 * Added because the upstream catalogue needs it, not for symmetry: a great many
 * `gl-transitions` shaders take `uniform vec2 direction` or `uniform vec2
 * center`, and without this they simply could not be described by a manifest —
 * the uniform would go unbound and read `(0, 0)`, which for a direction means
 * the transition does nothing at all. `min`/`max` apply to both components.
 */
export type FxPointParam = FxParamBase & {
  type: "point";
  default: [number, number];
  min: number;
  max: number;
  step?: number;
};

export type FxParamSpec =
  | FxNumberParam
  | FxColorParam
  | FxBoolParam
  | FxSelectParam
  | FxPointParam;

/**
 * The GLSL type each parameter kind binds to.
 *
 * Used to cross-check the manifest against the shader's own declaration. A
 * mismatch — a `color` parameter whose shader declares `vec4` — would otherwise
 * bind three floats to a four-component uniform and read garbage in the fourth.
 */
export const GLSL_TYPE_FOR_PARAM: Record<FxParamType, string> = {
  number: "float",
  bool: "float",
  select: "float",
  color: "vec3",
  point: "vec2",
};

/**
 * Geometry a transition draws on.
 *
 * Absent means a full-screen quad, which is what every 2D transition wants and
 * costs nothing extra. The other two exist so that 3D transitions are possible
 * at all: a page curl needs a subdivided grid to bend, and a cube rotation
 * needs faces and a depth buffer. Declaring the mesh here rather than shipping
 * vertex data keeps the preset declarative.
 */
export type MeshSpec =
  | { kind: "quad" }
  | { kind: "grid"; cols: number; rows: number }
  | { kind: "cube" };

/**
 * An analysis the app runs before the shader does.
 *
 * The closed-enum answer to `prepare()`. A preset may *ask* for optical flow;
 * it may not *implement* it. Adding a kind is a first-party code change, which
 * is the price of never executing a stranger's JavaScript.
 *
 * v1 implements `luma` only; the other two are reserved so that a manifest
 * written against them is rejected for being unimplemented rather than for
 * being unrecognised.
 */
export type PrecomputeKind = "luma" | "opticalFlow" | "edge";

export type PrecomputeSpec = {
  kind: PrecomputeKind;
  /** Input file for the analysis, relative to the preset folder. */
  source?: string;
};

/** A texture the preset ships with, bound to a sampler the shader declares. */
export type FxTextureSpec = {
  uniform: string;
  source: string;
};

/**
 * Frames composited over what is already drawn.
 *
 * The rain-video case. `blend` names a Canvas2D composite operation, which the
 * compositor may take as a fast path — see `renderer/fx/compositor.ts`, where
 * the equivalence between that path and the GLSL one is pinned by a test.
 */
export type FxOverlayRender = {
  type: "overlay";
  source: string;
  loop?: boolean;
  blend?: string;
  fit?: "cover" | "contain" | "stretch";
};

export type FxShaderRender = {
  type: "shader";
  source: string;
  vertex?: string;
  mesh?: MeshSpec;
  textures?: FxTextureSpec[];
  precompute?: PrecomputeSpec;
};

export type FxRenderSpec = FxOverlayRender | FxShaderRender;

/** A validated preset, ready to hand to the compositor. */
export type FxPreset = {
  schema: 1;
  id: string;
  kind: "effect" | "transition";
  name: string;
  author?: string;
  version?: string;
  /** Absolute path to the tile image, or `null` when the preset ships none. */
  thumbnailPath: string | null;
  render: FxRenderSpec;
  params: FxParamSpec[];
  /** Where it came from. Built-ins and user presets are otherwise identical. */
  origin: "builtin" | "user";
  /** GLSL text, keyed by the manifest's relative filename. */
  sources: Record<string, string>;
  /** Absolute paths to media and image files, keyed by relative filename. */
  assets: Record<string, string>;
};

/**
 * One preset folder as the main process found it.
 *
 * Deliberately unvalidated and untyped beyond this: `manifestJson` is raw text
 * that has not been parsed, let alone checked. Everything that gives it meaning
 * happens in `presetValidate.ts`, in the renderer.
 */
export type RawPresetPayload = {
  id: string;
  dir: string;
  origin: "builtin" | "user";
  manifestJson: string;
  sources: Record<string, string>;
  assets: Record<string, string>;
};

/**
 * The values a preset's parameters actually hold, keyed by `param.key`.
 *
 * `number[]` is in the union for `point`, which stores `[x, y]`. It must match
 * `@types/timeline.ts#FxParams` exactly — that is the type the element carries
 * and the `.ngt` serialises.
 */
export type FxParamValues = Record<
  string,
  number | string | boolean | number[]
>;

/** Every parameter at its declared default. What a fresh element starts with. */
export function defaultParamsOf(preset: FxPreset): FxParamValues {
  const out: FxParamValues = {};
  for (const param of preset.params) {
    out[param.key] = param.default;
  }
  return out;
}
