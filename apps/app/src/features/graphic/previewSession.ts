/**
 * The preview's half of the HTML graphic pipeline: which rasters to ask for at
 * a cursor, one prepare at a time, and which to keep.
 *
 * Never waits. The preview draws the latest raster each clip has, and
 * `onReady` asks it to repaint when new ones land. Requests made while a
 * prepare runs are folded into one more run after it; a request made while an
 * export holds the queue is replayed when it lets go.
 *
 * Four rules, each the fix for a frame the preview used to get wrong:
 *
 *  - **The next clips are prepared before they appear** (`planLookahead`),
 *    paused as well as playing, or their first frame drew nothing, or some
 *    other moment of themselves. Paused too because play pressed a frame
 *    before a clip gives the playing lookahead no time at all.
 *  - **Playing, an off-screen clip keeps an animated raster only when it is
 *    already the lookahead's**, for the clip's first frame. Any other is a
 *    moment from an earlier visit, and drawn at the entry it was the end of the
 *    previous pass, or wherever the playhead was parked; dropped, a lookahead
 *    that is late draws nothing for a frame instead. Paused, rasters are kept:
 *    a scrub back into a clip is better served by the moment it left than by
 *    nothing.
 *  - **Nothing is rasterised from a paint that never came** (`prepare.ts`):
 *    every raster stays as it was, and the preview is asked to repaint, so the
 *    prepare runs again once the window paints.
 *  - **The host's mounts are released only between prepares.** A mount
 *    removed while a prepare waits for its paint never paints, and the wait
 *    runs out its timeout.
 *
 * Over ports, so the whole loop runs under `environment: "node"` against a
 * fake host; `graphicPipeline.ts` wires it to the app.
 */

import type { Timeline } from "../../@types/timeline";
import type { GraphicJob } from "./planGraphics";
import type { PrepareResult, RasterSink } from "./prepare";
import type { PreviewRasters } from "./previewRasters";

export type PreviewRequest = {
  elements: Timeline;
  cursor: number;
  fps: number;
  playing: boolean;
};

export type PreviewPlan = {
  /** The graphics on screen at the cursor. */
  current: GraphicJob[];
  /** The graphics about to appear, each at its first frame. */
  ahead: GraphicJob[];
};

export type PreviewSessionPorts = {
  plan: (request: PreviewRequest, scaleOf: (instanceId: string) => number) => PreviewPlan;
  /** One prepare on the preview's own host, serialised with every other caller. */
  prepare: (jobs: GraphicJob[], sink: RasterSink) => Promise<PrepareResult>;
  mayPrepare: () => boolean;
  /** Run `retry` once preparing is allowed again. Only the latest is kept. */
  whenMayPrepare: (retry: () => void) => void;
  /** Unmount every instance not in `live`. */
  releaseMounts: (live: ReadonlySet<string>) => void;
  warn: (message: string, error: unknown) => void;
};

export class PreviewRasterSession {
  private busy = false;
  private again: (() => void) | null = null;

  constructor(
    private readonly ports: PreviewSessionPorts,
    readonly rasters: PreviewRasters,
  ) {}

  /** Whether a prepare is running now. */
  get preparing(): boolean {
    return this.busy;
  }

  request(request: PreviewRequest, onReady: () => void): void {
    if (!this.ports.mayPrepare()) {
      this.ports.whenMayPrepare(() => this.request(request, onReady));
      return;
    }
    if (this.busy) {
      this.again = () => this.request(request, onReady);
      return;
    }

    const { current, ahead } = this.ports.plan(request, (id) => this.rasters.scaleOf(id));
    const wanted = [...current, ...ahead];
    if (request.playing) {
      const keep = new Set(current.map((job) => job.instanceId));
      for (const job of ahead) {
        if (this.rasters.keyOf(job.instanceId) === job.key) {
          keep.add(job.instanceId);
        }
      }
      this.rasters.keepAnimated(keep);
    }
    const stale = wanted.filter((job) => this.rasters.keyOf(job.instanceId) !== job.key);
    if (stale.length === 0) {
      return;
    }

    const statics = new Set(stale.filter((job) => job.static).map((job) => job.instanceId));
    this.busy = true;
    let prepared: Promise<PrepareResult>;
    try {
      prepared = this.ports.prepare(stale, {
        keyOf: (id) => this.rasters.keyOf(id),
        put: (id, key, raster) => this.rasters.put(id, key, raster, statics.has(id)),
      });
    } catch (error) {
      prepared = Promise.reject(error);
    }
    void prepared
      .then((result) => {
        // A paint that never came is asked for again on the next repaint,
        // which a window that stopped painting only gets once it paints. A
        // clip whose very first paint failed has no raster at all, so without
        // this nothing ever asked again and it stayed missing.
        if (result.drawn > 0 || !result.painted) {
          onReady();
        }
      })
      .catch((error) => this.ports.warn("graphic: preview prepare failed", error))
      .finally(() => {
        this.busy = false;
        const again = this.again;
        this.again = null;
        again?.();
      });
  }

  /** Forget rasters, and unmount, every instance not in `live`. */
  retain(live: ReadonlySet<string>): void {
    this.rasters.retain(live);
    if (!this.busy) {
      this.ports.releaseMounts(live);
    }
  }
}
