/**
 * The HTML graphic pipeline, wired to the app: the registry, the template
 * resolver, the font library and the host.
 *
 * Three callers, one sequence (plan, then prepare, then the synchronous
 * composite draws what was prepared):
 *
 *  - the preview, fire and forget: it asks for this frame's rasters and
 *    repaints when they land, drawing the latest ones meanwhile
 *    (`previewSession.ts`);
 *  - an export and the contact sheet, awaited per frame, into a scope of
 *    their own so the composite draws exactly this frame's rasters.
 *
 * **Every caller prepares on a host of its own.** A raster is the host mount's
 * own canvas, and the preview keeps drawing it; on a shared host an export or a
 * contact sheet redrew it at their own moment and scale while the preview's key
 * still called it current, and the paused preview showed the wrong frame (often
 * an empty outro) until the playhead moved. A scope's host is made on its first
 * prepare and must be released with `releaseScopeGraphics`.
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
import { previewMayPrepare, serialize, whenPreviewMayPrepare } from "./graphicQueue";
import { HtmlHost, previewHtmlHost } from "./htmlHost";
import type { HtmlRasterPort } from "./htmlRasterPort";
import { mountSpecOf } from "./mountSpec";
import {
  graphicInstanceIds,
  hasHtmlGraphics,
  planGraphics,
  planLookahead,
  type PlanInput,
} from "./planGraphics";
import { prepareGraphics, type PrepareDeps } from "./prepare";
import { previewRasters } from "./previewRasters";
import { PreviewRasterSession } from "./previewSession";

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

function depsFor(port: HtmlRasterPort): PrepareDeps {
  return { port, mountOf, fontsOf };
}

const mountOf: PrepareDeps["mountOf"] = (job) => mountSpecOf(job.preset);

const fontsOf: PrepareDeps["fontsOf"] = (job) => {
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
};

/** Whether this document has anything for the host to do, inside a template included. */
export function needsHtmlHost(elements: Timeline): boolean {
  return hasHtmlGraphics(elements, (element) => resolvePreset(element), templateCompositionAt);
}

const previewDeps = depsFor(previewHtmlHost());

/** Each scope's own host, made on its first prepare. */
const scopeHosts = new WeakMap<GraphicScope, HtmlHost>();

function hostOf(scope: GraphicScope): HtmlHost {
  let host = scopeHosts.get(scope);
  if (host == null) {
    host = new HtmlHost();
    scopeHosts.set(scope, host);
  }
  return host;
}

/**
 * One frame's rasters, into `scope`, awaited. For an export and the contact
 * sheet. Returns `false` when the host could not paint (a minimised window with
 * throttling on), which an export must report rather than ship blank graphics.
 *
 * `queued: false` runs it beside the queue rather than in it, for the preset
 * tiles: a tile waiting on its own font's first load held the queue, and a
 * playing preview's prepares stood behind it for the whole wait.
 */
export async function prepareScopeFrame(
  scope: GraphicScope,
  elements: Timeline,
  timeInMs: number,
  { queued = true }: { queued?: boolean } = {},
): Promise<boolean> {
  await loadFontLibrary();
  const jobs = planGraphics(planInput(elements, timeInMs, scope.fps, () => 1));
  scope.rasters.clear();
  if (jobs.length === 0) {
    return true;
  }
  const keys = new Map<string, string | null>();
  const deps = depsFor(hostOf(scope));
  const prepare = () =>
    prepareGraphics(deps, jobs, {
      keyOf: (id) => keys.get(id) ?? null,
      put: (id, key, raster) => {
        keys.set(id, key);
        scope.rasters.set(id, raster);
      },
    });
  const result = await (queued ? serialize(prepare) : prepare());
  return result.painted;
}

/**
 * Unmount everything `scope` mounted. Every caller of `prepareScopeFrame` calls
 * this when it is done: the mounts are canvases in the document, so a scope
 * dropped without it leaves them there.
 */
export function releaseScopeGraphics(scope: GraphicScope): void {
  const host = scopeHosts.get(scope);
  if (host != null) {
    host.release(new Set());
    scopeHosts.delete(scope);
  }
}

const session = new PreviewRasterSession(
  {
    plan: (request, scaleOf) => {
      const input = planInput(request.elements, request.cursor, request.fps, scaleOf);
      const current = planGraphics(input);
      return { current, ahead: planLookahead(input, current) };
    },
    prepare: (jobs, sink) =>
      loadFontLibrary().then(() => serialize(() => prepareGraphics(previewDeps, jobs, sink))),
    mayPrepare: previewMayPrepare,
    whenMayPrepare: whenPreviewMayPrepare,
    releaseMounts: (live) => previewHtmlHost().release(live),
    warn: (message, error) => console.warn(message, error),
  },
  previewRasters,
);

/**
 * Ask for the preview's rasters at a cursor. Never waits: the preview draws
 * the latest rasters it has, and `onReady` is called (to repaint) when new ones
 * land. The graphics about to appear are prepared too, so their first frame
 * is ready when the playhead reaches them.
 */
export function requestPreviewRasters(
  elements: Timeline,
  cursor: number,
  fps: number,
  onReady: () => void,
  playing = false,
): void {
  session.request({ elements, cursor, fps, playing }, onReady);
}

/** Forget and unmount every graphic no longer in the document, template contents included. */
export function releaseGraphicsNotIn(elements: Timeline): void {
  session.retain(graphicInstanceIds(elements, templateCompositionAt));
}
