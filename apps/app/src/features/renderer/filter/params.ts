/**
 * Building and reading a filter's parameter string.
 *
 * `VideoFilterType.value` is a positional `k=v:k=v` blob — chromakey carries
 * `r=0:g=255:b=0:f=0.4`, the blurs carry `f=8`. The *parsers* already exist
 * next door (`chromaKey.ts#parseRGBString`, `blur.ts#parseBlurString`, pinned
 * by `parse.test.ts`); this adds the inverse, so nothing outside the WebGL
 * shaders has to know the encoding.
 *
 * `describeFilter` is the third direction: a structured view for `get_clip`,
 * so an agent reading a project sees `{name: "chromakey", color: "#00ff00",
 * threshold: 0.4}` instead of a string it would have to parse itself — and
 * then very likely re-emit wrong.
 */

import type { VideoFilterType } from "../../../@types/timeline";
import { parseRGBString } from "./chromaKey";
import { parseBlurString } from "./blur";

export type FilterInput = {
  name: VideoFilterType["name"];
  /** chromakey only. Hex, with or without the leading `#`. */
  color?: string;
  /** chromakey only, 0-1. How near a colour has to be to be keyed out. */
  threshold?: number;
  /** blur / radialblur only. */
  strength?: number;
};

/** Matches the value `optionVideo`'s "Add Filter" button seeds. */
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_STRENGTH = 1;

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = String(hex ?? "").replace(/^#/, "").trim();

  // Three-digit shorthand doubles each nibble, the way CSS does.
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(
      `"${hex}" is not a hex colour. Use a form like "#00ff00".`,
    );
  }

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const byte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** `{color: "#00ff00", threshold: 0.4}` -> `"r=0:g=255:b=0:f=0.4"`. */
export function formatChromakey(input: {
  color?: string;
  threshold?: number;
}): string {
  const { r, g, b } = hexToRgb(input.color ?? "#000000");
  const f = input.threshold ?? DEFAULT_THRESHOLD;
  return `r=${r}:g=${g}:b=${b}:f=${f}`;
}

/** `{strength: 8}` -> `"f=8"`. */
export function formatBlur(strength?: number): string {
  return `f=${strength ?? DEFAULT_STRENGTH}`;
}

/** A structured filter into the string the shaders read. */
export function toFilter(input: FilterInput): VideoFilterType {
  switch (input.name) {
    case "chromakey":
      return { name: "chromakey", value: formatChromakey(input) };
    case "blur":
    case "radialblur":
      return { name: input.name, value: formatBlur(input.strength) };
    default:
      throw new Error(`Unknown filter "${(input as any).name}".`);
  }
}

/** The stored filter as an agent should see it. */
export function describeFilter(
  filter: VideoFilterType,
): Record<string, unknown> {
  if (filter?.name === "chromakey") {
    const { r, g, b, f } = parseRGBString(filter.value ?? "");
    return {
      name: "chromakey",
      color: rgbToHex(r, g, b),
      threshold: f,
    };
  }

  if (filter?.name === "blur" || filter?.name === "radialblur") {
    return { name: filter.name, strength: parseBlurString(filter.value ?? "").f };
  }

  return { name: filter?.name };
}
