/**
 * Which HTML graphics need a raster for this frame, and exactly what for.
 *
 * Pure: everything it needs from the outside (presets, template contents, the
 * device scale the preview last drew at, how a font or an image resolves) comes
 * in through `PlanInput`, so the decisions the prepare step makes are tested
 * under `environment: "node"`.
 *
 * A job is planned for every HTML graphic the composite will draw: those whose
 * own span covers the frame, those a transition draws past their span
 * (`isElementVisibleAtTime` covers both), and those inside a visible template,
 * at the template's clamped inner cursor and under the ids the template
 * renderer itself uses. A hidden row's clips are skipped, as the paint loop
 * skips them.
 *
 * The `key` is what decides whether a raster is current: the program, the
 * values, the raster size and the duration, and the program time unless the
 * graphic is static. A static graphic is therefore rasterised once and then
 * left alone for the whole time it is on screen.
 */

import type {
  GraphicElementType,
  TemplateElementType,
  Timeline,
  TimelineElement,
} from "../../@types/timeline";
import { isVisualTimelineElement } from "../../@types/timeline";
import { isElementVisibleAtTime } from "../element/time";
import type { FxHtmlRender, FxPreset } from "../fx/presetTypes";
import { digest64 } from "../project/projectDigest";
import { stableStringify } from "../fx/programHash";
import { sampleFxParams } from "../renderer/fx/effectSample";
import { rasterSizeFor } from "../renderer/graphicGl";
import { frameStartMs } from "../timeline/frames";
import { sampledBoxOf } from "../timeline/transform";
import { graphicTimeOf, type GraphicTime } from "./graphicTime";
import {
  cssVariablesFor,
  isStaticHtml,
  layoutBoxOf,
  seedOf,
  textSlotsFor,
  type ContractResolvers,
} from "./htmlContract";

export type GraphicJob = {
  /** The id the renderer will draw it under: namespaced inside a template. */
  instanceId: string;
  element: GraphicElementType;
  preset: FxPreset;
  key: string;
  time: GraphicTime;
  vars: Record<string, string>;
  texts: Record<string, string>;
  /** Where the program lays out, px. */
  layoutBox: { width: number; height: number };
  /** Layout px around it on every side. */
  bleed: number;
  /** Device pixels of the raster, bleed included. */
  raster: { width: number; height: number };
  seed: number;
  static: boolean;
};

export type PlanInput = {
  elements: Timeline;
  timeInMs: number;
  fps: number;
  presetOf: (element: GraphicElementType) => FxPreset | null;
  /** A template's contents at its inner cursor, or `null` when not ready. */
  expandTemplate?: (
    elementId: string,
    element: TemplateElementType,
    cursor: number,
  ) => { elements: Timeline; cursor: number } | null;
  /** Device pixels per box pixel. 1 in an export; the noted zoom in the preview. */
  scaleOf: (instanceId: string) => number;
  resolvers: ContractResolvers;
  /** Bumped when a font finishes loading, so a raster drawn in the fallback is redrawn. */
  fontGeneration: number;
};

/** A digest of a preset's content, kept per object: installed presets can be reinstalled. */
const contentKeys = new WeakMap<FxPreset, string>();

function contentKeyOf(preset: FxPreset): string {
  const known = contentKeys.get(preset);
  if (known != null) {
    return known;
  }
  const key = preset.id + "@" + digest64(stableStringify({ r: preset.render, p: preset.params, s: preset.sources }));
  contentKeys.set(preset, key);
  return key;
}

/**
 * Scale to the next step of a ladder of thirds of an octave (2^(k/3)), so an
 * animated `scale` or a zoom in progress does not mint a new raster size, and
 * with it a new raster, every frame. The ladder lands on 1, 2 and 4 exactly,
 * which are the device ratios most displays have. Rounded up: a raster slightly
 * too large is invisible, one too small is blurry.
 */
export function quantizeScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1;
  }
  const step = Math.ceil(Math.log2(scale) * 3 - 1e-9);
  return Math.round(Math.pow(2, step / 3) * 10000) / 10000;
}

function isHtmlGraphic(
  element: TimelineElement,
  presetOf: PlanInput["presetOf"],
): FxPreset | null {
  if (element.filetype !== "graphic") {
    return null;
  }
  const preset = presetOf(element);
  return preset != null && preset.render.type === "html" ? preset : null;
}

function planOne(
  instanceId: string,
  element: GraphicElementType,
  preset: FxPreset,
  cursor: number,
  input: PlanInput,
): GraphicJob {
  const time = graphicTimeOf(element, cursor, input.fps);
  const params = sampleFxParams(element, frameStartMs(cursor, input.fps));
  const box = sampledBoxOf(element, cursor);
  const layoutBox = layoutBoxOf(preset, box);
  const render = preset.render as FxHtmlRender;
  const bleed = typeof render.bleed === "number" && render.bleed > 0 ? render.bleed : 0;
  const scale = quantizeScale(input.scaleOf(instanceId)) * (box.width / layoutBox.width);
  const raster = rasterSizeFor(
    layoutBox.width + 2 * bleed,
    layoutBox.height + 2 * bleed,
    scale,
  );
  const isStatic = isStaticHtml(preset, element);
  const texts = textSlotsFor(preset, params);
  const seed = seedOf(params);
  const vars = cssVariablesFor(preset, params, time, layoutBox, input.resolvers);
  const valuesKey = digest64(stableStringify({ vars: isStatic ? { ...vars, "--t": "", "--progress": "" } : vars, texts }));
  const key = [
    contentKeyOf(preset),
    valuesKey,
    raster.width + "x" + raster.height,
    "f" + input.fontGeneration,
    isStatic ? "static" : "t" + Math.round(time.tMs * 1000) / 1000,
  ].join("|");
  return {
    instanceId,
    element,
    preset,
    key,
    time,
    vars,
    texts,
    layoutBox,
    bleed,
    raster,
    seed,
    static: isStatic,
  };
}

export function planGraphics(input: PlanInput): GraphicJob[] {
  const jobs: GraphicJob[] = [];

  const visit = (elements: Timeline, cursor: number, depth: number) => {
    for (const [id, element] of Object.entries(elements)) {
      if (element == null || element.trackHidden === true) {
        continue;
      }
      if (!isVisualTimelineElement(element)) {
        continue;
      }
      if (!isElementVisibleAtTime(cursor, elements, element)) {
        continue;
      }
      if (element.filetype === "template") {
        // One level, as composition does: a template inside a template is
        // stripped by `composeTemplate` and never drawn.
        if (depth > 0 || input.expandTemplate == null) {
          continue;
        }
        const inner = input.expandTemplate(id, element, cursor);
        if (inner != null) {
          visit(inner.elements, inner.cursor, depth + 1);
        }
        continue;
      }
      const preset = isHtmlGraphic(element, input.presetOf);
      if (preset == null) {
        continue;
      }
      jobs.push(planOne(id, element as GraphicElementType, preset, cursor, input));
    }
  };

  visit(input.elements, input.timeInMs, 0);
  return jobs;
}

/** Whether a map holds an HTML graphic at all, so callers can skip the host. */
export function hasHtmlGraphics(
  elements: Timeline,
  presetOf: PlanInput["presetOf"],
): boolean {
  for (const element of Object.values(elements)) {
    if (element != null && isHtmlGraphic(element, presetOf) != null) {
      return true;
    }
  }
  return false;
}
