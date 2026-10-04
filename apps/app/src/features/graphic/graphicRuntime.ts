/**
 * The preview's half of the graphic renderer: what `App.ts` installs.
 *
 * Its own module so the store and the registry stay out of
 * `renderer/graphic.ts`, which is drawn under `environment: "node"` against a
 * runtime a test builds. An export does not use this: it opens a
 * `GraphicScope` with its own blocking generator.
 */

import { normalizeFps } from "../timeline/frames";
import { resolvePreset } from "../fx/resolvePreset";
import { GraphicGl } from "../renderer/graphicGl";
import { installGraphicRuntime } from "../renderer/graphic";
import { renderOptionStore } from "../../states/renderOptionStore";
import { previewRasters } from "./previewRasters";

let previewGl: GraphicGl | null = null;

export function installPreviewGraphicRuntime(): void {
  installGraphicRuntime({
    presetOf: (element) => resolvePreset(element),
    previewGl: () => {
      if (previewGl == null) {
        previewGl = new GraphicGl({ blocking: false });
      }
      return previewGl;
    },
    fps: () => normalizeFps(renderOptionStore.getState().options?.fps),
    latestHtmlRaster: (elementId) => previewRasters.latest(elementId),
    noteDrawScale: (elementId, scale) => previewRasters.noteScale(elementId, scale),
  });
}
