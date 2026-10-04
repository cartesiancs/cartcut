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

import { INLINE_PRESET_PREFIX } from "../../@types/timeline";
import { hashProgram, inlinePresetId } from "./programHash";
import {
  declaredUniforms,
  declaresEntryPoint,
  declaresUniform,
  entryPointOf,
  reservedUniformsFor,
} from "./glslWrap";
import {
  GLSL_TYPE_FOR_PARAM,
  MAX_PASSES,
  TEXT_BINDING_FIELDS,
  categoriesFor,
  isUniformParam,
} from "./presetTypes";
import type {
  FxCategory,
  FxHtmlRender,
  FxKind,
  FxParamSpec,
  FxPassSpec,
  FxPreset,
  FxRenderSpec,
  FxSelectOption,
  FxShaderKind,
  MeshSpec,
  PrecomputeKind,
  PrecomputeSpec,
  PresetParamSpec,
  RawPresetPayload,
} from "./presetTypes";

/** The manifest schema this build understands. */
export const PRESET_SCHEMA_VERSION = 1;

/** Everything a `kind` may say. See `presetTypes.ts#FxKind`. */
const KNOWN_KINDS: FxKind[] = ["effect", "transition", "lut", "graphic"];

/** Analyses the app can actually run. See `presetTypes.ts#PrecomputeKind`. */
const KNOWN_PRECOMPUTE: PrecomputeKind[] = ["luma", "opticalFlow", "edge"];

/** ...and the subset implemented so far. */
const IMPLEMENTED_PRECOMPUTE: PrecomputeKind[] = ["luma"];

const PARAM_TYPES = ["number", "color", "bool", "select", "point"];

/** The extra parameter kinds an HTML graphic takes, which bind no uniform. */
const HTML_PARAM_TYPES = ["text", "font", "image"];

/** Extensions read as text for an HTML graphic. Must match `presetScan.ts`. */
export const TEXT_SOURCE_EXTENSIONS = [".html", ".css", ".svg"];

/**
 * An HTML parameter's key becomes the CSS variable `--<key>`, so it must be a
 * CSS identifier, and it may not shadow a variable the host itself sets.
 */
const CSS_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const HOST_VARIABLES = [
  "t",
  "progress",
  "dur",
  "w",
  "h",
  "rand",
  "from-center",
  "char-index",
  "char-count",
  "char-in-word",
  "word-index",
  "word-count",
  "line-index",
  "line-count",
  "fit",
];

/** A font parameter's value: the default face, a bundled one, or an absolute path. */
const FONT_VALUE = /^(default|bundled:[A-Za-z0-9][A-Za-z0-9._-]*\.(ttf|otf|woff2?))$/;
function isFontValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (FONT_VALUE.test(value) || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))
  );
}

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
  ".cube",
  ".3dl",
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
];

export type ValidationResult =
  | {
      ok: true;
      preset: FxPreset;
      /**
       * Things that do not stop the preset loading but that its author would
       * want to hear: a parameter nothing reads, say. Absent when there are
       * none, so every caller written before warnings existed is unaffected.
       */
      warnings?: string[];
    }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The most one source of an inline program may hold, in UTF-8 bytes.
 *
 * The scanner's `MAX_SHADER_BYTES` for a file on disk, so a program that fits
 * on a clip also fits in a folder when it is saved as a preset.
 */
export const MAX_INLINE_SOURCE_BYTES = 512 * 1024;

/** And all of its sources together. The element is saved in every `.ngt`. */
export const MAX_INLINE_TOTAL_BYTES = 1024 * 1024;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * What an inline program may not use, which an installed preset may.
 *
 * Every one of these names a file beside the manifest, and an inline program
 * has no folder: its media would have to be smuggled in as absolute paths that
 * stop meaning anything on the next machine. A program that needs them is
 * saved as a preset first (`save_program_as_preset`).
 */
function checkInlineRender(render: FxRenderSpec, errors: string[]): void {
  if (render.type === "overlay" || render.type === "lut") {
    errors.push(
      "render.type: an inline program cannot be an " +
        render.type +
        "; save it as a preset to ship media with it",
    );
    return;
  }
  if (render.type !== "shader") {
    return;
  }
  for (const field of ["vertex", "mesh", "textures", "precompute"] as const) {
    if (render[field] != null) {
      errors.push(
        "render." +
          field +
          ": not available to an inline program; save it as a preset first",
      );
    }
  }
}

function checkInlineSizes(
  sources: Record<string, string>,
  errors: string[],
): void {
  let total = 0;
  for (const [name, text] of Object.entries(sources)) {
    const bytes = utf8Length(typeof text === "string" ? text : "");
    total += bytes;
    if (bytes > MAX_INLINE_SOURCE_BYTES) {
      errors.push(
        name + ": " + bytes + " bytes, more than " + MAX_INLINE_SOURCE_BYTES,
      );
    }
  }
  if (total > MAX_INLINE_TOTAL_BYTES) {
    errors.push(
      "sources: " + total + " bytes together, more than " + MAX_INLINE_TOTAL_BYTES,
    );
  }
}
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

function validateHtmlParam(
  raw: Record<string, unknown>,
  where: string,
  key: string,
  label: string,
  errors: string[],
): PresetParamSpec | null {
  const value = raw.default;
  if (raw.type === "text") {
    const { maxLength, multiline } = raw;
    if (
      maxLength != null &&
      (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 5000)
    ) {
      errors.push(where + " (" + key + "): `maxLength` must be a whole number 1..5000");
      return null;
    }
    const limit = typeof maxLength === "number" ? maxLength : 500;
    if (typeof value !== "string" || value.length > limit) {
      errors.push(where + " (" + key + "): `default` must be text of at most " + limit + " characters");
      return null;
    }
    if (multiline != null && typeof multiline !== "boolean") {
      errors.push(where + " (" + key + "): `multiline` must be true or false");
      return null;
    }
    return {
      key,
      label,
      type: "text",
      default: value,
      ...(typeof maxLength === "number" ? { maxLength } : {}),
      ...(multiline === true ? { multiline: true } : {}),
    };
  }
  if (raw.type === "font") {
    if (!isFontValue(value)) {
      errors.push(
        where + " (" + key + '): `default` must be "default", "bundled:<file>" or an absolute path',
      );
      return null;
    }
    return { key, label, type: "font", default: value as string };
  }
  // image
  if (typeof value !== "string") {
    errors.push(where + " (" + key + '): `default` must be a path, or "" for none');
    return null;
  }
  return { key, label, type: "image", default: value };
}

function validateParam(
  raw: unknown,
  index: number,
  reserved: readonly string[],
  errors: string[],
  /** HTML graphics take three more kinds, and bind no uniforms. */
  html: boolean = false,
): PresetParamSpec | null {
  const where = "params[" + index + "]";

  if (!isPlainObject(raw)) {
    errors.push(where + ": must be an object");
    return null;
  }

  const { key, label, type } = raw;

  if (typeof key !== "string" || key.trim() === "") {
    errors.push(where + ": `key` must be a non-empty string");
    return null;
  }
  if (typeof label !== "string" || label.trim() === "") {
    errors.push(where + " (" + key + "): `label` must be a non-empty string");
    return null;
  }
  if (html) {
    if (!CSS_KEY.test(key)) {
      errors.push(where + " (" + key + "): an html parameter's key must be a CSS name, like `title` or `accent-color`");
      return null;
    }
    if (HOST_VARIABLES.includes(key)) {
      errors.push(where + " (" + key + "): `--" + key + "` is set by the host and cannot be a parameter");
      return null;
    }
    if (typeof type === "string" && HTML_PARAM_TYPES.includes(type)) {
      return validateHtmlParam(raw, where, key, label, errors);
    }
  } else if (typeof type === "string" && HTML_PARAM_TYPES.includes(type)) {
    errors.push(where + " (" + key + "): `" + type + "` is for html graphics; a shader has no uniform for it");
    return null;
  }
  // An HTML parameter binds a CSS variable named after its key, not a uniform.
  // Filling `uniform` from the key keeps the shared shape `FxParamSpec` has for
  // the five kinds both renderers take; nothing compiles it, so it is held to
  // the key's CSS rule above and not to GLSL's, or `accent-color` would be
  // refused as a colour and accepted as a text.
  const declared = html ? key : raw.uniform;
  if (typeof declared !== "string" || (!html && !GLSL_IDENTIFIER.test(declared))) {
    errors.push(
      where + " (" + key + "): `uniform` must be a GLSL identifier",
    );
    return null;
  }
  const uniform: string = declared;
  if (!html && uniform.startsWith("gl_")) {
    errors.push(where + " (" + key + "): `gl_` is reserved by GLSL");
    return null;
  }
  if (!html && reserved.includes(uniform)) {
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
        (html ? [...PARAM_TYPES, ...HTML_PARAM_TYPES] : PARAM_TYPES).join(", "),
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

/**
 * The pipeline a multi-pass effect declares.
 *
 * Bounded rather than open-ended: eight steps covers every optical effect we
 * ship (the longest, bloom and halation, declare five), and an unbounded list
 * is a way for a downloaded preset to spend the whole frame budget in the
 * driver.
 */
function validatePasses(
  raw: unknown,
  hasShader: (name: string) => boolean,
  errors: string[],
): FxPassSpec[] | null {
  if (!Array.isArray(raw)) {
    errors.push("render.passes: must be an array");
    return null;
  }
  if (raw.length > MAX_PASSES) {
    errors.push(
      "render.passes: at most " + MAX_PASSES + " passes, got " + raw.length,
    );
    return null;
  }

  const passes: FxPassSpec[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = "render.passes[" + index + "]";
    if (!isPlainObject(entry)) {
      errors.push(at + ": must be an object");
      return null;
    }
    const { source, constants } = entry;
    if (typeof source !== "string" || !isSafeRelativePath(source)) {
      errors.push(at + ": `source` must be a path inside the preset");
      return null;
    }
    if (!hasShader(source)) {
      errors.push(at + ": `" + source + "` is not a shader file here");
      return null;
    }

    const parsed: FxPassSpec = { source };
    if (constants != null) {
      if (!isPlainObject(constants)) {
        errors.push(at + ": `constants` must be an object");
        return null;
      }
      const out: Record<string, number | number[]> = {};
      for (const [key, value] of Object.entries(constants)) {
        if (!GLSL_IDENTIFIER.test(key)) {
          errors.push(at + ": `" + key + "` is not a GLSL identifier");
          return null;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          out[key] = value;
          continue;
        }
        // 2, 3 and 4 components cover vec2/vec3/vec4; anything else has no
        // uniform setter to bind it to.
        const isVector =
          Array.isArray(value) &&
          value.length >= 2 &&
          value.length <= 4 &&
          value.every((n) => typeof n === "number" && Number.isFinite(n));
        if (!isVector) {
          errors.push(
            at + ": `" + key + "` must be a number or 2-4 numbers",
          );
          return null;
        }
        out[key] = value as number[];
      }
      parsed.constants = out;
    }
    passes.push(parsed);
  }
  return passes;
}

function validateHtmlRender(
  raw: Record<string, unknown>,
  hasText: (name: string) => boolean,
  errors: string[],
): FxHtmlRender | null {
  const { source, styles, layout, designSize, bleed, bindings } = raw;
  if (typeof source !== "string" || !isSafeRelativePath(source) || !source.endsWith(".html")) {
    errors.push("render.source: must be an .html file inside the preset");
    return null;
  }
  if (!hasText(source)) {
    errors.push("render.source: `" + source + "` is not a file here");
    return null;
  }
  const sheets: string[] = [];
  if (styles != null) {
    if (!Array.isArray(styles)) {
      errors.push("render.styles: must be an array of .css files");
      return null;
    }
    for (const sheet of styles) {
      if (typeof sheet !== "string" || !isSafeRelativePath(sheet) || !sheet.endsWith(".css") || !hasText(sheet)) {
        errors.push("render.styles: `" + String(sheet) + "` is not a .css file here");
        return null;
      }
      sheets.push(sheet);
    }
  }
  if (layout != null && layout !== "reflow" && layout !== "scale") {
    errors.push("render.layout: must be reflow or scale");
    return null;
  }
  let size: { width: number; height: number } | undefined;
  if (designSize != null) {
    const d = designSize as Record<string, unknown>;
    const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 8192;
    if (!isPlainObject(designSize) || !ok(d.width) || !ok(d.height)) {
      errors.push("render.designSize: width and height must be whole numbers 1..8192");
      return null;
    }
    size = { width: d.width as number, height: d.height as number };
  }
  if (layout === "scale" && size == null) {
    errors.push("render.designSize: a `scale` layout needs one, to lay out at");
    return null;
  }
  if (bleed != null && (typeof bleed !== "number" || !Number.isFinite(bleed) || bleed < 0 || bleed > 4096)) {
    errors.push("render.bleed: must be a number of px, 0..4096");
    return null;
  }
  let bound: Record<string, string> | undefined;
  if (bindings != null) {
    if (!isPlainObject(bindings)) {
      errors.push("render.bindings: must be an object of field to parameter key");
      return null;
    }
    bound = {};
    for (const [field, keyName] of Object.entries(bindings)) {
      if (!TEXT_BINDING_FIELDS.includes(field as never)) {
        errors.push("render.bindings: `" + field + "` is not one of " + TEXT_BINDING_FIELDS.join(", "));
        return null;
      }
      if (typeof keyName !== "string" || keyName === "") {
        errors.push("render.bindings." + field + ": must name a parameter");
        return null;
      }
      bound[field] = keyName;
    }
  }
  return {
    type: "html",
    source,
    ...(sheets.length > 0 ? { styles: sheets } : {}),
    ...(layout != null ? { layout: layout as "reflow" | "scale" } : {}),
    ...(size != null ? { designSize: size } : {}),
    ...(typeof bleed === "number" && bleed > 0 ? { bleed } : {}),
    ...(bound != null && Object.keys(bound).length > 0 ? { bindings: bound } : {}),
  };
}

/** The parameter type each text binding expects. */
const BINDING_TYPES: Record<string, string[]> = {
  text: ["text"],
  font: ["font"],
  color: ["color"],
  fontSize: ["number"],
  align: ["select", "text"],
};

/**
 * What an HTML graphic's manifest says about its markup, checked against the
 * markup: a text parameter with nowhere to go is an error, a parameter no
 * stylesheet reads is a warning, and a binding has to name a parameter of the
 * right kind.
 */
function crossCheckHtml(
  render: FxHtmlRender,
  params: PresetParamSpec[],
  payload: RawPresetPayload,
  errors: string[],
  warnings: string[],
): void {
  // Comments stripped, or a comment that mentions `var(--x)` would count as
  // reading it.
  const markup = (payload.sources[render.source] ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const css = (render.styles ?? [])
    .map((name) => payload.sources[name] ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // `seed` also feeds the split's `--rand`, so a split anywhere reads it.
  const splits = /data-split\s*=/.test(markup);
  const escaped = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const param of params) {
    if (param.type === "text") {
      const slot = new RegExp("data-param\\s*=\\s*[\"']" + escaped(param.key) + "[\"']");
      if (!slot.test(markup)) {
        errors.push(
          "parameter `" + param.key + '` is text, but no element in ' + render.source +
            ' has data-param="' + param.key + '" to put it in',
        );
      }
      continue;
    }
    const used = new RegExp("var\\(\\s*--" + escaped(param.key) + "(-x|-y)?\\s*[,)]");
    if (!used.test(css) && !used.test(markup) && !(param.key === "seed" && splits)) {
      warnings.push(
        "parameter `" + param.key + "` is never read: no stylesheet uses var(--" + param.key + ")",
      );
    }
  }
  for (const [field, keyName] of Object.entries(render.bindings ?? {})) {
    const param = params.find((p) => p.key === keyName);
    if (param == null) {
      errors.push("render.bindings." + field + ": `" + keyName + "` is not a parameter");
    } else if (!(BINDING_TYPES[field] ?? []).includes(param.type)) {
      errors.push(
        "render.bindings." + field + ": `" + keyName + "` is a " + param.type +
          ", and " + field + " needs " + (BINDING_TYPES[field] ?? []).join(" or "),
      );
    }
  }
}

function validateRender(
  raw: unknown,
  kind: FxKind,
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

  if (kind === "lut") {
    // A LUT preset is data. It runs the app's own shader, so it has no source
    // to compile, no entry point, no textures and no parameters — and saying
    // so here is what keeps the cross-checks further down from having to know
    // about a kind that would fail all of them.
    if (type !== "lut") {
      errors.push("render.type: a lut preset must be `lut`");
      return null;
    }
    const source = raw.source;
    if (typeof source !== "string" || !isSafeRelativePath(source)) {
      errors.push("render.source: must be a path inside the preset");
      return null;
    }
    if (!hasAsset(source)) {
      errors.push(
        "render.source: `" +
          source +
          "` is not a .cube, .3dl or image file here",
      );
      return null;
    }
    return { type: "lut", source };
  }

  if (type === "lut") {
    errors.push("render.type: only a `lut` preset may render a lut");
    return null;
  }

  if (type === "html") {
    if (kind !== "graphic") {
      errors.push("render.type: only a graphic may be html");
      return null;
    }
    return validateHtmlRender(raw, hasShader, errors);
  }

  if (type === "overlay") {
    // A transition mixes two inputs; an overlay has one source and no notion of
    // a second. Allowing it would produce a preset the compositor cannot run.
    if (kind === "transition") {
      errors.push("render.type: a transition must be a shader, not an overlay");
      return null;
    }
    // A graphic is a layer with a box, and an overlay is a whole-frame
    // composite: there is nothing for one to mean as the other.
    if (kind === "graphic") {
      errors.push("render.type: a graphic is a shader or html, not an overlay");
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
    errors.push("render.type: must be `shader`, `overlay` or `html`");
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
    // The host's vertex shader maps a screen-filling quad and nothing else. A
    // grid or a cube handed to it draws a lattice of overlapping copies of the
    // frame — which compiles, links and looks like a corrupt preset rather than
    // like a missing field.
    if (mesh.kind !== "quad" && vertex == null) {
      errors.push(
        "render.mesh: a `" +
          mesh.kind +
          "` mesh needs its own `render.vertex`, since only the preset knows" +
          " what its geometry means",
      );
      return null;
    }
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

  let passes: FxPassSpec[] | undefined;
  if (raw.passes != null) {
    // A transition mixes two inputs and hands back one image; there is no
    // "previous pass output" for a second step to read, and no case that wants
    // one. Refused rather than silently ignored.
    if (kind !== "effect") {
      errors.push("render.passes: only an effect may declare passes");
      return null;
    }
    const parsed = validatePasses(raw.passes, hasShader, errors);
    if (parsed == null) {
      return null;
    }
    passes = parsed;
  }

  return {
    type: "shader",
    source,
    ...(typeof vertex === "string" ? { vertex } : {}),
    ...(mesh != null ? { mesh } : {}),
    ...(textures.length > 0 ? { textures } : {}),
    ...(precompute != null ? { precompute } : {}),
    ...(passes != null && passes.length > 0 ? { passes } : {}),
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
  } else if (payload.origin === "inline") {
    // The id is a claim about the content. Recomputed rather than trusted, so a
    // hand-edited program cannot borrow another one's compiled shader.
    const expected = inlinePresetId(
      hashProgram({
        manifest,
        sources: payload.sources,
        assets: payload.assets,
      }),
    );
    if (id !== expected) {
      errors.push(
        "id: an inline program's id is the hash of its content, `" +
          expected +
          "`",
      );
    }
  } else if (id.startsWith(INLINE_PRESET_PREFIX)) {
    errors.push(
      "id: `" + INLINE_PRESET_PREFIX + "` is reserved for programs carried on a clip",
    );
  }
  if (payload.origin === "inline") {
    checkInlineSizes(payload.sources, errors);
  }
  if (!KNOWN_KINDS.includes(kind as FxKind)) {
    errors.push("kind: must be `effect`, `transition`, `graphic` or `lut`");
  }
  if (typeof name !== "string" || name.trim() === "") {
    errors.push("name: must be a non-empty string");
  }

  // Everything below needs a known kind to check against.
  if (!KNOWN_KINDS.includes(kind as FxKind)) {
    return { ok: false, errors };
  }
  const presetKind = kind as FxKind;

  const allowedCategories = categoriesFor(presetKind);
  const category = manifest.category;
  if (
    typeof category !== "string" ||
    !allowedCategories.includes(category)
  ) {
    errors.push(
      "category: must be one of " +
        allowedCategories.join(", ") +
        " for a " +
        presetKind,
    );
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

  const render = validateRender(manifest.render, presetKind, payload, errors);
  if (render != null && payload.origin === "inline") {
    checkInlineRender(render, errors);
  }

  // A LUT declares no parameters, so it reserves nothing; `reservedUniformsFor`
  // is typed on the shader kinds and has no answer for it.
  const isHtml = render != null && render.type === "html";
  const reserved =
    presetKind === "lut" || isHtml ? [] : reservedUniformsFor(presetKind);
  const params: PresetParamSpec[] = [];
  const warnings: string[] = [];
  const rawParams = manifest.params;
  if (rawParams != null && !Array.isArray(rawParams)) {
    errors.push("params: must be an array");
  } else {
    const seenKeys = new Set<string>();
    const seenUniforms = new Set<string>();
    for (const [index, raw] of (rawParams ?? []).entries()) {
      const param = validateParam(raw, index, reserved, errors, isHtml);
      if (param == null) {
        continue;
      }
      if (seenKeys.has(param.key)) {
        errors.push("params: duplicate key `" + param.key + "`");
        continue;
      }
      if (isUniformParam(param)) {
        if (seenUniforms.has(param.uniform)) {
          errors.push("params: duplicate uniform `" + param.uniform + "`");
          continue;
        }
        seenUniforms.add(param.uniform);
      }
      seenKeys.add(param.key);
      params.push(param);
    }
  }

  // Cross-check the manifest against the shader it describes. Doing this at
  // load rather than at first paint is the difference between an author seeing
  // "you declared `amount` but the shader never does" and seeing a preset that
  // silently ignores one of its own controls.
  if (render != null && render.type === "shader") {
    const sourceOf = (name: string) => payload.sources[name] ?? "";
    const entry = entryPointOf(presetKind as FxShaderKind);

    // Every fragment stage the compositor will compile, not only the last one.
    // `programFor` wraps each pass with the same preamble and epilogue, so a
    // pass missing the entry point is a link error at first paint rather than
    // something the author is told about here.
    const fragmentNames = [
      ...(render.passes ?? []).map((pass) => pass.source),
      render.source,
    ];
    // The vertex shader joins them for uniform bookkeeping but not for the
    // entry point: a mesh preset reads its fold angle or rotation there, and
    // GL links the two stages into one program with one set of uniforms.
    const stageNames =
      render.vertex != null ? [...fragmentNames, render.vertex] : fragmentNames;

    for (const name of fragmentNames) {
      if (!declaresEntryPoint(sourceOf(name), entry)) {
        errors.push(name + ": must define `vec4 " + entry + "(vec2 uv)`");
      }
    }

    const declared: Record<string, string> = {};
    for (const name of stageNames) {
      Object.assign(declared, declaredUniforms(sourceOf(name)));
    }

    for (const param of params.filter(isUniformParam)) {
      // The author declares parameter uniforms themselves — that is what keeps
      // an unmodified gl-transitions shader compiling, since the wrapper must
      // not emit a second declaration. See `glslWrap.ts`.
      if (!stageNames.some((n) => declaresUniform(sourceOf(n), param.uniform))) {
        errors.push(
          "parameter `" +
            param.key +
            "` declares uniform `" +
            param.uniform +
            "`, which no stage of this preset declares",
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
          "parameter `" +
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
      ...params.filter(isUniformParam).map((param) => param.uniform),
      ...(render.textures ?? []).map((texture) => texture.uniform),
      // A pass constant is bound by the compositor from the manifest, so a
      // uniform only a `constants` entry feeds is covered — that is the whole
      // point of one blur shader serving a horizontal and a vertical pass.
      ...(render.passes ?? []).flatMap((pass) =>
        Object.keys(pass.constants ?? {}),
      ),
    ]);
    for (const name of Object.keys(declared)) {
      if (covered.has(name) || name.startsWith("gl_")) {
        continue;
      }
      errors.push(
        "uniform `" +
          name +
          "` is declared but no parameter, texture or pass constant binds it," +
          " so it would read zero at run time",
      );
    }
  }

  if (render != null && render.type === "html") {
    crossCheckHtml(render, params, payload, errors, warnings);
  }

  if (errors.length > 0 || render == null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    preset: {
      schema: PRESET_SCHEMA_VERSION,
      id: id as string,
      kind: presetKind,
      name: name as string,
      category: category as FxCategory,
      ...(typeof author === "string" ? { author } : {}),
      ...(typeof version === "string" ? { version } : {}),
      thumbnailPath,
      render,
      params,
      origin: payload.origin,
      // Carried through so the registry can drop exactly one extension's
      // presets when it is disabled, without walking the filesystem again.
      ...(payload.extensionId == null ? {} : { extensionId: payload.extensionId }),
      sources: payload.sources,
      assets: payload.assets,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
