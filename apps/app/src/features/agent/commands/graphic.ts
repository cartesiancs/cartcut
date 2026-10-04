/**
 * Graphics: layers whose picture is a program.
 *
 * One command places one, from an installed preset or from a program the agent
 * wrote, and one changes it. Both take the same `program` shape as the fx
 * commands and go through `programInput.requireProgram`, so a graphic that
 * would not draw is refused with every reason rather than placed blank.
 */

import { v4 as uuidv4 } from "uuid";
import type { FxParams, GraphicElementType } from "../../../@types/timeline";
import { DEFAULT_GRAPHIC_MS } from "../../element/graphicElement";
import { defaultParamsOf, type FxPreset } from "../../fx/presetTypes";
import { presetById } from "../../fx/presetRegistry";
import {
  addGraphic,
  setGraphicName,
  setGraphicParams,
  setGraphicPreset,
  setGraphicProgram,
} from "../../timeline/graphicOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { graphicTwinOf, textToGraphic, type TypographyTarget } from "../../timeline/typographyOps";
import { bundledFonts, loadFontLibrary } from "../../font/fontLibrary";
import { fontValueOfPath } from "../../graphic/fontParams";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { commit } from "../commit";
import { currentDoc, onFrame, requireElement, requireTrack } from "../context";
import { requireProgram } from "../programInput";
import { defaultBox, trackKindFor } from "../../graphic/graphicPlacement";
import { registerCommands } from "../registry";

type Box = { x?: number; y?: number; width?: number; height?: number };

function projectSize(): { w: number; h: number } {
  const size = renderOptionStore.getState().options?.previewSize;
  return { w: size?.w ?? 1920, h: size?.h ?? 1080 };
}

function installedGraphic(presetId: string): FxPreset {
  const preset = presetById(presetId);
  if (preset == null) {
    throw new Error(
      `No graphic preset "${presetId}" is installed. list_graphic_presets has them, or pass a \`program\`.`,
    );
  }
  if (preset.kind !== "graphic") {
    throw new Error(`"${presetId}" is a ${preset.kind} preset, not a graphic.`);
  }
  return preset;
}

function requireGraphic(doc: TimelineDocument, elementId: string): GraphicElementType {
  const element = requireElement(doc, elementId) as any;
  if (element.filetype !== "graphic") {
    throw new Error(`Clip "${elementId}" is a ${element.filetype} clip, not a graphic.`);
  }
  return element;
}

function withWarnings(result: unknown, warnings: unknown[]): unknown {
  if (warnings.length === 0 || result == null || typeof result !== "object") {
    return result;
  }
  return { ...(result as Record<string, unknown>), warnings };
}

/** The program a text clip becomes, refused when it has nothing to put the text in. */
function typographyTarget(params: {
  presetId?: string;
  program?: unknown;
  params?: Record<string, unknown>;
}): { target: TypographyTarget; warnings: unknown[] } {
  if (params.program != null && params.presetId) {
    throw new Error("Pass either `presetId` or `program`, not both.");
  }
  if (params.program == null && !params.presetId) {
    throw new Error("apply_typography needs a `presetId` or a `program`.");
  }
  const inline =
    params.program != null ? requireProgram(params.program, "graphic", undefined) : null;
  const preset = inline?.preset ?? installedGraphic(params.presetId as string);
  if (preset.render.type !== "html") {
    throw new Error(
      `"${preset.id}" is drawn by a shader and has no text to receive. Pick an HTML graphic.`,
    );
  }
  return {
    target: {
      preset,
      program: inline?.program,
      overrides: (params.params ?? {}) as FxParams,
    },
    warnings: inline?.warnings ?? [],
  };
}

registerCommands({
  apply_typography: async (params: {
    clipIds: string[];
    presetId?: string;
    program?: unknown;
    params?: Record<string, unknown>;
  }) => {
    const ids = [...new Set(params.clipIds ?? [])];
    if (ids.length === 0) {
      throw new Error("apply_typography needs at least one clip id.");
    }
    const { target, warnings } = typographyTarget(params);
    const doc = currentDoc();
    for (const id of ids) {
      const element = requireElement(doc, id) as any;
      if (element.filetype !== "text") {
        throw new Error(`Clip "${id}" is a ${element.filetype} clip; only text clips convert.`);
      }
    }
    // The bundled list is what turns a font path into a portable `bundled:`
    // value, and it arrives over IPC.
    await loadFontLibrary();
    const bundled = bundledFonts();
    const fontValueOf = (path: string) => fontValueOfPath(path, bundled);

    const converted = ids.map((id) => ({
      id,
      dropped: graphicTwinOf(currentDoc().elements[id] as any, target, fontValueOf).dropped,
    }));
    const result = commit(
      (d: TimelineDocument) => textToGraphic(d, ids, target, fontValueOf),
      "None of those clips could be converted.",
    );
    return withWarnings({ ...result, converted }, warnings);
  },

  add_graphic: (params: {
    presetId?: string;
    program?: unknown;
    params?: Record<string, unknown>;
    name?: string;
    startMs: number;
    durationMs?: number;
    trackId?: string;
  } & Box) => {
    const doc = currentDoc();
    if (params.program != null && params.presetId) {
      throw new Error("Pass either `presetId` or `program`, not both.");
    }
    if (params.program == null && !params.presetId) {
      throw new Error("add_graphic needs a `presetId` or a `program`.");
    }
    const inline =
      params.program != null
        ? requireProgram(params.program, "graphic", params.params)
        : null;
    const preset = inline?.preset ?? installedGraphic(params.presetId as string);
    const values: FxParams =
      inline?.params ?? { ...defaultParamsOf(preset), ...((params.params ?? {}) as FxParams) };
    if (params.trackId != null) {
      requireTrack(doc, params.trackId);
    }

    const box = defaultBox(preset, params, projectSize());
    const elementId = uuidv4();
    const result = commit(
      (d: TimelineDocument) =>
        addGraphic(d, elementId, uuidv4(), {
          presetId: inline == null ? preset.id : undefined,
          program: inline?.program,
          params: values,
          name: (params.name ?? "").trim() || preset.name,
          startMs: onFrame(Math.max(0, params.startMs)),
          durationMs: params.durationMs ?? DEFAULT_GRAPHIC_MS,
          ...box,
          preferredTrackId: params.trackId,
          trackKind: trackKindFor(preset),
        }),
      "The graphic could not be placed: it needs a positive length and a box.",
    );
    return withWarnings(result, inline?.warnings ?? []);
  },

  set_graphic: (params: {
    elementId: string;
    presetId?: string;
    program?: unknown;
    params?: Record<string, unknown>;
    name?: string;
  }) => {
    const doc = currentDoc();
    requireGraphic(doc, params.elementId);
    if (params.program != null && params.presetId != null) {
      throw new Error("Pass either `presetId` or `program`, not both.");
    }
    const inline =
      params.program != null
        ? requireProgram(params.program, "graphic", params.params)
        : null;
    const installed =
      inline == null && params.presetId != null ? installedGraphic(params.presetId) : null;

    const result = commit((d: TimelineDocument) => {
      let next = d;
      if (inline != null) {
        next = setGraphicProgram(next, params.elementId, inline.program, inline.params);
      } else if (installed != null) {
        next = setGraphicPreset(next, params.elementId, installed.id, {
          ...defaultParamsOf(installed),
          ...((params.params ?? {}) as FxParams),
        });
      } else if (params.params != null) {
        next = setGraphicParams(next, params.elementId, params.params as FxParams);
      }
      if (params.name != null) {
        next = setGraphicName(next, params.elementId, params.name);
      }
      return next;
    }, "Nothing about that graphic changed.");
    return withWarnings(result, inline?.warnings ?? []);
  },
});
