import type { Timeline } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import type { ILoadedAssetStore } from "../asset/loadedAssetStore";
import {
  renderTimelineAtTime,
  type TimelineRenderers,
} from "../renderer/timeline";
import { createExportFxRuntime } from "../renderer/fx/createRuntime";
import { hasFxElements } from "../renderer/fx/planFrame";
import { frameCount, frameTimeMs, inFlightWindow } from "./frames";
import { createFrameProfiler } from "./profile";

/**
 * Extras the frame loop understands, none of which the older call sites pass.
 *
 * These are a field bag rather than positional parameters so the signature the
 * existing suites drive stays exactly as it was.
 */
export type RenderTimelineControls = {
  /** Aborts the loop between frames, and while waiting on a seek. */
  signal?: AbortSignal;
};

/**
 * Handed one finished frame.
 *
 * Returning a promise applies backpressure: the loop keeps at most
 * `inFlightWindow` frames outstanding and will not render past that until the
 * oldest settles. That is what stops the renderer outrunning FFmpeg now that
 * frames are raw and cheap to produce — see `renderFrame.ts`.
 *
 * Frames are handed over in order, and the main-process handler writes them to
 * stdin in the order it receives them, so a window wider than one does not
 * reorder the stream.
 */
export type FrameCallback = (
  currentFrameBuffer: ArrayBuffer,
  currentFrame: number,
  totalFrames: number,
) => void | Promise<void>;

/**
 * Render timeline using canvas. Contains only rendering logic.
 * If you want to implement various export methods, use this as a building block.
 * @param assetStore Store for assets to load
 * @param options Options for rendering. Part of ExportOptions.
 * @param frameCallback Callback for frame processing.
 * @param controls Optional abort plumbing.
 */
export async function renderTimeline(
  assetStore: ILoadedAssetStore,
  timeline: Timeline,
  elementRenderers: TimelineRenderers,
  options: RenderOptions,
  frameCallback: FrameCallback,
  controls: RenderTimelineControls = {},
): Promise<void> {
  const {
    fps,
    previewSize: { w: width, h: height },
    backgroundColor,
  } = options;
  const { signal } = controls;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (ctx == null) {
    throw new Error("Failed to create canvas context");
  }

  const profiler = createFrameProfiler();

  /**
   * Effects and transitions for this export.
   *
   * Its own context and compositor, separate from the preview's: this one
   * blocks on the GPU, because `captureFrame` reads the canvas back with
   * `getImageData` immediately after compositing and that read must see the GL
   * result. Sharing the preview's would also mean two frame loops writing the
   * same drawing buffer.
   *
   * Built only when the timeline actually contains an effect or a transition.
   * Creating one allocates a canvas and a WebGL context, and most exports need
   * neither — so an export of an ordinary edit costs exactly what it did before
   * this feature existed, down to the number of canvases it creates.
   *
   * `null` where there is no WebGL, and every frame then renders exactly as it
   * did before this feature — no effects, no transitions, no crash.
   */
  const fx = hasFxElements(timeline) ? createExportFxRuntime(fps) : null;

  // Export never plays the `<audio>` handles — FFmpeg rebuilds the whole audio
  // graph from the timeline itself — so decoding them here buys nothing but
  // latency, memory, and a set of media elements nobody owns the state of.
  await assetStore.loadEntireTimeline(timeline, { audio: false });

  const totalFrames = frameCount(options);

  // Frames handed to `frameCallback` but not yet acknowledged. Keeping more
  // than one outstanding is what lets the next seek and composite overlap
  // FFmpeg's consumption of the last frame.
  const inFlight: Promise<void>[] = [];
  const windowSize = inFlightWindow(width, height);

  // The first failure from any outstanding frame. They are caught as soon as
  // they are queued — an in-flight rejection nobody is awaiting yet would
  // otherwise surface as an unhandled rejection — and re-thrown from the loop
  // at the next checkpoint.
  let failure: unknown = null;
  const queue = (result: void | Promise<void>) => {
    if (result == null || typeof (result as Promise<void>).then !== "function") {
      return;
    }
    inFlight.push(
      (result as Promise<void>).catch((error) => {
        failure ??= error;
      }),
    );
  };
  const throwIfFailed = () => {
    if (failure != null) {
      throw failure;
    }
  };

  try {
    for (let currentFrame = 0; currentFrame < totalFrames; currentFrame++) {
      throwIfAborted(signal);
      throwIfFailed();

      const timeInMs = frameTimeMs(currentFrame, fps);

      await profiler.measureAsync("seek", () =>
        assetStore.seek(timeline, timeInMs),
      );

      // A seek that lands after the abort would otherwise composite and ship a
      // frame into a pipe that is already being torn down.
      throwIfAborted(signal);

      profiler.measure("composite", () =>
        renderTimelineAtTime(
          ctx,
          timeline,
          timeInMs,
          elementRenderers,
          backgroundColor,
          width,
          height,
          undefined,
          undefined,
          fx,
        ),
      );

      const frameArrayBuffer = profiler.measure("capture", () =>
        captureFrame(ctx, width, height),
      );

      queue(frameCallback(frameArrayBuffer, currentFrame, totalFrames));

      // Only the wait counts as pipe time now. With a window wider than one,
      // a frame's own transport overlaps the next frame's seek, so timing the
      // handover itself would attribute work that cost no wall clock.
      if (inFlight.length >= windowSize) {
        await profiler.measureAsync("pipe", () => inFlight.shift()!);
      }

      profiler.endFrame();
    }

    // Nothing may report success until every outstanding frame has landed —
    // the caller closes FFmpeg's stdin as soon as this resolves.
    await Promise.all(inFlight);
    inFlight.length = 0;
    throwIfFailed();
  } finally {
    // On the abort and failure paths there may still be frames outstanding.
    // Settle them before unwinding so no write is still running against a pipe
    // the caller is about to tear down.
    await Promise.allSettled(inFlight);
    // Compiled programs, render targets and uploaded textures all belong to
    // this export's context. An export that is cancelled halfway leaks every
    // one of them without this.
    fx?.compositor.dispose();
    profiler.report();
  }
}

/**
 * The raw RGBA bytes of the composited frame.
 *
 * This used to be `toBlob(..., "image/png")`. PNG cost roughly 120 ms of CPU
 * per 1080p frame to deflate pixels that FFmpeg inflated again two
 * milliseconds later, which was about 60% of export wall time; the raw
 * round trip is ~3.6 ms. The pipe carries 8.29 MB per frame instead of ~1.5 MB
 * and that trade is not close.
 *
 * The stride is fixed and unframed, so the receiving end must verify the
 * length — a single short write silently shears every frame after it. See
 * `ipcRenderV2.sendFrame`.
 */
function captureFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): ArrayBuffer {
  const { data } = ctx.getImageData(0, 0, width, height);
  // `data.buffer` is the whole allocation; `getImageData` never returns a view
  // into a larger one, but slicing on a non-zero offset would be silent
  // corruption if that ever changed.
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Export cancelled", "AbortError");
  }
}
