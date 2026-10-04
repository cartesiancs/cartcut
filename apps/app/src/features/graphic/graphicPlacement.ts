/**
 * Where a new graphic lands when nobody says: the box and the kind of row.
 *
 * Shared by the agent's `add_graphic`, the preset browser's click and a drop on
 * the timeline, so the three cannot disagree about where a title goes.
 */

import type { FxHtmlRender, FxPreset } from "../fx/presetTypes";
import type { AddGraphicOptions } from "../timeline/graphicOps";
import type { TrackKind } from "../timeline/tracks";
import { DEFAULT_GRAPHIC_MS } from "../element/graphicElement";
import { defaultParamsOf } from "../fx/presetTypes";

type Box = { x?: number; y?: number; width?: number; height?: number };

/**
 * The box a new graphic takes when the caller gives none: an HTML program's
 * design size when it declares one, otherwise the whole frame. Centred in the
 * frame when no position is given.
 */
export function defaultBox(preset: FxPreset, box: Box, project: { w: number; h: number }) {
  const design = (preset.render as FxHtmlRender).designSize;
  const width = box.width ?? design?.width ?? project.w;
  const height = box.height ?? design?.height ?? project.h;
  return {
    width,
    height,
    x: box.x ?? Math.round((project.w - width) / 2),
    y: box.y ?? Math.round((project.h - height) / 2),
  };
}

/** Lettering goes in front of the picture; a generated background behind it. */
export function trackKindFor(preset: FxPreset): TrackKind {
  return preset.render.type === "shader" ? "video" : "text";
}

/** Everything `addGraphic` needs to place an installed preset at a time. */
export function newGraphicOptions(
  preset: FxPreset,
  startMs: number,
  project: { w: number; h: number },
  preferredTrackId?: string,
): AddGraphicOptions {
  return {
    presetId: preset.id,
    params: defaultParamsOf(preset),
    name: preset.name,
    startMs: Math.max(0, startMs),
    durationMs: DEFAULT_GRAPHIC_MS,
    ...defaultBox(preset, {}, project),
    preferredTrackId,
    trackKind: trackKindFor(preset),
  };
}
