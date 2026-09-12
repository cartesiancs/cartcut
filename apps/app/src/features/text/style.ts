/**
 * What a text element's style *means*, with every default already filled in.
 *
 * Text effects arrived after the element type did, so `shadow`, `glow`, `fill`,
 * `textOpacity` and the new `background`/`outline` sub-fields are all optional:
 * a project saved before them has none, and `.ngt` load runs no migration
 * (`functions/project.ts` refuses a version mismatch outright rather than
 * upgrading). Without a single place to say what absent means, the `?? false`
 * chains multiply across four call sites that must agree — the renderer, the
 * option panel, the preset tile preview, and rasterisation — and they drift.
 *
 * So they resolve here, once. Every default is "off", which is what makes an
 * old project render exactly as it did before this module existed.
 *
 * Deliberately DOM-free: it runs under `environment: "node"` alongside
 * `features/timeline/`, and the renderer suites import it while drawing onto a
 * Skia canvas.
 */

import type {
  TextElementType,
  TextFill,
  TextGlow,
  TextShadow,
} from "../../@types/timeline";
import { normalizeLineHeight } from "./metrics";

export type ResolvedOutline = {
  enable: boolean;
  size: number;
  color: string;
  opacity: number;
};

export type ResolvedBackground = {
  enable: boolean;
  color: string;
  opacity: number;
  padding: number;
  radius: number;
  /** Backdrop blur behind the band, in element pixels. 0 is no frost. */
  blur: number;
};

export type ResolvedTextStyle = {
  shadow: TextShadow;
  glow: TextGlow;
  outline: ResolvedOutline;
  background: ResolvedBackground;
  fill: TextFill;
  textOpacity: number;
  textTransform: "none" | "uppercase" | "lowercase";
  /** Leading, as a multiple of the font size. See `text/metrics.ts`. */
  lineHeight: number;
};

/**
 * The padding `renderText` used to hard-code. Kept as the default so that an
 * element with no `background.padding` draws the box it always drew.
 */
export const DEFAULT_BACKGROUND_PADDING = 12;

const DEFAULT_SHADOW: TextShadow = {
  enable: false,
  offsetX: 4,
  offsetY: 4,
  blur: 12,
  color: "#000000",
  opacity: 60,
};

const DEFAULT_GLOW: TextGlow = {
  enable: false,
  size: 16,
  color: "#00e5ff",
  opacity: 80,
};

/**
 * Clamp into `[min, max]`, mapping anything non-finite to `fallback`.
 *
 * The option panel writes straight from `<input>` values, so `""` → `NaN`
 * reaches the store on an emptied field. A `NaN` blur silently disables the
 * whole shadow in canvas rather than throwing, which is the kind of bug that
 * gets reported as "the shadow just stopped working sometimes".
 */
function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function resolveShadow(shadow: TextShadow | undefined): TextShadow {
  if (shadow == null) {
    return { ...DEFAULT_SHADOW };
  }
  return {
    enable: bool(shadow.enable),
    // Offsets go both ways; blur cannot. Canvas throws on a negative
    // `shadowBlur`, so the clamp is load-bearing rather than cosmetic.
    offsetX: num(shadow.offsetX, DEFAULT_SHADOW.offsetX, -1000, 1000),
    offsetY: num(shadow.offsetY, DEFAULT_SHADOW.offsetY, -1000, 1000),
    blur: num(shadow.blur, DEFAULT_SHADOW.blur, 0, 500),
    color: str(shadow.color, DEFAULT_SHADOW.color),
    opacity: num(shadow.opacity, DEFAULT_SHADOW.opacity, 0, 100),
  };
}

function resolveGlow(glow: TextGlow | undefined): TextGlow {
  if (glow == null) {
    return { ...DEFAULT_GLOW };
  }
  return {
    enable: bool(glow.enable),
    size: num(glow.size, DEFAULT_GLOW.size, 0, 500),
    color: str(glow.color, DEFAULT_GLOW.color),
    opacity: num(glow.opacity, DEFAULT_GLOW.opacity, 0, 100),
  };
}

function resolveFill(fill: TextFill | undefined): TextFill {
  if (fill == null || fill.type !== "gradient") {
    return { type: "solid" };
  }
  return {
    type: "gradient",
    from: str(fill.from, "#ffffff"),
    to: str(fill.to, "#7c5cff"),
    // Wraps rather than clamps: 370° and 10° are the same gradient, and a user
    // dragging an angle past the end expects it to come round.
    angle: ((num(fill.angle, 90, -100000, 100000) % 360) + 360) % 360,
  };
}

/** Fill in everything a text element left unsaid. */
export function resolveTextStyle(element: TextElementType): ResolvedTextStyle {
  const options = element.options ?? ({} as TextElementType["options"]);
  const outline = options.outline;
  const background = element.background;

  return {
    shadow: resolveShadow(options.shadow),
    glow: resolveGlow(options.glow),
    outline: {
      enable: bool(outline?.enable),
      size: num(outline?.size, 1, 0, 200),
      color: str(outline?.color, "#000000"),
      opacity: num(outline?.opacity, 100, 0, 100),
    },
    background: {
      enable: bool(background?.enable),
      color: str(background?.color, "#000000"),
      opacity: num(background?.opacity, 100, 0, 100),
      padding: num(
        background?.padding,
        DEFAULT_BACKGROUND_PADDING,
        0,
        500,
      ),
      radius: num(background?.radius, 0, 0, 500),
      // Clamped like the shadow's blur, and load-bearing for the same reason:
      // it reaches the device as `filter: blur(Npx)`, which a negative value
      // makes invalid — and an invalid `filter` is ignored silently, so the
      // frost would simply stop happening.
      blur: num(background?.blur, 0, 0, 500),
    },
    fill: resolveFill(element.fill),
    textOpacity: num(element.textOpacity, 100, 0, 100),
    textTransform:
      options.textTransform === "uppercase" ||
      options.textTransform === "lowercase"
        ? options.textTransform
        : "none",
    lineHeight: normalizeLineHeight(options.lineHeight),
  };
}

/**
 * The string that should actually be drawn.
 *
 * Case conversion has to happen before measurement, not at paint time: the wrap
 * is greedy over `measureText`, and "ABCDE" is wider than "abcde" in nearly
 * every face. Feeding the transformed string through the whole pipeline also
 * means `wrapCache`'s key picks the change up for free, since the key contains
 * the text.
 */
export function displayTextOf(element: TextElementType): string {
  const text = element.text ?? "";
  switch (resolveTextStyle(element).textTransform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    default:
      return text;
  }
}

/**
 * How far the ink can spill outside the element's own box.
 *
 * Shadow, glow and outline all paint beyond `width`×`height`. Rasterisation
 * renders onto a canvas of exactly that size, so without a margin the very
 * effects this feature adds would be sliced off at the edge of the PNG.
 *
 * The background box is included because a rounded box with padding also grows
 * outward — `renderText` insets it by `-padding` on the left.
 */
export function styleBleed(style: ResolvedTextStyle): number {
  let bleed = 0;

  if (style.outline.enable) {
    // The stroke straddles the glyph outline, so only half of it is outside.
    bleed = Math.max(bleed, style.outline.size / 2);
  }
  if (style.glow.enable) {
    bleed = Math.max(bleed, style.glow.size);
  }
  if (style.shadow.enable) {
    bleed = Math.max(
      bleed,
      Math.abs(style.shadow.offsetX) + style.shadow.blur,
      Math.abs(style.shadow.offsetY) + style.shadow.blur,
    );
  }
  if (style.background.enable) {
    // `background.blur` adds nothing here. It is a *backdrop* blur, clipped to
    // the band it frosts, so however large it is the band's own footprint is
    // still `padding` — and rasterisation, which is what this margin is for,
    // has no backdrop to frost in the first place.
    bleed = Math.max(bleed, style.background.padding);
  }

  // A couple of pixels of slack for antialiasing at the very edge of a blur.
  return Math.ceil(bleed) + 2;
}

/**
 * `#rrggbb` plus an opacity percentage, as a canvas-ready colour.
 *
 * Opacity is folded into the colour rather than applied with `globalAlpha`
 * because these values scope to a single paint — the shadow, the outline, the
 * box — while `globalAlpha` is already carrying the element's own opacity from
 * `renderer/element.ts` and must keep doing so.
 *
 * Non-hex input (`rgb(...)`, a named colour) is passed through unchanged at
 * full opacity: better to draw the right colour opaquely than to drop the paint
 * entirely on a string this cannot parse.
 */
export function withAlpha(color: string, opacityPercent: number): string {
  const alpha = Math.min(1, Math.max(0, opacityPercent / 100));
  if (alpha >= 1) {
    return color;
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex == null) {
    return color;
  }

  let body = hex[1];
  if (body.length === 3) {
    body = body
      .split("")
      .map((c) => c + c)
      .join("");
  }

  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}
