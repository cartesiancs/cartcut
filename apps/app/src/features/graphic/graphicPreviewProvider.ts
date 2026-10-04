/**
 * Preview frames for graphic preset tiles.
 *
 * The provider shape `fx/fxPreviewProvider.ts` states (synchronous `get`,
 * fire-and-forget deduped `request`), with a different renderer behind it: a
 * graphic is drawn by the real pipeline, a throwaway clip in a one-clip map
 * prepared and composited as an export composites a frame, over the same
 * sample picture the effect tiles use. A tile therefore shows the preset's
 * actual lettering, in its default font, at a moment of its own animation.
 *
 * One instance id for every tile, so the host keeps a single mount for them:
 * hovering one preset re-applies that mount step after step, and moving to the
 * next replaces it. Renders run one at a time and stand aside while an export
 * holds the host.
 */

import type { Timeline } from "../../@types/timeline";
import { createGraphicElement, DEFAULT_GRAPHIC_MS } from "../element/graphicElement";
import { exportElementRenderers } from "../export/renderers";
import { preloadForComposite } from "../export/compositePrep";
import {
  PREVIEW_H,
  PREVIEW_W,
  progressForStep,
  type FxPreviewProvider,
  type FxPreviewRequest,
} from "../fx/fxPreviewProvider";
import { presetById } from "../fx/presetRegistry";
import { defaultParamsOf, type FxHtmlRender, type FxPreset } from "../fx/presetTypes";
import { sampleFrameCanvas } from "../fx/sampleFrames";
import { GraphicGl } from "../renderer/graphicGl";
import { renderTimelineAtTime } from "../renderer/timeline";
import { createTileCache } from "../timeline/strip/cache";
import { prepareScopeFrame } from "./graphicPipeline";
import { previewMayPrepare } from "./graphicQueue";
import { createGraphicScope, withGraphicScope, type GraphicScope } from "./graphicScope";

/** The frame a tile is composed in, three times the tile so lettering is resolved before it is shrunk. */
const FRAME_W = PREVIEW_W * 3;
const FRAME_H = PREVIEW_H * 3;
const MAX_TILES = 200;
const MAX_PENDING = 12;
const TILE_ID = "preset-tile";

/** Where a preset sits in the tile frame: its design aspect, as large as fits with a margin. */
export function tileBoxOf(
  preset: FxPreset,
  frame: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const design = preset.render.type === "html" ? (preset.render as FxHtmlRender).designSize : undefined;
  if (design == null || !(design.width > 0) || !(design.height > 0)) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }
  const scale = Math.min((frame.width * 0.92) / design.width, (frame.height * 0.8) / design.height);
  const width = Math.round(design.width * scale);
  const height = Math.round(design.height * scale);
  return {
    x: Math.round((frame.width - width) / 2),
    y: Math.round((frame.height - height) / 2),
    width,
    height,
  };
}

export function createGraphicPreviewProvider(fps = 30): FxPreviewProvider {
  const cache = createTileCache<ImageBitmap>({ maxTiles: MAX_TILES });
  const pending: FxPreviewRequest[] = [];
  const queued = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();
  let scope: GraphicScope | null = null;
  let frame: HTMLCanvasElement | null = null;
  let target: HTMLCanvasElement | null = null;
  let working = false;
  let disposed = false;
  let readyHandle = 0;

  function notifyReady(): void {
    if (readyHandle !== 0 || disposed) {
      return;
    }
    readyHandle = requestAnimationFrame(() => {
      readyHandle = 0;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("graphic preview: listener failed", error);
        }
      }
    });
  }

  function ensure(): boolean {
    if (scope != null) {
      return true;
    }
    if (disposed || typeof document === "undefined") {
      return false;
    }
    frame = document.createElement("canvas");
    frame.width = FRAME_W;
    frame.height = FRAME_H;
    target = document.createElement("canvas");
    target.width = PREVIEW_W;
    target.height = PREVIEW_H;
    scope = createGraphicScope("preset-tiles", new GraphicGl({ blocking: true }), fps);
    return true;
  }

  async function render(request: FxPreviewRequest): Promise<"done" | "later"> {
    const preset = presetById(request.presetId);
    if (preset == null || preset.kind !== "graphic" || !ensure() || scope == null) {
      failed.add(request.key);
      return "done";
    }
    const html = preset.render.type === "html";
    if (html && !previewMayPrepare()) {
      return "later";
    }
    const box = tileBoxOf(preset, { width: FRAME_W, height: FRAME_H });
    const element = createGraphicElement({
      presetId: preset.id,
      params: defaultParamsOf(preset),
      name: preset.name,
      startTime: 0,
      duration: DEFAULT_GRAPHIC_MS,
      ...box,
    });
    const timeline: Timeline = { [TILE_ID]: { ...element, trackId: TILE_ID, priority: 1 } };
    const t = Math.min(DEFAULT_GRAPHIC_MS - 1, Math.round(progressForStep(request.step) * DEFAULT_GRAPHIC_MS));

    await preloadForComposite(timeline);
    if (html && !(await prepareScopeFrame(scope, timeline, t))) {
      // The window did not paint (minimised): try again when asked again.
      return "later";
    }
    const frameCtx = frame?.getContext("2d");
    const targetCtx = target?.getContext("2d");
    if (frame == null || target == null || frameCtx == null || targetCtx == null) {
      failed.add(request.key);
      return "done";
    }
    frameCtx.setTransform(1, 0, 0, 1, 0, 0);
    frameCtx.clearRect(0, 0, FRAME_W, FRAME_H);
    const sample = sampleFrameCanvas("a", FRAME_W, FRAME_H);
    if (sample != null) {
      frameCtx.drawImage(sample, 0, 0, FRAME_W, FRAME_H);
    }
    const active = scope;
    withGraphicScope(active, () =>
      renderTimelineAtTime(
        frameCtx,
        timeline,
        t,
        exportElementRenderers,
        "rgba(0, 0, 0, 0)",
        FRAME_W,
        FRAME_H,
        undefined,
        undefined,
        null,
      ),
    );
    targetCtx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    targetCtx.drawImage(frame, 0, 0, PREVIEW_W, PREVIEW_H);
    try {
      const bitmap = await createImageBitmap(target);
      if (disposed) {
        bitmap.close();
        return "done";
      }
      cache.set(request.key, bitmap);
      notifyReady();
    } catch {
      failed.add(request.key);
    }
    return "done";
  }

  async function pump(): Promise<void> {
    if (working || disposed) {
      return;
    }
    working = true;
    try {
      while (pending.length > 0 && !disposed) {
        const request = pending.shift()!;
        queued.delete(request.key);
        if (cache.has(request.key)) {
          continue;
        }
        try {
          if ((await render(request)) === "later") {
            // Dropped rather than retried in a loop: the next paint of the
            // panel asks again, and by then the export may be over.
            break;
          }
        } catch (error) {
          console.warn("graphic preview: render failed", error);
          failed.add(request.key);
        }
      }
    } finally {
      working = false;
    }
  }

  return {
    get(key) {
      return cache.get(key);
    },

    request(raw) {
      const request = raw as unknown as FxPreviewRequest;
      if (
        disposed ||
        request.key == null ||
        cache.has(request.key) ||
        queued.has(request.key) ||
        failed.has(request.key)
      ) {
        return;
      }
      queued.add(request.key);
      pending.push(request);
      while (pending.length > MAX_PENDING) {
        const dropped = pending.shift();
        if (dropped != null) {
          queued.delete(dropped.key);
        }
      }
      void pump();
    },

    onReady(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    dispose() {
      disposed = true;
      if (readyHandle !== 0) {
        cancelAnimationFrame(readyHandle);
        readyHandle = 0;
      }
      listeners.clear();
      pending.length = 0;
      queued.clear();
      cache.clear();
      scope?.gl?.dispose();
      scope = null;
      frame = null;
      target = null;
    },

    get cachedTiles() {
      return cache.size;
    },
    get pendingTiles() {
      return pending.length;
    },
  };
}
