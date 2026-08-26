/**
 * Assembling an `FxRuntime` for the preview and for export.
 *
 * The two differ in exactly two ways, and this is the one place that says so:
 * export blocks on the GPU because it reads the canvas back with
 * `getImageData` immediately afterwards, and export positions overlays exactly
 * rather than letting them roll. Everything else — the compositor, the preset
 * lookup, the overlay store — is shared, which is what keeps the preview an
 * honest preview.
 *
 * Its own WebGL context, not `loadedAssetStore.videoFilterCanvasCtx`. See
 * `compositor.ts` for why sharing that one cannot work.
 */

import type { EffectElementType } from "../../../@types/timeline";
import { presetById } from "../../fx/presetRegistry";
import type { FxPreset } from "../../fx/presetTypes";
import { FxCompositor } from "./compositor";
import { overlayFrame } from "./overlaySource";
import type { PresetMode } from "./planFrame";
import type { FxRuntime } from "./runtime";

/**
 * How a preset runs, or `null` when it is not installed.
 *
 * The missing-preset path everything else defers to: `planFrame` drops the
 * element from the frame entirely, so a transition degrades to the cut it was
 * before anyone added one and an effect simply does not apply. The element and
 * its parameters are untouched in the document, so saving loses nothing.
 */
export function modeOfPreset(presetId: string): PresetMode | null {
  const preset = presetById(presetId);
  if (preset == null) {
    return null;
  }
  return preset.render.type === "overlay" ? "overlay" : "shader";
}

let previewGl: WebGLRenderingContext | null = null;

/**
 * The WebGL context the preview's compositor uses, created once.
 *
 * `preserveDrawingBuffer` because the result is read back with `drawImage`
 * after the draw call rather than during it, which is the same reason
 * `loadedAssetStore` sets it on its own context.
 */
function previewContext(): WebGLRenderingContext | null {
  if (previewGl != null) {
    return previewGl;
  }
  try {
    const canvas = document.createElement("canvas");
    previewGl = canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null;
  } catch {
    previewGl = null;
  }
  return previewGl;
}

function runtimeWith(
  gl: WebGLRenderingContext,
  fps: number,
  blocking: boolean,
  playing: boolean,
  compositor?: FxCompositor,
): FxRuntime {
  return {
    compositor: compositor ?? new FxCompositor(gl, { blocking }),
    fps,
    modeOf: modeOfPreset,
    presetOf: (presetId: string): FxPreset | null => presetById(presetId),
    overlayFrameFor: (
      elementId: string,
      element: EffectElementType,
      timeInMs: number,
    ) => {
      const preset = presetById(element.presetId);
      if (preset == null) {
        return null;
      }
      return overlayFrame(elementId, element, preset, timeInMs, playing);
    },
  };
}

let previewCompositor: FxCompositor | null = null;

/**
 * The preview's runtime, reusing one compositor across frames.
 *
 * Rebuilding it per frame would recompile every preset's shader and reallocate
 * every render target sixty times a second. `playing` is passed through rather
 * than captured because it changes between calls and only affects how overlays
 * are positioned.
 *
 * Returns `null` where there is no WebGL — a headless window, a lost context —
 * and `renderTimelineAtTime` then takes its original path, drawing everything
 * except effects and transitions.
 */
export function previewFxRuntime(
  fps: number,
  playing: boolean,
): FxRuntime | null {
  const gl = previewContext();
  if (gl == null) {
    return null;
  }
  if (previewCompositor == null) {
    previewCompositor = new FxCompositor(gl, { blocking: false });
  }
  return runtimeWith(gl, fps, false, playing, previewCompositor);
}

/**
 * A runtime for one export, with its own context and compositor.
 *
 * Not shared with the preview: export blocks on the GPU, and it runs while the
 * preview may still be painting. `dispose` on the returned compositor is the
 * caller's job — `renderTimeline` does it in a `finally`.
 */
export function createExportFxRuntime(fps: number): FxRuntime | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl == null) {
    return null;
  }
  // Overlays are positioned exactly during export: the frame loop samples one
  // instant at a time and must be reproducible, so nothing is left rolling.
  return runtimeWith(gl, fps, true, false);
}
