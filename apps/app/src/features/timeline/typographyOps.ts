/**
 * Turning a text clip into a typography graphic: `apply_typography`.
 *
 * The second place in the repo where one element becomes another kind, and it
 * follows the first (`rasterize.ts#rasterizeTextInDoc`) exactly: the graphic
 * keeps the text's id and `trackId` and replaces it in place, so selection,
 * keyframes and group membership never notice the swap, and Cmd+Z brings the
 * text back whole.
 *
 * What carries across is decided by the program, never guessed from parameter
 * names: an HTML manifest's `render.bindings` names the parameter that takes
 * the text, the face, the colour, the size and the alignment. A text field
 * nothing receives is reported in `dropped`, and so is every styling the
 * graphic has no equivalent for (runs, reveal, outline, shadow and the rest),
 * because a silent loss is the failure this whole report exists to prevent.
 *
 * Pure and registry-free: the caller resolves the preset and hands it in, and
 * a font path becomes a parameter value through `fontValueOf`, which is where
 * the font library's knowledge of the bundled faces enters.
 */

import type {
  FxParams,
  GraphicElementType,
  InlineProgram,
  TextElementType,
  TimelineElement,
} from "../../@types/timeline";
import { animatableProperties } from "../../@types/timeline";
import { cloneAnimation, offsetKeyframeValues } from "../animation/keyframes";
import { createGraphicElement, GRAPHIC_CLIP_COLOR } from "../element/graphicElement";
import type {
  FxHtmlRender,
  FxPreset,
  PresetParamSpec,
  TextBindingField,
} from "../fx/presetTypes";
import { remapMask } from "./rasterize";
import { normalizeDocument, type TimelineDocument } from "./tracks";

/** What the text becomes. */
export type TypographyTarget = {
  preset: FxPreset;
  /** Present when the preset is an inline program rather than an installed one. */
  program?: InlineProgram;
  /** Values the caller set. They win over anything a binding would carry. */
  overrides?: FxParams;
};

export type GraphicTwin = {
  graphic: GraphicElementType;
  /** Each text property that did not survive, by name. Empty when nothing was lost. */
  dropped: string[];
};

/** A font path as a font parameter's value. The default keeps an absolute path. */
export type FontValueOf = (fontpath: string) => string;

const keepPath: FontValueOf = (fontpath) =>
  fontpath === "" || fontpath === "default" ? "default" : fontpath;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as `#rrggbb`, or `null` for anything else. */
export function hexColorOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) {
    return hex;
  }
  if (/^#[0-9a-f]{8}$/.test(hex)) {
    return hex.slice(0, 7);
  }
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return "#" + [...hex.slice(1)].map((c) => c + c).join("");
  }
  return null;
}

function paramNamed(preset: FxPreset, key: string | undefined): PresetParamSpec | null {
  if (key == null) {
    return null;
  }
  return preset.params.find((param) => param.key === key) ?? null;
}

function bindingsOf(preset: FxPreset): Partial<Record<TextBindingField, string>> {
  return preset.render.type === "html" ? ((preset.render as FxHtmlRender).bindings ?? {}) : {};
}

/** Layout px per box px, which is what a font size in timeline px has to be multiplied by. */
function layoutPerBox(preset: FxPreset, boxWidth: number): number {
  const render = preset.render as FxHtmlRender;
  if (render.type === "html" && render.layout === "scale" && render.designSize != null && boxWidth > 0) {
    return render.designSize.width / boxWidth;
  }
  return 1;
}

/**
 * The parameter values a text clip carries into a preset, and the text fields
 * no binding received.
 */
export function boundParams(
  text: TextElementType,
  preset: FxPreset,
  boxWidth: number,
  fontValueOf: FontValueOf,
): { params: FxParams; unbound: string[] } {
  const bindings = bindingsOf(preset);
  const params: FxParams = {};
  const unbound: string[] = [];

  const textParam = paramNamed(preset, bindings.text);
  if (textParam?.type === "text") {
    const max = textParam.maxLength ?? 500;
    const value = String(text.text ?? "");
    params[textParam.key] = value.slice(0, max);
    if (value.length > max) {
      unbound.push(`text past ${max} characters`);
    }
  } else if ((text.text ?? "") !== "") {
    unbound.push("text");
  }

  const fontParam = paramNamed(preset, bindings.font);
  const fontpath = text.fontpath ?? "default";
  if (fontParam?.type === "font") {
    params[fontParam.key] = fontValueOf(fontpath);
  } else if (fontpath !== "" && fontpath !== "default") {
    unbound.push("font");
  }

  const colorParam = paramNamed(preset, bindings.color);
  const color = hexColorOf(text.textcolor);
  if (colorParam?.type === "color" && color != null) {
    params[colorParam.key] = color;
  } else if (text.textcolor != null && text.textcolor !== "") {
    unbound.push("color");
  }

  const sizeParam = paramNamed(preset, bindings.fontSize);
  if (sizeParam?.type === "number" && Number.isFinite(text.fontsize)) {
    const size = text.fontsize * layoutPerBox(preset, boxWidth);
    params[sizeParam.key] = Math.round(Math.min(sizeParam.max, Math.max(sizeParam.min, size)));
  } else if (Number.isFinite(text.fontsize)) {
    unbound.push("fontSize");
  }

  const alignParam = paramNamed(preset, bindings.align);
  const align = text.options?.align ?? "center";
  const option =
    alignParam?.type === "select"
      ? alignParam.options.find((entry) => entry.label.toLowerCase() === align)
      : undefined;
  if (option != null) {
    params[(alignParam as PresetParamSpec).key] = option.value;
  } else if (align !== "center") {
    unbound.push("align");
  }

  return { params, unbound };
}

/** Styling a graphic has no field for, named when the text uses it. */
function lostStyling(text: TextElementType): string[] {
  const lost: string[] = [];
  const options = text.options ?? ({} as TextElementType["options"]);
  if (Array.isArray(text.runs) && text.runs.length > 0) lost.push("runs");
  if (text.reveal != null) lost.push("reveal");
  if (options.outline?.enable === true) lost.push("outline");
  if (options.shadow?.enable === true) lost.push("shadow");
  if (options.glow?.enable === true) lost.push("glow");
  if (text.background?.enable === true) lost.push("background");
  if (text.fill != null && text.fill.type !== "solid") lost.push("fill");
  if (text.textOpacity != null && text.textOpacity !== 100) lost.push("textOpacity");
  if (options.textTransform != null && options.textTransform !== "none") lost.push("textTransform");
  if (Number.isFinite(text.letterSpacing) && text.letterSpacing !== 0) lost.push("letterSpacing");
  if (options.lineHeight != null) lost.push("lineHeight");
  if (options.isBold === true) lost.push("bold");
  if (options.isItalic === true) lost.push("italic");
  if (text.replaceable != null) lost.push("replaceable");
  return lost;
}

/**
 * The box the graphic takes: the text's own, except that a `scale` program is
 * given its design aspect at the text's width, about the text's centre, because
 * a scaled layout is stretched to whatever box it is drawn into. A clip whose
 * size is keyframed keeps its box, since its curve is the author's.
 */
function boxFor(
  text: TextElementType,
  preset: FxPreset,
): { x: number; y: number; width: number; height: number } {
  const own = { x: text.location.x, y: text.location.y, width: text.width, height: text.height };
  const render = preset.render as FxHtmlRender;
  const sizeKeyed = ((text as any).animation?.size?.x?.length ?? 0) > 0;
  if (
    render.type !== "html" ||
    render.layout !== "scale" ||
    render.designSize == null ||
    !(text.width > 0) ||
    sizeKeyed
  ) {
    return own;
  }
  const height = Math.round((text.width * render.designSize.height) / render.designSize.width);
  return { ...own, y: Math.round(text.location.y + (text.height - height) / 2), height };
}

/** Slide the position curve's y lane by `dy`, so a recentred box keeps its path. */
function withPositionShift(animation: any, dy: number): any {
  const position = animation?.position;
  if (dy === 0 || position == null) {
    return animation;
  }
  return {
    ...animation,
    position: {
      ...position,
      y: offsetKeyframeValues(Array.isArray(position.y) ? position.y : [], dy),
      ay: (Array.isArray(position.ay) ? position.ay : []).map(([t, v]: number[]) => [t, v + dy]),
    },
  };
}

/** The graphic that stands in for a text clip, and what did not carry. */
export function graphicTwinOf(
  text: TextElementType,
  target: TypographyTarget,
  fontValueOf: FontValueOf = keepPath,
): GraphicTwin {
  const { preset } = target;
  const box = boxFor(text, preset);
  const { params: bound, unbound } = boundParams(text, preset, box.width, fontValueOf);
  const defaults: FxParams = {};
  for (const param of preset.params) {
    defaults[param.key] = param.default as FxParams[string];
  }
  const params: FxParams = { ...defaults, ...bound, ...(target.overrides ?? {}) };

  const base = createGraphicElement({
    presetId: preset.id,
    program: target.program,
    params,
    name: preset.name,
    startTime: text.startTime,
    duration: text.duration,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  });

  const graphic: any = {
    ...base,
    key: text.key,
    trackId: text.trackId,
    priority: text.priority,
    opacity: text.opacity,
    rotation: text.rotation,
    timelineOptions: { color: GRAPHIC_CLIP_COLOR },
  };
  for (const field of ["parentId", "ext", "blend", "lut", "adjust", "link"] as const) {
    if ((text as any)[field] != null) {
      graphic[field] = (text as any)[field];
    }
  }
  if ((text as any).scale != null) {
    graphic.scale = (text as any).scale;
  }
  if (text.mask != null) {
    const mask = remapMask(text, box);
    if (mask != null) {
      graphic.mask = mask;
    }
  }

  // The text's curves, minus the ones a graphic has no property for. Whatever
  // is cut and had keyframes is reported, so a reveal's progress curve does not
  // vanish unremarked.
  const copied = cloneAnimation(text) as any;
  const keep = new Set<string>(animatableProperties(graphic as TimelineElement));
  const animation: Record<string, unknown> = { ...graphic.animation };
  const lostCurves: string[] = [];
  for (const [property, track] of Object.entries<any>(copied.animation ?? {})) {
    if (keep.has(property)) {
      animation[property] = track;
    } else if ((track?.x?.length ?? 0) > 0 || (track?.y?.length ?? 0) > 0) {
      lostCurves.push(`keyframes:${property}`);
    }
  }
  graphic.animation = withPositionShift(animation, box.y - text.location.y);

  return {
    graphic: graphic as GraphicElementType,
    dropped: [...unbound, ...lostStyling(text), ...lostCurves],
  };
}

/** Whether an element can be converted at all. */
export function canApplyTypography(
  element: TimelineElement | undefined,
): element is TextElementType {
  return element != null && element.filetype === "text";
}

/**
 * Replace text clips with graphics drawing `target`, in one document change.
 * Declines, by identity, when none of the ids names a text clip.
 */
export function textToGraphic(
  doc: TimelineDocument,
  elementIds: string[],
  target: TypographyTarget,
  fontValueOf: FontValueOf = keepPath,
): TimelineDocument {
  let elements: TimelineDocument["elements"] | null = null;
  for (const id of elementIds) {
    const text = doc.elements[id];
    if (!canApplyTypography(text)) {
      continue;
    }
    elements ??= { ...doc.elements };
    elements[id] = graphicTwinOf(text, target, fontValueOf).graphic;
  }
  return elements == null ? doc : normalizeDocument({ ...doc, elements });
}
