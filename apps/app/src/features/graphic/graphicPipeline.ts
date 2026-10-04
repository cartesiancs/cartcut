/**
 * The HTML graphic pipeline, wired to the app: the registry, the template
 * resolver, the font library and the host.
 *
 * Three callers, one sequence (plan, then prepare, then the synchronous
 * composite draws what was prepared):
 *
 *  - the preview, fire and forget: it asks for this frame's rasters and
 *    repaints when they land, drawing the latest ones meanwhile;
 *  - an export and the contact sheet, awaited per frame, into a scope of
 *    their own so the composite draws exactly this frame's rasters.
 *
 * Everything that decides anything is in the pure modules beside this; this
 * file only supplies them with the app.
 */

import type { GraphicElementType, Timeline } from "../../@types/timeline";
import { bundledPath, loadFontLibrary } from "../font/fontLibrary";
import type { FontEntry } from "../font/fontFaces";
import { DEFAULT_FONT } from "../font/fontFaces";
import { resolvePreset } from "../fx/resolvePreset";
import { templateCompositionAt } from "../renderer/template";
import { fileUrlOf } from "./fileUrl";
import { cssFamilyOf, fontEntryFor } from "./fontParams";
import type { GraphicScope } from "./graphicScope";
import { previewMayPrepare, serialize } from "./graphicQueue";
import { sharedHtmlHost } from "./htmlHost";
import { mountSpecOf } from "./mountSpec";
import { planGraphics, type GraphicJob, type PlanInput } from "./planGraphics";
import { prepareGraphics, type PrepareDeps } from "./prepare";
import { previewRasters } from "./previewRasters";

/** Bumped whenever a font finishes loading, so a raster drawn in the fallback face is redrawn. */
let fontGeneration = 0;
let listening = false;

function listenForFonts(): void {
  if (listening || typeof document === "undefined" || document.fonts == null) {
    return;
  }
  listening = true;
  document.fonts.addEventListener("loadingdone", () => {
    fontGeneration += 1;
  });
}

/** `asset:<name>` in a parameter value, against the preset's own files. */
function assetPathOf(element: GraphicElementType, value: string): string | null {
  if (!value.startsWith("asset:")) {
    return null;
  }
  const preset = resolvePreset(element);
  return preset?.assets?.[value.slice(6)] ?? null;
}

function fontOf(element: GraphicElementType, value: string): FontEntry {
  const asset = assetPathOf(element, value);
  return fontEntryFor(asset ?? value, bundledPath);
}

function planInput(
  elements: Timeline,
  timeInMs: number,
  fps: number,
  scaleOf: (instanceId: string) => number,
): PlanInput {
  listenForFonts();
  return {
    elements,
    timeInMs,
    fps,
    presetOf: (element) => resolvePreset(element),
    expandTemplate: templateCompositionAt,
    scaleOf,
    resolvers: {
      // The element is not known here; `asset:` font values are resolved in
      // `fontsOf` for loading, and a family name is the file stem either way.
      fontFamilyOf: (value) => cssFamilyOf(fontEntryFor(value, bundledPath)),
      imageUrlOf: (path) => (path === "" ? null : fileUrlOf(path)),
    },
    fontGeneration,
  };
}

const deps: PrepareDeps = {
  port: sharedHtmlHost(),
  mountOf: (job) => mountSpecOf(job.preset),
  fontsOf: (job) => {
    const out: FontEntry[] = [];
    for (const param of job.preset.params) {
      if (param.type !== "font") {
        continue;
      }
      const stored = job.element.params?.[param.key];
      const entry = fontOf(job.element, typeof stored === "string" ? stored : param.default);
      if (entry.name !== DEFAULT_FONT.name) {
        out.push(entry);
      }
    }
    return out;
  },
};

/** Whether this document has anything for the host to do. */
export function needsHtmlHost(elements: Timeline): boolean {
  for (const element of Object.values(elements)) {
    if (element?.filetype === "graphic") {
      const preset = resolvePreset(element as GraphicElementType);
      if (preset?.render.type === "html") {
        return true;
      }
    }
  }
  return false;
}

/**
 * One frame's rasters, into `scope`, awaited. For an export and the contact
 * sheet. Returns `false` when the host could not paint (a minimised window with
 * throttling on), which an export must report rather than ship blank graphics.
 */
export async function prepareScopeFrame(
  scope: GraphicScope,
  elements: Timeline,
  timeInMs: number,
): Promise<boolean> {
  await loadFontLibrary();
  const jobs = planGraphics(planInput(elements, timeInMs, scope.fps, () => 1));
  scope.rasters.clear();
  if (jobs.length === 0) {
    return true;
  }
  const keys = new Map<string, string>();
  const result = await serialize(() =>
    prepareGraphics(deps, jobs, {
      keyOf: (id) => keys.get(id) ?? null,
      put: (id, key, raster) => {
        keys.set(id, key);
        scope.rasters.set(id, raster);
      },
    }),
  );
  return result.painted;
}

let previewBusy = false;
let previewAgain: (() => void) | null = null;

/**
 * Ask for the preview's rasters at a cursor. Never waits: the preview draws
 * the latest rasters it has, and `onReady` is called (to repaint) when new ones
 * land. Calls while one is running are folded into one more run after it.
 */
export function requestPreviewRasters(
  elements: Timeline,
  cursor: number,
  fps: number,
  onReady: () => void,
): void {
  if (!previewMayPrepare()) {
    return;
  }
  const run = () => {
    const jobs: GraphicJob[] = planGraphics(
      planInput(elements, cursor, fps, (id) => previewRasters.scaleOf(id)),
    );
    if (jobs.every((job) => previewRasters.keyOf(job.instanceId) === job.key)) {
      return null;
    }
    return jobs;
  };
  if (previewBusy) {
    previewAgain = () => requestPreviewRasters(elements, cursor, fps, onReady);
    return;
  }
  const jobs = run();
  if (jobs == null) {
    return;
  }
  previewBusy = true;
  void loadFontLibrary()
    .then(() =>
      serialize(() =>
        prepareGraphics(deps, jobs, {
          keyOf: (id) => previewRasters.keyOf(id),
          put: (id, key, raster) => previewRasters.put(id, key, raster),
        }),
      ),
    )
    .then((result) => {
      if (result.drawn > 0) {
        onReady();
      }
    })
    .catch((error) => console.warn("graphic: preview prepare failed", error))
    .finally(() => {
      previewBusy = false;
      const again = previewAgain;
      previewAgain = null;
      again?.();
    });
}

/** Unmount every graphic no longer in the document. */
export function releaseGraphicsNotIn(elements: Timeline): void {
  const live = new Set<string>();
  for (const [id, element] of Object.entries(elements)) {
    if (element?.filetype === "graphic") {
      live.add(id);
    }
  }
  previewRasters.retain(live);
  if (live.size === 0) {
    sharedHtmlHost().release(live);
  }
}
