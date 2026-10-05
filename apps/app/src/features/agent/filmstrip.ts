/**
 * A graphic drawn alone at a few moments, side by side: what `check_program`
 * shows an agent so it can see its typography move before placing it.
 *
 * Built on the real pipeline rather than a shortcut: a throwaway graphic
 * element in a one-clip map, prepared and composited exactly as an export
 * composites a frame, so what the strip shows is what the clip will look like.
 * Drawn over a checkerboard, because a title is mostly transparency and black
 * on black would hide every mistake in it.
 */

import type { FxParams, InlineProgram, Timeline } from "../../@types/timeline";
import { createGraphicElement, DEFAULT_GRAPHIC_MS } from "../element/graphicElement";
import { exportElementRenderers } from "../export/renderers";
import { preloadForComposite } from "../export/compositePrep";
import { defaultParamsOf, type FxHtmlRender, type FxPreset } from "../fx/presetTypes";
import { prepareScopeFrame, releaseScopeGraphics } from "../graphic/graphicPipeline";
import { beginExportGraphics, endExportGraphics } from "../graphic/graphicQueue";
import { createGraphicScope, withGraphicScope } from "../graphic/graphicScope";
import { GraphicGl } from "../renderer/graphicGl";
import { renderTimelineAtTime } from "../renderer/timeline";
import { renderOptionStore } from "../../states/renderOptionStore";
import { normalizeFps } from "../timeline/frames";

const MAX_TILE_WIDTH = 480;
const LABEL_HEIGHT = 22;

export async function renderFilmstrip(
  program: InlineProgram,
  preset: FxPreset,
  options: {
    times: number[];
    durationMs?: number;
    box?: { width: number; height: number };
    params?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const design = (preset.render as FxHtmlRender).designSize;
  const width = Math.round(options.box?.width ?? design?.width ?? 1280);
  const height = Math.round(options.box?.height ?? design?.height ?? 720);
  const durationMs = Math.max(1, options.durationMs ?? DEFAULT_GRAPHIC_MS);
  const fps = normalizeFps(renderOptionStore.getState().options?.fps);

  const element = createGraphicElement({
    program,
    params: { ...defaultParamsOf(preset), ...((options.params ?? {}) as FxParams) },
    name: preset.name,
    startTime: 0,
    duration: durationMs,
    width,
    height,
  });
  const timeline: Timeline = {
    filmstrip: { ...element, trackId: "filmstrip", priority: 1 },
  };

  await preloadForComposite(timeline);

  const frame = document.createElement("canvas");
  frame.width = width;
  frame.height = height;
  const frameCtx = frame.getContext("2d");

  const tileWidth = Math.min(MAX_TILE_WIDTH, width);
  const tileHeight = Math.max(1, Math.round((tileWidth * height) / width));
  const strip = document.createElement("canvas");
  strip.width = tileWidth * options.times.length;
  strip.height = tileHeight + LABEL_HEIGHT;
  const stripCtx = strip.getContext("2d");
  if (frameCtx == null || stripCtx == null) {
    throw new Error("Could not create a canvas to draw the filmstrip on.");
  }

  const scope = createGraphicScope("filmstrip:" + Date.now(), new GraphicGl({ blocking: true }), fps);
  const html = preset.render.type === "html";
  if (html) {
    beginExportGraphics();
  }
  let painted = true;
  try {
    options.times.forEach((_, index) => {
      // A checkerboard behind each tile, so transparency reads as transparency.
      const x0 = index * tileWidth;
      const cell = 12;
      for (let y = 0; y < tileHeight; y += cell) {
        for (let x = 0; x < tileWidth; x += cell) {
          stripCtx.fillStyle = ((x + y) / cell) % 2 === 0 ? "#2a2a2a" : "#3a3a3a";
          stripCtx.fillRect(x0 + x, y, cell, cell);
        }
      }
    });
    for (let index = 0; index < options.times.length; index += 1) {
      const t = Math.max(0, Math.min(durationMs - 1, Math.round(options.times[index])));
      if (html) {
        painted = (await prepareScopeFrame(scope, timeline, t)) && painted;
      }
      frameCtx.clearRect(0, 0, width, height);
      withGraphicScope(scope, () =>
        renderTimelineAtTime(
          frameCtx,
          timeline,
          t,
          exportElementRenderers,
          "rgba(0, 0, 0, 0)",
          width,
          height,
          undefined,
          undefined,
          null,
        ),
      );
      const x = index * tileWidth;
      stripCtx.drawImage(frame, x, 0, tileWidth, tileHeight);
      stripCtx.fillStyle = "#000000";
      stripCtx.fillRect(x, tileHeight, tileWidth, LABEL_HEIGHT);
      stripCtx.fillStyle = "#ffffff";
      stripCtx.font = "12px monospace";
      stripCtx.textBaseline = "middle";
      stripCtx.fillText(`${t}ms`, x + 6, tileHeight + LABEL_HEIGHT / 2);
    }
  } finally {
    scope.gl?.dispose();
    // The throwaway clip's DOM goes with its scope's host; it is in no
    // document to be released by the preview's sweep.
    releaseScopeGraphics(scope);
    if (html) {
      endExportGraphics();
    }
  }

  const dataUrl = strip.toDataURL("image/png");
  return {
    filmstrip: {
      pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      atMs: options.times,
      box: { width, height },
      ...(painted ? {} : { warning: "The window did not paint in time; some tiles may be empty." }),
    },
  };
}
