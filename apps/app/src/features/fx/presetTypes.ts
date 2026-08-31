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
 *
 * Anything other than `quad` means the preset must also supply `vertex`: the
 * host's vertex shader assumes a screen-filling quad, and it is the preset that
 * knows what its own geometry means. That shader receives one attribute,
 * `attribute vec2 _p`, and owns writing `varying vec2 _uv`.
 *
 * | kind | what `_p` holds |
 * |---|---|
 * | `quad` | the four corners in clip space |
 * | `grid` | a `cols`×`rows` lattice over the same -1..1 square |
 * | `cube` | two faces, the second displaced by 4 along x — see `cubeGeometry` |
 *
 * `grid` and `cube` also get a depth buffer, so geometry that folds over itself
 * occludes correctly instead of resolving by triangle order.
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

/**
 * One step of a multi-pass effect.
 *
 * `source` reads the previous pass's output — or the untouched frame, on the
 * first pass — and `original` is bound on every pass regardless, which is what
 * lets a final step combine the two.
 *
 * `constants` exists so that one shader file can serve several passes. A
 * separable gaussian blur is the same code run horizontally then vertically,
 * and without per-pass constants that would mean two near-identical files —
 * exactly the duplication the catalogue rules forbid.
 */
export type FxPassSpec = {
  source: string;
  constants?: Record<string, number | number[]>;
};

/** Longest pipeline a preset may declare. */
export const MAX_PASSES = 8;

export type FxShaderRender = {
  type: "shader";
  source: string;
  vertex?: string;
  mesh?: MeshSpec;
  textures?: FxTextureSpec[];
  precompute?: PrecomputeSpec;
  /**
   * Steps run before `source`, which is always the final pass.
   *
   * Absent means a single pass, which is what every preset written before
   * multi-pass existed declares — so they keep taking the original code path
   * unchanged.
   */
  passes?: FxPassSpec[];
};

/**
 * A colour lookup table, shipped as a file the preset folder contains.
 *
 * There is no GLSL and no entry point: every LUT preset runs the *same*
 * shader, which lives in `features/lut/glsl.ts`, and differs only in the table
 * it hands that shader. That is the whole reason LUTs are a third `kind`
 * rather than eighty effect presets — eighty copies of one shader would defeat
 * `catalogue.test.ts`'s "no two presets run the same pipeline" rule, and would
 * be eighty things to fix if the sampling ever changed.
 *
 * `source` names a `.cube`, `.3dl` or `.png` inside the folder. It is resolved
 * to an absolute path by the scanner and **read lazily**: 80 built-in tables at
 * ~90 KB of text each is 7 MB, and a project that grades nothing should not pay
 * to load a single one of them.
 */
export type FxLutRender = {
  type: "lut";
  source: string;
};

export type FxRenderSpec = FxOverlayRender | FxShaderRender | FxLutRender;

/**
 * The kinds that carry GLSL.
 *
 * `glslWrap.ts` and the compositor's shader plumbing are typed on this rather
 * than on the full kind union, so a LUT preset cannot be handed to a function
 * that would ask it for an entry point it does not have.
 */
export type FxShaderKind = "effect" | "transition";

/**
 * Everything a preset folder can be.
 *
 * Three kinds and not two, because a LUT differs from an effect in what it
 * *is*, not only in what it does: it ships data rather than code, it has no
 * parameters, its panel is a different panel, and it can be applied to a single
 * clip as well as to a whole stack — which no effect can. Modelling it as an
 * effect with a texture would have made all four of those into special cases.
 */
export type FxKind = FxShaderKind | "lut";

/**
 * What a preset does, at the level a browsing user thinks in.
 *
 * A closed list per kind, and it is doing more work than grouping tiles. It is
 * the skeleton of the anti-duplication rule: the catalogue is a table of
 * (category, mechanism) cells with one preset in each, so "is this a duplicate
 * of something we already ship?" becomes a question with a mechanical answer
 * rather than a matter of taste.
 */
export const TRANSITION_CATEGORIES = [
  "dissolve",
  "wipe",
  "slide",
  "zoom",
  "distort",
  "pattern",
  "3d",
  "light",
] as const;

export const EFFECT_CATEGORIES = [
  "color",
  "tone",
  "optical",
  "blur",
  "texture",
  "stylize",
  "light",
] as const;

/**
 * How the Filter panel groups eighty tables.
 *
 * Chosen so that a user looking for a *look* finds it: the top-level question
 * a colourist asks is "warm or cool, film or clean, colour or mono", not "which
 * mathematical operation". `log-convert` is the one technical section, and it
 * has to exist separately because those tables are not a look at all — they
 * are the transform that makes log footage viewable before a look is applied.
 */
export const LUT_CATEGORIES = [
  "film",
  "cinematic",
  "vintage",
  "mono",
  "warm",
  "cool",
  "vivid",
  "matte",
  "log-convert",
  "utility",
] as const;

export type LutCategory = (typeof LUT_CATEGORIES)[number];
export type TransitionCategory = (typeof TRANSITION_CATEGORIES)[number];
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];
export type FxCategory = TransitionCategory | EffectCategory | LutCategory;

export function categoriesFor(kind: FxKind): readonly string[] {
  if (kind === "transition") {
    return TRANSITION_CATEGORIES;
  }
  return kind === "lut" ? LUT_CATEGORIES : EFFECT_CATEGORIES;
}

/** A validated preset, ready to hand to the compositor. */
export type FxPreset = {
  schema: 1;
  id: string;
  kind: FxKind;
  name: string;
  /**
   * Which section of the panel it appears under.
   *
   * Required. A catalogue of seventy presets in one flat grid is unusable, and
   * an optional field would have been left off exactly by the presets that
   * needed it most.
   */
  category: FxCategory;
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
