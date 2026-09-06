/**
 * Decoded frames, in order, for the tracker.
 *
 * The one part of this feature that has to touch the DOM, and the reason
 * everything else does not: from `tracker.ts` down a frame is a `Float32Array`
 * and a size, and it is this module's job to turn a `<video>` into a stream of
 * those.
 *
 * ## Why it plays rather than seeks
 *
 * The obvious implementation sets `currentTime` for each frame and waits for
 * `seeked`. It is also the one that cannot be used here. A seek is a decoder
 * flush and a re-decode from the nearest keyframe, and the footage this editor
 * is pointed at — 3600×2338 screen recordings at 120fps with eight-second GOPs
 * — costs the better part of a second per seek. Six hundred of those is not a
 * progress bar, it is an afternoon.
 *
 * So it seeks **once**, to the start of the range, and then plays: sequential
 * decode, which is the case every decoder is built for, with
 * `requestVideoFrameCallback` handing over each frame as it is presented along
 * with the `mediaTime` it belongs to. The seek-per-frame path survives only as
 * the fallback for a browser without `rVFC`.
 *
 * ## Why it decodes small
 *
 * The tracker does not need 3600 pixels across, and `trackToTimeline.ts`
 * normalises the coordinates by the frame size anyway, so the working
 * resolution cancels out and nothing downstream can tell what it was. Drawing
 * into a small canvas makes both the `getImageData` readback and every pyramid
 * level proportionally cheaper, and the box filter on the way down is a
 * denoise the tracker would otherwise have to cope with.
 *
 * ## Why it opens its own `<video>`
 *
 * `loadedAssetStore` holds a handle per clip, and the preview, the playback
 * loop and `decoderWindow.ts` all drive it. Calling `play()` on that one would
 * move the user's picture, fight the playhead, and get the element torn down
 * underneath us the moment the cursor drifted out of the preload window. This
 * one is ours, and it is closed when the panel is done with it.
 */

import { toGray, type GrayImage } from "./gray";
import type { TrackFrame } from "./tracker";

/** Longest side of the picture the tracker actually looks at. */
export const DEFAULT_WORKING_SIDE = 960;

export type FrameSourceOptions = {
  /** The clip's `localpath` — a `file://` URL, and on Windows a malformed one. */
  localpath: string;
  maxSide?: number;
};

export type HarvestRequest = {
  /** Source milliseconds. */
  startMs: number;
  endMs: number;
  /**
   * Ignore a frame that arrives less than this after the last one kept.
   *
   * Set from the project's frame duration. A 120fps source has four frames per
   * step of a 30fps grid, and three of them would be tracked at some cost and
   * then snapped onto a keyframe time one of the others already holds. Skipping
   * them is also what keeps the tracker's compute under the decoder's output
   * rate, which is what stops the playback this relies on from stuttering.
   */
  strideMs: number;
  onFrame: (frame: TrackFrame, progress: number) => void;
  signal?: AbortSignal;
};

export type FrameSource = {
  /** The source's own pixel dimensions. */
  naturalWidth: number;
  naturalHeight: number;
  /** The size of the images handed to the tracker. */
  workingWidth: number;
  workingHeight: number;
  /** Source duration in ms, or 0 when the container does not say. */
  durationMs: number;
  /** One frame, by seeking. For the seed, and only for the seed. */
  grab(sourceMs: number): Promise<TrackFrame>;
  /** The canvas the last `grab` drew into, for the panel to show. */
  readonly canvas: HTMLCanvasElement;
  harvest(request: HarvestRequest): Promise<void>;
  close(): void;
};

type Rvfc = (
  callback: (now: number, metadata: { mediaTime: number }) => void,
) => number;

export async function openFrameSource(
  options: FrameSourceOptions,
): Promise<FrameSource> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Not appended to the document. A detached element still decodes, and
  // appending one would put a stray video in the layout for the life of the
  // panel.
  video.crossOrigin = "anonymous";
  video.src = options.localpath;

  await once(video, "loadedmetadata", "error");

  const naturalWidth = video.videoWidth;
  const naturalHeight = video.videoHeight;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    video.src = "";
    throw new Error("This clip's video track could not be read.");
  }

  const maxSide = options.maxSide ?? DEFAULT_WORKING_SIDE;
  const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
  const workingWidth = Math.max(1, Math.round(naturalWidth * scale));
  const workingHeight = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = workingWidth;
  canvas.height = workingHeight;
  // `willReadFrequently` moves the canvas to a CPU backing store. Every frame
  // here is drawn once and immediately read back, which is the access pattern
  // that hint exists for; without it each `getImageData` is a GPU readback and
  // the harvest cannot keep up with playback.
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (context == null) {
    video.src = "";
    throw new Error("A 2D canvas could not be created for tracking.");
  }

  const capture = (): GrayImage => {
    context.drawImage(video, 0, 0, workingWidth, workingHeight);
    return toGray(context.getImageData(0, 0, workingWidth, workingHeight));
  };

  const rvfc: Rvfc | null =
    typeof (video as any).requestVideoFrameCallback === "function"
      ? (video as any).requestVideoFrameCallback.bind(video)
      : null;

  /**
   * Put the decoder on `sourceMs` and wait until there is a frame to read.
   *
   * The readiness wait comes first and is not optional. `loadedmetadata` says
   * the container has been parsed, not that a frame has been decoded, so
   * `drawImage` at that moment paints nothing.
   *
   * Two ways of writing this hang, and both were written here first:
   *
   * - **Assign `currentTime`, then await `seeked`.** The seed frame is usually
   *   at 0 and `currentTime` is already 0, so the assignment is a no-op, no
   *   seek is performed, and no `seeked` ever arrives. Hence the early return
   *   for a time already reached, which is only safe once readiness is known.
   * - **Await one `requestVideoFrameCallback`, to be sure the frame is
   *   painted.** `rVFC` fires when a frame is *presented*, and a paused video
   *   sitting on the frame it already showed presents nothing ever again.
   *   Measured in this app: it does not fire, while `drawImage` of that same
   *   element at `readyState` 4 returns the picture. Readiness is the whole
   *   condition, and there is nothing further to wait for.
   */
  const seekTo = async (sourceMs: number): Promise<void> => {
    await whenReady(video);

    const target = Math.max(0, sourceMs / 1000);
    if (Math.abs(video.currentTime - target) > 1e-4) {
      video.currentTime = target;
      await once(video, "seeked", "error");
    }
  };

  return {
    naturalWidth,
    naturalHeight,
    workingWidth,
    workingHeight,
    durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
    canvas,

    async grab(sourceMs: number): Promise<TrackFrame> {
      await seekTo(sourceMs);
      return { sourceMs, image: capture() };
    },

    async harvest(request: HarvestRequest): Promise<void> {
      const { startMs, endMs, strideMs, onFrame, signal } = request;
      if (!(endMs > startMs)) {
        return;
      }

      await seekTo(startMs);
      throwIfAborted(signal);

      const span = endMs - startMs;
      const report = (sourceMs: number, image: GrayImage) => {
        onFrame(
          { sourceMs, image },
          Math.max(0, Math.min(1, (sourceMs - startMs) / span)),
        );
      };

      // The seed frame, always, whatever the stride: the tracker's reference
      // patch is taken here and the user picked this instant.
      report(startMs, capture());

      if (rvfc == null) {
        await harvestBySeeking(
          { seekTo, capture, throwIfAborted: () => throwIfAborted(signal) },
          { startMs, endMs, strideMs },
          report,
        );
        return;
      }

      await harvestByPlaying(
        video,
        rvfc,
        capture,
        { startMs, endMs, strideMs, signal },
        report,
      );
    },

    close() {
      try {
        video.pause();
      } catch {
        // Pausing a video that never started throws in some states, and there
        // is nothing to do about it on the way out.
      }
      video.removeAttribute("src");
      video.load();
    },
  };
}

/**
 * Play the range and keep the frames that arrive.
 *
 * The rate is left at 1. Playing faster does not decode faster — the frames
 * still have to come out of the decoder — it only means the compositor presents
 * fewer of them, and `requestVideoFrameCallback` reports what was presented. So
 * a 2× harvest would halve the sample density to save nothing.
 */
function harvestByPlaying(
  video: HTMLVideoElement,
  rvfc: Rvfc,
  capture: () => GrayImage,
  range: {
    startMs: number;
    endMs: number;
    strideMs: number;
    signal?: AbortSignal;
  },
  report: (sourceMs: number, image: GrayImage) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { startMs, endMs, strideMs, signal } = range;
    let lastKeptMs = startMs;
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      video.pause();
      video.removeEventListener("ended", onEnded);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const onEnded = () => finish();
    const onAbort = () => finish(abortError());

    video.addEventListener("ended", onEnded);
    signal?.addEventListener("abort", onAbort);

    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (settled) {
        return;
      }
      const sourceMs = metadata.mediaTime * 1000;

      if (sourceMs > endMs) {
        finish();
        return;
      }
      // `>=` rather than `>`: at a stride of exactly one frame duration,
      // floating point puts about half of the arrivals a hair under the step
      // and dropping those would halve the sample rate.
      if (sourceMs - lastKeptMs >= strideMs - 0.5) {
        lastKeptMs = sourceMs;
        try {
          report(sourceMs, capture());
        } catch (error) {
          finish(error);
          return;
        }
      }

      rvfc(onFrame);
    };

    rvfc(onFrame);

    video.playbackRate = 1;
    video.play().catch((error) => finish(error));

    if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * The fallback: one seek per step.
 *
 * Correct everywhere and slow on exactly the footage that matters, which is why
 * it is not the main path. Kept because `requestVideoFrameCallback` is not
 * universal and a tracker that silently does nothing is worse than a slow one.
 */
async function harvestBySeeking(
  deps: {
    seekTo: (ms: number) => Promise<void>;
    capture: () => GrayImage;
    throwIfAborted: () => void;
  },
  range: { startMs: number; endMs: number; strideMs: number },
  report: (sourceMs: number, image: GrayImage) => void,
): Promise<void> {
  const step = Math.max(1, range.strideMs);
  for (let ms = range.startMs + step; ms <= range.endMs; ms += step) {
    deps.throwIfAborted();
    await deps.seekTo(ms);
    report(ms, deps.capture());
  }
}

/**
 * Resolve once the element has decoded data, not merely metadata.
 *
 * `HAVE_CURRENT_DATA` is the first `readyState` at which `drawImage` paints
 * anything. The poll alongside the event is a backstop rather than
 * belt-and-braces: `loadeddata` may have fired between the `readyState` check
 * and the listener being attached, and it does not fire twice.
 */
function whenReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearInterval(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The video could not be read (error)."));
    };
    const timer = setInterval(() => {
      if (video.readyState >= 2) {
        onReady();
      }
    }, 50);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
  });
}

function once(
  target: HTMLVideoElement,
  event: string,
  errorEvent: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`The video could not be read (${errorEvent}).`));
    };
    const cleanup = () => {
      target.removeEventListener(event, onDone);
      target.removeEventListener(errorEvent, onError);
    };
    target.addEventListener(event, onDone, { once: true });
    target.addEventListener(errorEvent, onError, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Tracking was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
