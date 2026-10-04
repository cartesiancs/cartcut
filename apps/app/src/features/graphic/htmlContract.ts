/**
 * The values an HTML graphic sees: CSS variables on its root, and text in its
 * `[data-param]` elements.
 *
 * Pure, so the contract the editing skill documents is pinned by a node suite
 * rather than by reading `htmlHost.ts`:
 *
 * | variable | value |
 * |---|---|
 * | `--t` | program time in seconds, `clockHead` included, frame-snapped |
 * | `--progress` | `--t / --dur`, 0..1, continuous across a split |
 * | `--dur` | the whole program's length in seconds |
 * | `--w`, `--h` | the layout box, in px |
 * | `--seed` | the `seed` parameter, or 0 |
 * | `--<key>` | each parameter: a number, `1`/`0`, `#rrggbb`, a family list, `url(...)` |
 * | `--<key>-x`, `--<key>-y` | each `point` parameter's two halves |
 *
 * Numbers are written with at most six decimals, so two machines produce the
 * same string for the same frame and the raster cache keys agree.
 */

import type { GraphicElementType } from "../../@types/timeline";
import { FX_PARAM_TRACK_PREFIX } from "../../@types/timeline";
import type {
  FxHtmlRender,
  FxParamValues,
  FxPreset,
  PresetParamSpec,
} from "../fx/presetTypes";
import { colorToVec3 } from "../fx/glslWrap";
import type { GraphicTime } from "./graphicTime";

/** Six decimals, no trailing zeros, no `-0`. */
export function cssNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function hexOf(value: unknown, fallback: string): string {
  const rgb = typeof value === "string" ? colorToVec3(value) : null;
  const use = rgb ?? colorToVec3(fallback) ?? [0, 0, 0];
  return (
    "#" +
    use
      .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

export type ContractResolvers = {
  /** The family list for a `font` parameter's value. */
  fontFamilyOf: (value: string) => string;
  /** A loadable URL for an `image` parameter's path, or `null` for none. */
  imageUrlOf: (path: string) => string | null;
};

/** One parameter's variables. Text parameters have none; they fill slots. */
function paramVariables(
  param: PresetParamSpec,
  stored: FxParamValues[string] | undefined,
  resolvers: ContractResolvers,
): Array<[string, string]> {
  const name = "--" + param.key;
  switch (param.type) {
    case "number": {
      const value = typeof stored === "number" && Number.isFinite(stored) ? stored : param.default;
      return [[name, cssNumber(clamp(value, param.min, param.max))]];
    }
    case "bool":
      return [[name, (typeof stored === "boolean" ? stored : param.default) ? "1" : "0"]];
    case "select": {
      const allowed = param.options.some((option) => option.value === stored);
      return [[name, cssNumber(allowed ? (stored as number) : param.default)]];
    }
    case "color":
      return [[name, hexOf(stored, param.default)]];
    case "point": {
      const valid =
        Array.isArray(stored) &&
        stored.length === 2 &&
        stored.every((n) => typeof n === "number" && Number.isFinite(n));
      const [x, y] = valid ? (stored as number[]) : param.default;
      return [
        [name + "-x", cssNumber(clamp(x, param.min, param.max))],
        [name + "-y", cssNumber(clamp(y, param.min, param.max))],
      ];
    }
    case "font":
      return [[name, resolvers.fontFamilyOf(typeof stored === "string" ? stored : param.default)]];
    case "image": {
      const path = typeof stored === "string" ? stored : param.default;
      const url = path === "" ? null : resolvers.imageUrlOf(path);
      return [[name, url == null ? "none" : `url(${JSON.stringify(url)})`]];
    }
    case "text":
    default:
      return [];
  }
}

/** Every variable the host sets on the root for one frame. */
export function cssVariablesFor(
  preset: FxPreset,
  params: FxParamValues,
  time: GraphicTime,
  box: { width: number; height: number },
  resolvers: ContractResolvers,
): Record<string, string> {
  const out: Record<string, string> = {
    "--t": cssNumber(time.tMs / 1000),
    "--progress": cssNumber(time.progress),
    "--dur": cssNumber(time.durMs / 1000),
    "--w": cssNumber(box.width) + "px",
    "--h": cssNumber(box.height) + "px",
    "--seed": "0",
  };
  for (const param of preset.params) {
    for (const [name, value] of paramVariables(param, params[param.key], resolvers)) {
      out[name] = value;
    }
  }
  return out;
}

/** Each text parameter's value, cut to its declared length. */
export function textSlotsFor(preset: FxPreset, params: FxParamValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of preset.params) {
    if (param.type !== "text") {
      continue;
    }
    const stored = params[param.key];
    const value = typeof stored === "string" ? stored : param.default;
    out[param.key] = value.slice(0, Math.min(5000, param.maxLength ?? 500));
  }
  return out;
}

/** The seed `--rand` is mixed with: the `seed` parameter when it is a number. */
export function seedOf(params: FxParamValues): number {
  const seed = params.seed;
  return typeof seed === "number" && Number.isFinite(seed) ? Math.round(seed) : 0;
}

/** Everything in a program that moves with time on its own. */
const MOVES = /(@keyframes|\banimation\s*:|\banimation-name\s*:|var\(\s*--t\b|var\(\s*--progress\b|<animate|<set\b|<animateTransform|<animateMotion)/i;

/**
 * Whether one raster serves every frame of this clip: no CSS animation, no
 * SMIL, nothing reading `--t` or `--progress`, and no parameter keyframed.
 *
 * `--dur` does not make a graphic move by itself (it changes only when the
 * clip is trimmed), so it goes into the cache key instead of this test.
 */
export function isStaticHtml(preset: FxPreset, element: GraphicElementType): boolean {
  const render = preset.render as FxHtmlRender;
  const texts = [render.source, ...(render.styles ?? [])].map((name) => preset.sources[name] ?? "");
  if (texts.some((text) => MOVES.test(text))) {
    return false;
  }
  const animation = (element as { animation?: Record<string, { isActivate?: boolean }> }).animation ?? {};
  for (const [property, track] of Object.entries(animation)) {
    if (property.startsWith(FX_PARAM_TRACK_PREFIX) && track?.isActivate === true) {
      return false;
    }
  }
  return true;
}

/** The layout box: the clip's own for `reflow`, the design size for `scale`. */
export function layoutBoxOf(
  preset: FxPreset,
  box: { width: number; height: number },
): { width: number; height: number } {
  const render = preset.render as FxHtmlRender;
  if (render.layout === "scale" && render.designSize != null) {
    return { width: render.designSize.width, height: render.designSize.height };
  }
  return { width: Math.max(1, box.width), height: Math.max(1, box.height) };
}

/** Layout px of bleed, scaled into box px when the layout is scaled. */
export function bleedInBox(
  preset: FxPreset,
  box: { width: number; height: number },
): number {
  const render = preset.render as FxHtmlRender;
  const bleed = typeof render.bleed === "number" && render.bleed > 0 ? render.bleed : 0;
  if (bleed === 0) {
    return 0;
  }
  const layout = layoutBoxOf(preset, box);
  return bleed * (box.width / layout.width);
}
