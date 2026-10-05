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
import { frameStartMs, frameToMs, msToFrameFloor, normalizeFps } from "../timeline/frames";
import { spanOf } from "../timeline/geometry";
import { sampledBoxOf } from "../timeline/transform";
import { transitionIndex } from "../timeline/transitionWindow";
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

/**
 * `skip`: instance ids not to plan, for a caller that already has them.
 * `only`: top-level ids to consider at all, the rest of the map still there for
 * the transitions to look up; for a caller that plans many cursors at once.
 */
export function planGraphics(
  input: PlanInput,
  skip?: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): GraphicJob[] {
  const jobs: GraphicJob[] = [];

  const visit = (elements: Timeline, cursor: number, depth: number) => {
    const ids = depth === 0 && only != null ? [...only] : Object.keys(elements);
    for (const id of ids) {
      const element = elements[id];
      if (element == null || element.trackHidden === true || skip?.has(id) === true) {
        continue;
      }
      if (element.filetype !== "graphic" && element.filetype !== "template") {
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

/** How far ahead of the cursor a graphic is rasterised before it appears. */
export const LOOKAHEAD_MS = 200;

/** Most plans one lookahead costs, whatever the frame rate. */
const MAX_LOOKAHEAD_SAMPLES = 12;

/**
 * Jobs for the graphics that are not on screen at `input.timeInMs` but appear
 * within `horizonMs` of it, each planned at the first frame it is visible.
 *
 * The preview draws whatever raster a clip already has, so without this the
 * first frame of every clip during playback drew nothing on a first pass and
 * the clip's last frame from the previous pass on every later one: one frame
 * of the outro at the start of each title, and at every split point.
 *
 * Planned at the clip's own first frame rather than at the horizon, so the key
 * is the same on every draw until the clip appears and the raster is made once.
 * The frame grid is sampled at most `MAX_LOOKAHEAD_SAMPLES` times; between two
 * samples that find something new, every frame is planned, so the first frame
 * is exact at any rate. A clip shorter than one sample step that falls wholly
 * between two samples is missed, which takes a clip under 4 frames at 240 fps.
 */
export function planLookahead(
  input: PlanInput,
  current: readonly GraphicJob[],
  horizonMs: number = LOOKAHEAD_MS,
): GraphicJob[] {
  const fps = normalizeFps(input.fps);
  const from = msToFrameFloor(input.timeInMs, fps);
  const to = msToFrameFloor(input.timeInMs + Math.max(0, horizonMs), fps);
  if (to <= from) {
    return [];
  }
  const step = Math.max(1, Math.ceil((to - from) / MAX_LOOKAHEAD_SAMPLES));
  const seen = new Set(current.map((job) => job.instanceId));
  const ahead: GraphicJob[] = [];

  // Walked once rather than at every sample: a graphic or a template whose own
  // span reaches the window, or that a transition can draw past its span.
  const windowStart = frameToMs(from, fps);
  const windowEnd = frameToMs(to, fps);
  const transitions = transitionIndex(input.elements);
  const candidates = new Set<string>();
  for (const [id, element] of Object.entries(input.elements)) {
    if (element == null || (element.filetype !== "graphic" && element.filetype !== "template")) {
      continue;
    }
    const { start, end } = spanOf(element);
    if ((end > windowStart && start <= windowEnd) || transitions.has(element)) {
      candidates.add(id);
    }
  }
  if (candidates.size === 0) {
    return [];
  }
  const planAt = (frame: number) =>
    planGraphics({ ...input, timeInMs: frameToMs(frame, fps) }, seen, candidates);
  const take = (jobs: GraphicJob[]) => {
    for (const job of jobs) {
      if (!seen.has(job.instanceId)) {
        seen.add(job.instanceId);
        ahead.push(job);
      }
    }
  };

  let previous = from;
  for (let frame = Math.min(from + step, to); ; frame = Math.min(frame + step, to)) {
    const found = planAt(frame);
    if (found.length > 0) {
      for (let between = previous + 1; between < frame; between += 1) {
        take(planAt(between));
      }
      take(found);
    }
    if (frame >= to) {
      break;
    }
    previous = frame;
  }
  return ahead;
}

/**
 * The id of every graphic the composite could draw, template contents
 * included under the ids the template renderer uses (`outerId::innerKey`).
 * What the preview keeps its rasters and its host's mounts for; a cache swept
 * against the top-level ids alone dropped a template's graphic on every frame.
 */
export function graphicInstanceIds(
  elements: Timeline,
  expandTemplate?: PlanInput["expandTemplate"],
): Set<string> {
  const ids = new Set<string>();
  for (const [id, element] of Object.entries(elements)) {
    if (element?.filetype === "graphic") {
      ids.add(id);
    } else if (element?.filetype === "template" && expandTemplate != null) {
      const inner = expandTemplate(id, element, element.startTime);
      for (const [innerId, innerElement] of Object.entries(inner?.elements ?? {})) {
        if (innerElement?.filetype === "graphic") {
          ids.add(innerId);
        }
      }
    }
  }
  return ids;
}

/**
 * Whether a map holds an HTML graphic at all, inside a template included when
 * `expandTemplate` is given, so callers can skip the host.
 */
export function hasHtmlGraphics(
  elements: Timeline,
  presetOf: PlanInput["presetOf"],
  expandTemplate?: PlanInput["expandTemplate"],
): boolean {
  for (const [id, element] of Object.entries(elements)) {
    if (element == null) {
      continue;
    }
    if (isHtmlGraphic(element, presetOf) != null) {
      return true;
    }
    if (element.filetype === "template" && expandTemplate != null) {
      const inner = expandTemplate(id, element, element.startTime);
      for (const innerElement of Object.values(inner?.elements ?? {})) {
        if (innerElement != null && isHtmlGraphic(innerElement, presetOf) != null) {
          return true;
        }
      }
    }
  }
  return false;
}
