/**
 * The single compositing entry point shared by preview and export.
 *
 * Preview passes `timeMs = timelineCursor`; export passes `timeMs = (frame / fps)
 * * 1000`. The frame sink (on-screen canvas vs `toBlob` -> ffmpeg pipe) is
 * entirely the caller's concern — this function only paints the composited frame
 * into the provided 2D context. Editor chrome (selection outline, align guides,
 * shape vertex handles, hit-testing) is NOT here; it is a preview-only overlay
 * drawn after this.
 *
 * A drawer returning `false` (asset not loaded yet, or a keyframe track sampled
 * before the element's start) skips that element only — the rest of the frame
 * still composites. Callers must never treat it as a reason to stop.
 */

import type { RenderTimeline, RenderOptions } from "../model/timeline.types";
import type {
  CanvasCtx,
  RenderDeps,
  RenderFrameOptions,
  RenderFrameResult,
} from "./types";
import { getVisibleElementIds } from "../core/visibility";
import { sortIdsByPriority } from "../core/priority";
import { drawImage } from "./drawers/image";
import { drawGif } from "./drawers/gif";
import { drawVideo } from "./drawers/video";
import { drawText } from "./drawers/text";
import { drawShape } from "./drawers/shape";

/** Ids that will be composited at `timeMs`, in z-order. Exposed so the export
 * loop can prepare exactly those assets (seek videos) before compositing. */
export function resolveFrameElementIds(
  timeline: RenderTimeline,
  timeMs: number,
  opts: RenderFrameOptions = {},
): string[] {
  const visible = getVisibleElementIds(timeline, timeMs);
  const ids = opts.skipIds
    ? visible.filter((id) => !opts.skipIds!.has(id))
    : visible;
  return sortIdsByPriority(timeline, ids);
}

export function renderFrame(
  ctx: CanvasCtx,
  timeline: RenderTimeline,
  options: RenderOptions,
  timeMs: number,
  deps: RenderDeps,
  frameOptions: RenderFrameOptions = {},
): RenderFrameResult {
  const { width, height } = options;

  ctx.clearRect(0, 0, width, height);
  if (options.backgroundColor) {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  const ids = resolveFrameElementIds(timeline, timeMs, frameOptions);

  const drawn: string[] = [];
  for (const id of ids) {
    const el = timeline[id];
    // isolate each element's transform/alpha; equivalent to the originals'
    // manual translate/rotate inverses, but crash-safe.
    ctx.save();
    let didDraw = false;
    switch (el.filetype) {
      case "image":
        didDraw = drawImage(ctx, id, el, timeMs, deps);
        break;
      case "gif":
        didDraw = drawGif(ctx, id, el, timeMs, deps);
        break;
      case "video":
        didDraw = drawVideo(ctx, id, el, timeMs, deps);
        break;
      case "text":
        didDraw = drawText(ctx, id, el, timeMs, deps);
        break;
      case "shape":
        didDraw = drawShape(ctx, id, el, timeMs);
        break;
      default:
        break;
    }
    ctx.restore();
    if (didDraw) drawn.push(id);
  }

  return { drawn };
}
