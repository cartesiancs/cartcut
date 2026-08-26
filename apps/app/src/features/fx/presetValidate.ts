/**
 * Turning an untrusted folder into an `FxPreset`, or refusing to.
 *
 * The main process hands over bytes without opinion. Everything that decides
 * whether those bytes are a preset happens here, and it is the only place that
 * does — which is what lets built-in and user presets go through one path.
 * That matters more than it sounds: if built-ins took a privileged shortcut,
 * third-party presets would break somewhere nobody was testing.
 *
 * Two rules run through all of it.
 *
 * **Nothing executes.** The schema admits GLSL and data. There is no field that
 * names a script, and `.js` in a preset folder is simply never read.
 *
 * **No path leaves the folder.** Every file reference is checked to be a plain
 * relative name that resolves inside the preset directory and was actually
 * enumerated. A manifest naming `../../../.ssh/id_rsa` gets the preset
 * rejected, not the file read.
 *
 * A rejection is per-preset and never fatal: `loadPresets` collects the errors,
 * drops that one from the list, and carries on. One bad manifest in
 * `userData/presets/` must not cost the user their built-ins.
 *
 * DOM-free — it takes an already-read payload — so it runs under
 * `environment: "node"` and is tested directly.
 */

import {
  declaredUniforms,
  declaresEntryPoint,
  declaresUniform,
  entryPointOf,
  reservedUniformsFor,
} from "./glslWrap";
import { GLSL_TYPE_FOR_PARAM } from "./presetTypes";
import type {
  FxParamSpec,
  FxPreset,
  FxRenderSpec,
  FxSelectOption,
  MeshSpec,
  PrecomputeKind,
  PrecomputeSpec,
  RawPresetPayload,
} from "./presetTypes";

/** The manifest schema this build understands. */
export const PRESET_SCHEMA_VERSION = 1;

/** Analyses the app can actually run. See `presetTypes.ts#PrecomputeKind`. */
const KNOWN_PRECOMPUTE: PrecomputeKind[] = ["luma", "opticalFlow", "edge"];

/** ...and the subset implemented so far. */
const IMPLEMENTED_PRECOMPUTE: PrecomputeKind[] = ["luma"];

const PARAM_TYPES = ["number", "color", "bool", "select", "point"];

/** Extensions the loader reads as shader text. */
export const SHADER_EXTENSIONS = [".frag", ".vert", ".glsl"];

/** Extensions the loader exposes as file paths. */
export const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mov",
];

export type ValidationResult =
  | { ok: true; preset: FxPreset }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GLSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a manifest's file reference is a plain name inside the folder.
 *
 * Rejects absolute paths, drive letters, backslashes, any `..` segment, and
 * anything with a leading slash. Backslashes are refused rather than
 * normalised: this runs on macOS and Linux too, where `a\b` is a legal single
 * filename, and quietly reinterpreting it would mean the string checked is not
 * the string opened.
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  if (value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function validateParam(
  raw: unknown,
  index: number,
  reserved: readonly string[],
  errors: string[],
): FxParamSpec | null {
  const where = "params[" + index + "]";

  if (!isPlainObject(raw)) {
    errors.push(where + ": must be an object");
    return null;
  }

  const { key, label, uniform, type } = raw;

  if (typeof key !== "string" || key.trim() === "") {
    errors.push(where + ": `key` must be a non-empty string");
    return null;
  }
  if (typeof label !== "string" || label.trim() === "") {
    errors.push(where + " (" + key + "): `label` must be a non-empty string");
    return null;
  }
  if (typeof uniform !== "string" || !GLSL_IDENTIFIER.test(uniform)) {
    errors.push(
      where + " (" + key + "): `uniform` must be a GLSL identifier",
    );
    return null;
  }
  if (uniform.startsWith("gl_")) {
    errors.push(where + " (" + key + "): `gl_` is reserved by GLSL");
    return null;
  }
  if (reserved.includes(uniform)) {
    errors.push(
      where +
        " (" +
        key +
        "): `" +
        uniform +
        "` is supplied by the host and cannot be a parameter",
    );
    return null;
  }
  if (typeof type !== "string" || !PARAM_TYPES.includes(type)) {
    errors.push(
      where +
        " (" +
        key +
        "): `type` must be one of " +
        PARAM_TYPES.join(", "),
    );
    return null;
  }

  const base = { key, label, uniform };

  if (type === "number") {
    const { min, max, step } = raw as Record<string, unknown>;
    const value = (raw as Record<string, unknown>).default;
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(min) ||
      !Number.isFinite(max)
    ) {
      errors.push(where + " (" + key + "): `min` and `max` must be numbers");
      return null;
    }
    if (min > max) {
      errors.push(where + " (" + key + "): `min` is greater than `max`");
      return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(where + " (" + key + "): `default` must be a number");
      return null;
    }
    if (value < min || value > max) {
      errors.push(
        where + " (" + key + "): `default` is outside `min`..`max`",
      );
      return null;
    }
    if (step != null && (typeof step !== "number" || !(step > 0))) {
      errors.push(where + " (" + key + "): `step` must be a positive number");
      return null;
    }
    return {
      ...base,
      type: "number",
      default: value,
      min,
      max,
      ...(typeof step === "number" ? { step } : {}),
    };
  }

  if (type === "point") {
    const { min, max, step } = raw as Record<string, unknown>;
    const value = (raw as Record<string, unknown>).default;
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min > max
    ) {
      errors.push(
        where + " (" + key + "): `min` and `max` must be numbers, min <= max",
      );
      return null;
    }
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      errors.push(where + " (" + key + "): `default` must be [x, y]");
      return null;
    }
    if (value.some((n) => n < min || n > max)) {
      errors.push(where + " (" + key + "): `default` is outside `min`..`max`");
      return null;
    }
    if (step != null && (typeof step !== "number" || !(step > 0))) {
      errors.push(where + " (" + key + "): `step` must be a positive number");
      return null;
    }
    return {
      ...base,
      type: "point",
      default: [value[0], value[1]] as [number, number],
      min,
      max,
      ...(typeof step === "number" ? { step } : {}),
    };
  }

  if (type === "color") {
    const value = (raw as Record<string, unknown>).default;
    if (typeof value !== "string" || !/^#?[0-9a-f]{6}$/i.test(value.trim())) {
      errors.push(
        where + " (" + key + "): `default` must be a #rrggbb colour",
      );
      return null;
    }
    return { ...base, type: "color", default: value };
  }

  if (type === "bool") {
    const value = (raw as Record<string, unknown>).default;
    if (typeof value !== "boolean") {
      errors.push(where + " (" + key + "): `default` must be true or false");
      return null;
    }
    return { ...base, type: "bool", default: value };
  }

  // select
  const { options } = raw as Record<string, unknown>;
  const value = (raw as Record<string, unknown>).default;
  if (!Array.isArray(options) || options.length === 0) {
    errors.push(where + " (" + key + "): `options` must be a non-empty array");
    return null;
  }
  const parsed: FxSelectOption[] = [];
  for (const option of options) {
    if (
      !isPlainObject(option) ||
      typeof option.value !== "number" ||
      !Number.isFinite(option.value) ||
      typeof option.label !== "string" ||
      option.label.trim() === ""
    ) {
      errors.push(
        where + " (" + key + "): each option needs a numeric `value` and a `label`",
      );
      return null;
    }
    parsed.push({ value: option.value, label: option.label });
  }
  if (typeof value !== "number" || !parsed.some((o) => o.value === value)) {
    errors.push(
      where + " (" + key + "): `default` must be one of the option values",
    );
    return null;
  }
  return { ...base, type: "select", default: value, options: parsed };
}

function validateMesh(raw: unknown, errors: string[]): MeshSpec | null {
  if (!isPlainObject(raw)) {
    errors.push("render.mesh: must be an object");
    return null;
  }
  if (raw.kind === "quad") {
    return { kind: "quad" };
  }
  if (raw.kind === "cube") {
    return { kind: "cube" };
  }
  if (raw.kind === "grid") {
    const { cols, rows } = raw;
    const valid = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 256;
    if (!valid(cols) || !valid(rows)) {
      errors.push("render.mesh: grid `cols` and `rows` must be 1..256");
      return null;
    }
    return { kind: "grid", cols: cols as number, rows: rows as number };
  }
  errors.push("render.mesh: `kind` must be quad, grid or cube");
  return null;
}

function validatePrecompute(
  raw: unknown,
  hasFile: (name: string) => boolean,
  errors: string[],
): PrecomputeSpec | null {
  if (!isPlainObject(raw)) {
    errors.push("render.precompute: must be an object");
    return null;
  }
  const { kind, source } = raw;
  if (typeof kind !== "string" || !KNOWN_PRECOMPUTE.includes(kind as never)) {
    errors.push(
      "render.precompute.kind: must be one of " + KNOWN_PRECOMPUTE.join(", "),
    );
    return null;
  }
  if (!IMPLEMENTED_PRECOMPUTE.includes(kind as PrecomputeKind)) {
    // Reserved but not built yet. Saying so is much better than "unknown kind",
    // which would send an author looking for a typo.
    errors.push(
      "render.precompute.kind: `" +
        kind +
        "` is reserved but not implemented in this build",
    );
    return null;
  }
  if (source != null) {
    if (typeof source !== "string" || !isSafeRelativePath(source)) {
      errors.push("render.precompute.source: must be a path inside the preset");
      return null;
    }
    if (!hasFile(source)) {
      errors.push("render.precompute.source: `" + source + "` is not present");
      return null;
    }
  }
  return {
    kind: kind as PrecomputeKind,
    ...(typeof source === "string" ? { source } : {}),
  };
}

function validateRender(
  raw: unknown,
  kind: "effect" | "transition",
  payload: RawPresetPayload,
  errors: string[],
): FxRenderSpec | null {
  if (!isPlainObject(raw)) {
    errors.push("render: must be an object");
    return null;
  }

  const hasShader = (name: string) =>
    Object.hasOwnProperty.call(payload.sources, name);
  const hasAsset = (name: string) =>
    Object.hasOwnProperty.call(payload.assets, name);
  const hasFile = (name: string) => hasShader(name) || hasAsset(name);

  const type = raw.type;

  if (type === "overlay") {
    // A transition mixes two inputs; an overlay has one source and no notion of
    // a second. Allowing it would produce a preset the compositor cannot run.
    if (kind === "transition") {
      errors.push("render.type: a transition must be a shader, not an overlay");
      return null;
    }
    const source = raw.source;
    if (typeof source !== "string" || !isSafeRelativePath(source)) {
      errors.push("render.source: must be a path inside the preset");
      return null;
    }
    if (!hasAsset(source)) {
      errors.push("render.source: `" + source + "` is not a media file here");
      return null;
    }
    const { loop, blend, fit } = raw;
    if (blend != null && typeof blend !== "string") {
      errors.push("render.blend: must be a string");
      return null;
    }
    if (fit != null && !["cover", "contain", "stretch"].includes(fit as never)) {
      errors.push("render.fit: must be cover, contain or stretch");
      return null;
    }
    return {
      type: "overlay",
      source,
      ...(typeof loop === "boolean" ? { loop } : {}),
      ...(typeof blend === "string" ? { blend } : {}),
      ...(typeof fit === "string"
        ? { fit: fit as "cover" | "contain" | "stretch" }
        : {}),
    };
  }

  if (type !== "shader") {
    errors.push("render.type: must be `shader` or `overlay`");
    return null;
  }

  const source = raw.source;
  if (typeof source !== "string" || !isSafeRelativePath(source)) {
    errors.push("render.source: must be a path inside the preset");
    return null;
  }
  if (!hasShader(source)) {
    errors.push("render.source: `" + source + "` is not a shader file here");
    return null;
  }

  const vertex = raw.vertex;
  if (vertex != null) {
    if (typeof vertex !== "string" || !isSafeRelativePath(vertex)) {
      errors.push("render.vertex: must be a path inside the preset");
      return null;
    }
    if (!hasShader(vertex)) {
      errors.push("render.vertex: `" + vertex + "` is not a shader file here");
      return null;
    }
  }

  let mesh: MeshSpec | undefined;
  if (raw.mesh != null) {
    const parsed = validateMesh(raw.mesh, errors);
    if (parsed == null) {
      return null;
    }
    mesh = parsed;
  }

  const textures: { uniform: string; source: string }[] = [];
  if (raw.textures != null) {
    if (!Array.isArray(raw.textures)) {
      errors.push("render.textures: must be an array");
      return null;
    }
    for (const [index, entry] of raw.textures.entries()) {
      const at = "render.textures[" + index + "]";
      if (!isPlainObject(entry)) {
        errors.push(at + ": must be an object");
        return null;
      }
      const { uniform, source: file } = entry;
      if (typeof uniform !== "string" || !GLSL_IDENTIFIER.test(uniform)) {
        errors.push(at + ": `uniform` must be a GLSL identifier");
        return null;
      }
      if (reservedUniformsFor(kind).includes(uniform)) {
        errors.push(at + ": `" + uniform + "` is supplied by the host");
        return null;
      }
      if (typeof file !== "string" || !isSafeRelativePath(file)) {
        errors.push(at + ": `source` must be a path inside the preset");
        return null;
      }
      if (!hasAsset(file)) {
        errors.push(at + ": `" + file + "` is not an image file here");
        return null;
      }
      textures.push({ uniform, source: file });
    }
  }

  let precompute: PrecomputeSpec | undefined;
  if (raw.precompute != null) {
    const parsed = validatePrecompute(raw.precompute, hasFile, errors);
    if (parsed == null) {
      return null;
    }
    precompute = parsed;
  }

  return {
    type: "shader",
    source,
    ...(typeof vertex === "string" ? { vertex } : {}),
    ...(mesh != null ? { mesh } : {}),
    ...(textures.length > 0 ? { textures } : {}),
    ...(precompute != null ? { precompute } : {}),
  };
}

/**
 * Validate one enumerated preset folder.
 *
 * Errors accumulate where they can be reported together — every parameter is
 * checked even if the first one fails — and stop where continuing would be
 * meaningless, such as an unparseable manifest.
 */
export function validatePreset(payload: RawPresetPayload): ValidationResult {
  const errors: string[] = [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(payload.manifestJson);
  } catch (error) {
    return {
      ok: false,
      errors: ["manifest.json is not valid JSON: " + String(error)],
    };
  }

  if (!isPlainObject(manifest)) {
    return { ok: false, errors: ["manifest.json must be an object"] };
  }

  if (manifest.schema !== PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        "schema: expected " +
          PRESET_SCHEMA_VERSION +
          ", got " +
          String(manifest.schema),
      ],
    };
  }

  const { id, kind, name, author, version, thumbnail } = manifest;

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    errors.push("id: must be a name like `com.example.rain`");
  }
  if (kind !== "effect" && kind !== "transition") {
    errors.push("kind: must be `effect` or `transition`");
  }
  if (typeof name !== "string" || name.trim() === "") {
    errors.push("name: must be a non-empty string");
  }

  // Everything below needs a known kind to check against.
  if (kind !== "effect" && kind !== "transition") {
    return { ok: false, errors };
  }

  let thumbnailPath: string | null = null;
  if (thumbnail != null) {
    if (typeof thumbnail !== "string" || !isSafeRelativePath(thumbnail)) {
      errors.push("thumbnail: must be a path inside the preset");
    } else if (!Object.hasOwnProperty.call(payload.assets, thumbnail)) {
      errors.push("thumbnail: `" + thumbnail + "` is not an image file here");
    } else {
      thumbnailPath = payload.assets[thumbnail];
    }
  }

  const render = validateRender(manifest.render, kind, payload, errors);

  const reserved = reservedUniformsFor(kind);
  const params: FxParamSpec[] = [];
  const rawParams = manifest.params;
  if (rawParams != null && !Array.isArray(rawParams)) {
    errors.push("params: must be an array");
  } else {
    const seenKeys = new Set<string>();
    const seenUniforms = new Set<string>();
    for (const [index, raw] of (rawParams ?? []).entries()) {
      const param = validateParam(raw, index, reserved, errors);
      if (param == null) {
        continue;
      }
      if (seenKeys.has(param.key)) {
        errors.push("params: duplicate key `" + param.key + "`");
        continue;
      }
      if (seenUniforms.has(param.uniform)) {
        errors.push("params: duplicate uniform `" + param.uniform + "`");
        continue;
      }
      seenKeys.add(param.key);
      seenUniforms.add(param.uniform);
      params.push(param);
    }
  }

  // Cross-check the manifest against the shader it describes. Doing this at
  // load rather than at first paint is the difference between an author seeing
  // "you declared `amount` but the shader never does" and seeing a preset that
  // silently ignores one of its own controls.
  if (render != null && render.type === "shader") {
    const source = payload.sources[render.source] ?? "";
    const entry = entryPointOf(kind);

    if (!declaresEntryPoint(source, entry)) {
      errors.push(
        render.source + ": must define `vec4 " + entry + "(vec2 uv)`",
      );
    }

    const declared = declaredUniforms(source);

    for (const param of params) {
      // The author declares parameter uniforms themselves — that is what keeps
      // an unmodified gl-transitions shader compiling, since the wrapper must
      // not emit a second declaration. See `glslWrap.ts`.
      if (!declaresUniform(source, param.uniform)) {
        errors.push(
          render.source +
            ": parameter `" +
            param.key +
            "` declares uniform `" +
            param.uniform +
            "`, which the shader never declares",
        );
        continue;
      }

      // A `color` parameter feeding a `vec4` uniform would leave the fourth
      // component reading whatever was there. Comparing the declared type
      // against what the parameter kind binds catches that at load.
      const expected = GLSL_TYPE_FOR_PARAM[param.type];
      const actual = declared[param.uniform];
      if (actual != null && actual !== expected) {
        errors.push(
          render.source +
            ": parameter `" +
            param.key +
            "` is `" +
            param.type +
            "` and binds a " +
            expected +
            ", but the shader declares `" +
            param.uniform +
            "` as " +
            actual,
        );
      }
    }

    // The reverse check, and the one that makes porting an upstream shader
    // trustworthy. `gl-transitions` carries defaults in trailing comments —
    // `uniform float smoothness; // = 0.5` — which nothing reads. A uniform the
    // manifest does not cover is never bound, and GL initialises it to zero, so
    // the transition runs at a setting the author never intended and no error
    // is raised anywhere. Refusing to load is much kinder than that.
    const covered = new Set<string>([
      ...reserved,
      ...params.map((param) => param.uniform),
      ...(render.textures ?? []).map((texture) => texture.uniform),
    ]);
    for (const name of Object.keys(declared)) {
      if (covered.has(name) || name.startsWith("gl_")) {
        continue;
      }
      errors.push(
        render.source +
          ": uniform `" +
          name +
          "` is declared but no parameter or texture binds it, so it would" +
          " read zero at run time",
      );
    }
  }

  if (errors.length > 0 || render == null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    preset: {
      schema: PRESET_SCHEMA_VERSION,
      id: id as string,
      kind,
      name: name as string,
      ...(typeof author === "string" ? { author } : {}),
      ...(typeof version === "string" ? { version } : {}),
      thumbnailPath,
      render,
      params,
      origin: payload.origin,
      sources: payload.sources,
      assets: payload.assets,
    },
  };
}
