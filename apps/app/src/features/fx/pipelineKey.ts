/**
 * What makes two presets the same preset.
 *
 * Shared by the built-in catalogue's suite (`catalogue.test.ts`) and the cloud
 * content checker (`scripts/cloud/checkContent.ts`), so "distinct from every
 * built-in" is judged by the catalogue's own definition rather than by a copy
 * of it that drifts.
 *
 * The keys are normalised text, not hashes: equality is all either caller
 * needs, and it keeps `crypto` out of the renderer's sources.
 */

import type { FxPreset } from "./presetTypes";

/**
 * A shader with its comments and whitespace removed.
 *
 * Comments are stripped deliberately: two presets that differ only in what
 * their headers claim are still the same preset, and leaving the prose in would
 * make the duplication check trivial to defeat by accident.
 */
export function normalizeGlsl(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
}

/**
 * Markup or a stylesheet with its comments and whitespace removed. Not
 * `normalizeGlsl`: CSS has no `//` comment, and stripping one would eat a
 * `content: "//"` along with the rest of its line.
 */
export function normalizeMarkup(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, "");
}

/** The markup and every style sheet of an HTML graphic, as one text. */
export function htmlSourcesOf(preset: FxPreset): string {
  if (preset.render.type !== "html") {
    return "";
  }
  return [preset.render.source, ...(preset.render.styles ?? [])]
    .map((name) => preset.sources[name] ?? "")
    .join("\n");
}

/**
 * A number standing alone, not part of an identifier: the `2` in `vec2`,
 * `texture2D` or `h1` is preceded by a letter and is left alone.
 */
const NUMERIC_LITERAL = /(?<![A-Za-z_\d.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/g;

function withoutLiterals(text: string): string {
  return text.replace(HEX_COLOUR, "#").replace(NUMERIC_LITERAL, "0");
}

function keyOf(preset: FxPreset, blank: (text: string) => string): string {
  if (preset.render.type === "lut") {
    // Every LUT preset runs the same shader and differs only in its table, so
    // there is no pipeline here to compare. The equivalent rule (no two
    // shipped tables grade alike) needs the parsed data and lives in
    // `lut/lutCatalogue.test.ts`.
    return "lut:" + preset.id;
  }
  if (preset.render.type === "html") {
    // An HTML graphic's pipeline is its markup and its sheets: two graphics
    // that differ only in a default are one graphic with a parameter.
    const files = [preset.render.source, ...(preset.render.styles ?? [])];
    return files
      .map((name) => name + ":" + blank(normalizeMarkup(preset.sources[name] ?? "")))
      .join("|");
  }
  if (preset.render.type !== "shader") {
    return "overlay:" + preset.render.source;
  }
  const stages = [
    ...(preset.render.passes ?? []).map(
      (pass) => pass.source + "@" + blank(JSON.stringify(pass.constants ?? {})),
    ),
    preset.render.source,
  ];
  const body = stages
    .map((stage) => {
      const name = stage.split("@")[0];
      return stage + ":" + blank(normalizeGlsl(preset.sources[name] ?? ""));
    })
    .join("|");
  const vertex =
    preset.render.vertex != null
      ? blank(normalizeGlsl(preset.sources[preset.render.vertex] ?? ""))
      : "";
  return body + "|" + vertex;
}

/**
 * Everything the compositor will actually run, in order.
 *
 * The *pipeline* rather than each file, because a shared helper is not
 * duplication. Gaussian Blur, Bloom, Halation and Tilt Shift all run the same
 * separable blur, and forbidding that would push each of them into keeping a
 * private, slightly drifted copy, which is the opposite of the thing being
 * prevented. What must not repeat is the whole chain.
 */
export function pipelineOf(preset: FxPreset): string {
  return keyOf(preset, (text) => text);
}

/**
 * `pipelineOf` with every number and hex colour blanked out.
 *
 * Two presets equal under this key differ only in constants: a radius of 4
 * where the other has 6, a tint of `#ff8800` where the other has `#ffaa00`.
 * That is one preset with a parameter, which is exactly what the catalogue
 * refuses to ship as two.
 */
export function literalFreePipelineOf(preset: FxPreset): string {
  return keyOf(preset, withoutLiterals);
}

/** Every value that occurs more than once, compared by its JSON. */
export function duplicates<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice].map((key) => JSON.parse(key) as T);
}
