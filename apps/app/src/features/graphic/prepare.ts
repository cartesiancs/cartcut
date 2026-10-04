/**
 * Making the HTML rasters a frame needs, before the synchronous composite.
 *
 * Chromium paints a change to the DOM on its next `paint` event and not before
 * (measured: a style change is invisible to `drawElementImage` after a forced
 * layout and inside the next animation frame). So this is an async step, and it
 * runs ahead of the composite rather than inside it:
 *
 *   mount every graphic -> apply every state -> one settle -> rasterize each
 *
 * One paint serves every graphic on the frame (measured too), which is why the
 * applies are batched before a single settle rather than paired with one each.
 *
 * Jobs whose raster is already current, by key, are skipped; a static graphic
 * costs nothing after its first frame. Serialised through `graphicQueue.ts`
 * with every other caller of the host.
 */

import type { FontEntry } from "../font/fontFaces";
import type { HtmlRasterPort } from "./htmlRasterPort";
import type { GraphicJob } from "./planGraphics";
import type { BuiltMount } from "./mountSpec";

export type RasterSink = {
  keyOf: (instanceId: string) => string | null;
  put: (instanceId: string, key: string, raster: CanvasImageSource) => void;
};

export type PrepareDeps = {
  port: HtmlRasterPort;
  mountOf: (job: GraphicJob) => BuiltMount | null;
  fontsOf: (job: GraphicJob) => FontEntry[];
};

export type PrepareResult = {
  /** Rasters drawn this call. */
  drawn: number;
  /** Jobs that needed nothing. */
  current: number;
  /** `false` when the paint did not come: a minimised, throttled window. */
  painted: boolean;
};

export async function prepareGraphics(
  deps: PrepareDeps,
  jobs: GraphicJob[],
  sink: RasterSink,
): Promise<PrepareResult> {
  const { port } = deps;
  if (!port.supported()) {
    return { drawn: 0, current: 0, painted: true };
  }

  const stale: Array<{ job: GraphicJob }> = [];
  let current = 0;
  for (const job of jobs) {
    if (sink.keyOf(job.instanceId) === job.key) {
      current += 1;
      continue;
    }
    const built = deps.mountOf(job);
    if (built == null) {
      continue;
    }
    port.mount(job.instanceId, built.spec);
    const renamed: Record<string, string> = {};
    for (const [name, value] of Object.entries(job.vars)) {
      renamed[built.spec.renames[name] ?? name] = value;
    }
    port.apply(job.instanceId, {
      vars: renamed,
      texts: job.texts,
      layoutBox: job.layoutBox,
      bleed: job.bleed,
      timeMs: job.time.tMs,
      seed: job.seed,
      fonts: deps.fontsOf(job),
    });
    stale.push({ job });
  }

  if (stale.length === 0) {
    return { drawn: 0, current, painted: true };
  }

  const painted = await port.settle();
  let drawn = 0;
  for (const { job } of stale) {
    const raster = port.rasterize(job.instanceId, job.raster.width, job.raster.height);
    if (raster != null) {
      sink.put(job.instanceId, job.key, raster);
      drawn += 1;
    }
  }
  return { drawn, current, painted };
}
