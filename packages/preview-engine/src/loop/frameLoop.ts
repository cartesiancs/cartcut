/**
 * The frame loop shared by both export paths.
 *
 * `renderFrame` paints one frame; this walks the timecodes, gives the caller a
 * chance to make assets ready for each one (seeking videos, mainly), and hands
 * the encoded frame to a sink. What differs between the in-app export and the
 * offscreen render window is only the sink — which IPC channel the PNG goes down
 * and how progress is surfaced — so that is the one thing injected.
 *
 * The loop is a plain `for` with `await`, not the recursive callback chain the
 * originals used. That chain had a failure mode the offscreen renderer actually
 * hit: an element bailing out of its draw returned from the recursion step
 * without scheduling the next one, so the render stopped dead and the ffmpeg
 * pipe waited forever. Here, advancing the loop is not something an element's
 * draw can decline to do, and a frame that throws is reported and skipped rather
 * than ending the export.
 */

import type { RenderTimeline, RenderOptions } from "../model/timeline.types";
import type { CanvasCtx, RenderDeps } from "../render/types";
import { renderFrame, resolveFrameElementIds } from "../render/renderFrame";

export interface FrameSink {
  /** Hand off one encoded frame. `percent` is 0..100 for progress reporting. */
  sendFrame(frame: ArrayBuffer, percent: number): void | Promise<void>;
  /** Close the stream. Called exactly once, after the last frame. */
  finish(): void;
}

export interface FrameLoopDeps extends RenderDeps {
  /**
   * Make the assets for `timeMs` presentable before it is composited — in
   * practice, seek each visible video and wait for its `seeked` event.
   * `renderFrame` is synchronous, so all waiting happens here.
   */
  prepareFrame(timeMs: number, visibleIds: string[]): void | Promise<void>;
  /** Encode the canvas the loop just painted (`toBlob` -> `arrayBuffer`). */
  encodeCanvas(): Promise<ArrayBuffer>;
}

export interface FrameLoopSpec {
  fps: number;
  /** Project duration in seconds; frame count is `round(fps * durationSec)`. */
  durationSec: number;
}

export interface FrameLoopProgress {
  frame: number;
  totalFrames: number;
  percent: number;
}

export interface FrameLoopHooks {
  onProgress?(progress: FrameLoopProgress): void;
  /** A frame that could not be prepared or encoded. The loop continues. */
  onFrameError?(error: unknown, frame: number): void;
}

export interface FrameLoopResult {
  totalFrames: number;
  framesSent: number;
  framesFailed: number;
}

export async function runFrameLoop(
  ctx: CanvasCtx,
  timeline: RenderTimeline,
  options: RenderOptions,
  spec: FrameLoopSpec,
  deps: FrameLoopDeps,
  sink: FrameSink,
  hooks: FrameLoopHooks = {},
): Promise<FrameLoopResult> {
  const { fps, durationSec } = spec;
  const totalFrames = Math.max(0, Math.round(fps * durationSec));

  let framesSent = 0;
  let framesFailed = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    const timeMs = (frame / fps) * 1000;
    const percent = (frame / totalFrames) * 100;

    hooks.onProgress?.({ frame, totalFrames, percent });

    try {
      const ids = resolveFrameElementIds(timeline, timeMs);
      await deps.prepareFrame(timeMs, ids);
      renderFrame(ctx, timeline, options, timeMs, deps);
      const encoded = await deps.encodeCanvas();
      await sink.sendFrame(encoded, percent);
      framesSent++;
    } catch (error) {
      // A single unusable frame must not take the whole export with it — the
      // stream still has to be closed so ffmpeg can finish.
      framesFailed++;
      hooks.onFrameError?.(error, frame);
    }
  }

  sink.finish();

  return { totalFrames, framesSent, framesFailed };
}
