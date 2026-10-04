/**
 * Document-level edits to a graphic.
 *
 * Modelled on `effectOps.ts`, including its rule that switching preset
 * **replaces** the parameters rather than carrying them over: the caller passes
 * the full set, starting from the new preset's defaults. This module stays
 * DOM-free and knows nothing about the registry.
 *
 * Every mutator returns the document by identity when it changes nothing.
 */

import type {
  FxParams,
  GraphicElementType,
  InlineProgram,
} from "../../@types/timeline";
import { fxParamKeyOf, isFxParamTrack } from "../../@types/timeline";
import { createGraphicElement } from "../element/graphicElement";
import { sameProgram } from "../fx/inlineProgram";
import { inlinePresetId } from "../fx/programHash";
import { sameParams, setProgramParams } from "./effectOps";
import { placeNewElement } from "./placement";
import type { TimelineDocument, TrackKind } from "./tracks";

export type AddGraphicOptions = {
  presetId?: string;
  program?: InlineProgram;
  params?: FxParams;
  name: string;
  startMs: number;
  durationMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A row the caller aimed at. Honoured when it is the right kind and free. */
  preferredTrackId?: string;
  /**
   * `"text"` for lettering, in front of the picture; `"video"` for a generated
   * background, behind it. The caller decides from the program.
   */
  trackKind?: TrackKind;
};

/** Place a new graphic. Declines on a taken id, no length or no box. */
export function addGraphic(
  doc: TimelineDocument,
  elementId: string,
  newTrackId: string,
  options: AddGraphicOptions,
): TimelineDocument {
  if (doc.elements[elementId] != null) {
    return doc;
  }
  if (!(options.durationMs > 0) || !(options.width > 0) || !(options.height > 0)) {
    return doc;
  }
  if (options.program == null && !options.presetId) {
    return doc;
  }
  const element = createGraphicElement({
    presetId: options.presetId,
    program: options.program,
    params: options.params,
    name: options.name,
    startTime: options.startMs,
    duration: options.durationMs,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
  });
  return placeNewElement(
    doc,
    elementId,
    element,
    options.startMs,
    newTrackId,
    options.preferredTrackId,
    options.trackKind,
  );
}

function graphicAt(doc: TimelineDocument, elementId: string): GraphicElementType | null {
  const element = doc.elements[elementId];
  return element != null && element.filetype === "graphic" ? element : null;
}

function write(
  doc: TimelineDocument,
  elementId: string,
  next: GraphicElementType,
): TimelineDocument {
  return { ...doc, elements: { ...doc.elements, [elementId]: next } };
}

/** The `fx:` tracks of parameters the new values no longer hold as numbers. */
function withoutStaleParamTracks(
  element: GraphicElementType,
  params: FxParams,
): GraphicElementType {
  const animation = (element as any).animation;
  if (animation == null) {
    return element;
  }
  const next: Record<string, unknown> = {};
  let dropped = false;
  for (const property of Object.keys(animation)) {
    if (isFxParamTrack(property) && typeof params[fxParamKeyOf(property)] !== "number") {
      dropped = true;
      continue;
    }
    next[property] = animation[property];
  }
  return dropped ? ({ ...element, animation: next } as GraphicElementType) : element;
}

/** Swap to an installed preset, re-seeding the parameters. Drops any program. */
export function setGraphicPreset(
  doc: TimelineDocument,
  elementId: string,
  presetId: string,
  params: FxParams,
): TimelineDocument {
  const graphic = graphicAt(doc, elementId);
  if (graphic == null || !presetId || graphic.presetId === presetId) {
    return doc;
  }
  const { program: _program, ...rest } = graphic;
  return write(
    doc,
    elementId,
    withoutStaleParamTracks({ ...(rest as GraphicElementType), presetId, params }, params),
  );
}

/** Give a graphic an inline program. `params` is the full set. */
export function setGraphicProgram(
  doc: TimelineDocument,
  elementId: string,
  program: InlineProgram,
  params: FxParams,
): TimelineDocument {
  const graphic = graphicAt(doc, elementId);
  if (graphic == null) {
    return doc;
  }
  const presetId = inlinePresetId(program.hash);
  if (
    graphic.presetId === presetId &&
    sameProgram(graphic.program, program) &&
    sameParams(graphic.params ?? {}, params)
  ) {
    return doc;
  }
  return write(
    doc,
    elementId,
    withoutStaleParamTracks({ ...graphic, presetId, program, params }, params),
  );
}

/** Patch individual parameter values, leaving the rest alone. */
export function setGraphicParams(
  doc: TimelineDocument,
  elementId: string,
  patch: FxParams,
): TimelineDocument {
  if (graphicAt(doc, elementId) == null) {
    return doc;
  }
  return setProgramParams(doc, elementId, patch);
}

/** Rename the bar. An empty or unchanged name declines. */
export function setGraphicName(
  doc: TimelineDocument,
  elementId: string,
  name: string,
): TimelineDocument {
  const graphic = graphicAt(doc, elementId);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (graphic == null || trimmed === "" || graphic.name === trimmed) {
    return doc;
  }
  return write(doc, elementId, { ...graphic, name: trimmed });
}
