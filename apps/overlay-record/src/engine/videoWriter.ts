/**
 * Capture frames in, an H.264 elementary stream out.
 *
 * This is the piece that decides what a recording looks like, and the whole of
 * it turns on one choice: **the encoder is driven by a fixed-rate clock, not by
 * the capturer.**
 *
 * A desktop capturer is variable-rate by nature — it produces a frame when
 * something on screen changed, and nothing at all while a page of text sits
 * still. Encoding those frames as they arrive gives a stream whose timing lives
 * only in its timestamps, which means a container that can carry them, which
 * means a muxer in this renderer. Encoding on a metronome instead — taking the
 * newest frame each tick and re-encoding the previous one when nothing has
 * changed — gives a stream where frame `n` *is* at `n / fps`, and then the
 * bytes need no timestamps at all: FFmpeg reads them with `-r`, copies them
 * into an MP4 without re-encoding, and the whole muxing problem disappears.
 *
 * It costs almost nothing. A duplicate frame is a P-frame with no residual: a
 * few dozen bytes. And it produces exactly what the editor wants, because the
 * timeline is constant-rate — `features/export/renderTimeline.ts` samples at
 * `frame / fps * 1000`, so a variable-rate source is a thing to be reconciled
 * rather than a thing to be preserved.
 *
 * The other decisions, in order of how much they matter:
 *
 *  - **Hardware H.264, at a level that admits the picture.**
 *    `captureSettings.ts#avcCodecCandidates` computes the level from the frame
 *    size and rate; a hardcoded `avc1.640028` is High at level 4.0 and refuses
 *    anything past 1080p.
 *  - **`latencyMode: "quality"`.** The default is `"realtime"`, which holds the
 *    bitrate flat frame to frame — right for a video call, and wrong here,
 *    where it gives the one frame that scrolled the same bits as the thousand
 *    that did not.
 *  - **A keyframe every two seconds**, counted here because WebCodecs has no
 *    GOP setting. The editor seeks constantly and a GOP is the granularity it
 *    can seek at.
 *  - **`avc: { format: "annexb" }`**, which is what makes the output a bare
 *    elementary stream with its parameter sets inline rather than AVCC needing
 *    an out-of-band `description`.
 */

import {
  captureSizeLadder,
  encoderPlan,
  type EncoderPlan,
  type Size,
} from "@app/features/record/captureSettings";

export type ComposeFn = (
  ctx: OffscreenCanvasRenderingContext2D,
  frame: VideoFrame,
) => void;

export type VideoWriterOptions = {
  track: MediaStreamTrack;
  /** From `negotiateEncode`, so the capture and the encoder agree on a size. */
  codec: string;
  plan: EncoderPlan;
  /**
   * Draw the finished picture, when there is more to it than the capture.
   *
   * Absent means the captured frame is encoded as it arrived — no canvas, no
   * pixel copy, no colour-space round trip. That is the better path and the
   * common one; the composite path exists only because a camera bubble has to
   * be drawn onto something.
   */
  compose?: ComposeFn;
  onChunk: (bytes: Uint8Array) => Promise<void>;
  onError: (error: Error) => void;
};

export type VideoWriter = {
  /** Media time of the first encoded frame, from `performance.now()`. */
  readonly startedAt: number;
  readonly frameCount: number;
  pause(): void;
  resume(): void;
  /** Flush the encoder and stop. Resolves when the last byte has been handed on. */
  stop(): Promise<void>;
};

/**
 * How far the tick loop will catch up after a stall.
 *
 * Falling behind means the machine could not keep up; encoding the whole
 * backlog would make it fall further behind, and a spiral ends with a recording
 * that is minutes short. Capping it means a stalled second is a second the
 * recording is short by — which is the honest outcome, and the one that
 * recovers.
 */
const MAX_CATCH_UP_FRAMES = 4;

async function supports(plan: EncoderPlan, codec: string): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: plan.width,
      height: plan.height,
      framerate: plan.framerate,
      bitrate: plan.bitrate,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "quality",
      avc: { format: "annexb" },
    } as VideoEncoderConfig);

    return support.supported === true;
  } catch {
    // `isConfigSupported` throws rather than answering `false` for a codec
    // string it cannot even parse. That is a "no", not a failure.
    return false;
  }
}

async function pickCodec(plan: EncoderPlan): Promise<string | null> {
  for (const codec of plan.codecCandidates) {
    if (await supports(plan, codec)) {
      return codec;
    }
  }
  return null;
}

/**
 * The largest frame this machine will actually encode, and what to encode it
 * with.
 *
 * Asked rather than assumed. A hardware encoder's real limits are not the
 * codec's — see `captureSizeLadder` — and they differ by machine, by GPU driver
 * and by macOS release. The negotiation has to happen *before* the capture is
 * opened, because the capture is constrained to a fixed size and the encoder
 * has to agree with it.
 */
export async function negotiateEncode(
  kind: "screen" | "camera" | "composite",
  size: Size,
  fps: number,
): Promise<{ size: Size; codec: string; plan: EncoderPlan }> {
  const attempts: string[] = [];

  for (const candidate of captureSizeLadder(size)) {
    const plan = encoderPlan(kind, candidate, fps);
    const codec = await pickCodec(plan);

    if (codec != null) {
      return { size: candidate, codec, plan };
    }

    attempts.push(`${candidate.width}×${candidate.height}`);
  }

  throw new Error(
    `This machine cannot encode H.264 at ${fps}fps at any of ${attempts.join(", ")}.`,
  );
}

export async function startVideoWriter(
  options: VideoWriterOptions,
): Promise<VideoWriter> {
  const { plan, codec } = options;

  // Writes are serialised through one promise chain. `onChunk` resolves when
  // the pipe has room, so this chain is the backpressure — and it has to be a
  // chain rather than a bare `await`, because `output` is a plain callback the
  // encoder does not wait on.
  let writes: Promise<void> = Promise.resolve();
  let failed = false;

  const fail = (error: Error) => {
    if (!failed) {
      failed = true;
      options.onError(error);
    }
  };

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      writes = writes
        .then(() => options.onChunk(bytes))
        .catch((error) => fail(error as Error));
    },
    error: (error) => fail(error as Error),
  });

  encoder.configure({
    codec,
    width: plan.width,
    height: plan.height,
    framerate: plan.framerate,
    bitrate: plan.bitrate,
    bitrateMode: "variable",
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "quality",
    avc: { format: "annexb" },
  } as VideoEncoderConfig);

  const canvas =
    options.compose == null
      ? null
      : new OffscreenCanvas(plan.width, plan.height);
  const ctx =
    canvas == null
      ? null
      : canvas.getContext("2d", { alpha: false, desynchronized: true });

  // Exactly one captured frame is held: the newest. Holding more would stall
  // the capturer, whose buffer pool is small and which drops frames rather than
  // waiting when it runs out.
  let latest: VideoFrame | null = null;

  const processor = new (window as any).MediaStreamTrackProcessor({
    track: options.track,
  });
  const reader: ReadableStreamDefaultReader<VideoFrame> =
    processor.readable.getReader();

  let reading = true;

  void (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done || value == null) {
        break;
      }
      latest?.close();
      latest = value;
    }
  })().catch((error) => fail(error as Error));

  const intervalMs = 1000 / plan.framerate;
  const startedAt = performance.now();

  let nextIndex = 0;
  let pausedAt: number | null = null;
  let pausedTotal = 0;
  let timer: number | null = null;

  const encodeAt = (index: number) => {
    const source = latest;
    if (source == null) {
      return;
    }

    // Microseconds, and derived from the index rather than accumulated: a
    // thousand steps of `1e6 / 30` added up is not the same double as one jump
    // of a thousand, which is the drift `features/timeline/frames.ts` documents
    // and refuses for the same reason.
    const timestamp = Math.round((index * 1_000_000) / plan.framerate);
    const keyFrame = index % plan.keyFrameInterval === 0;

    let frame: VideoFrame;

    if (ctx != null) {
      options.compose!(ctx, source);
      frame = new VideoFrame(ctx.canvas, { timestamp, alpha: "discard" });
    } else {
      // Zero-copy: a new handle on the same picture with a corrected clock.
      frame = new VideoFrame(source, { timestamp });
    }

    try {
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }

    nextIndex = index + 1;
  };

  const tick = () => {
    if (failed || pausedAt != null) {
      return;
    }

    const elapsed = performance.now() - startedAt - pausedTotal;
    const target = Math.floor(elapsed / intervalMs);

    if (target - nextIndex > MAX_CATCH_UP_FRAMES) {
      // Too far behind to make up. Skip to just short of the target rather than
      // encoding a backlog that would put us further behind still.
      nextIndex = target - MAX_CATCH_UP_FRAMES;
    }

    for (let index = nextIndex; index <= target; index += 1) {
      encodeAt(index);
    }
  };

  timer = window.setInterval(tick, Math.max(4, Math.floor(intervalMs / 2)));

  return {
    startedAt,
    get frameCount() {
      return nextIndex;
    },

    pause() {
      if (pausedAt == null) {
        pausedAt = performance.now();
      }
    },

    resume() {
      if (pausedAt != null) {
        pausedTotal += performance.now() - pausedAt;
        pausedAt = null;
      }
    },

    async stop() {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }

      reading = false;
      await reader.cancel().catch(() => {
        // The track may already have ended — the user stopped the share from
        // the OS chrome, say. Nothing left to cancel.
      });

      latest?.close();
      latest = null;

      await encoder.flush().catch((error) => fail(error as Error));
      encoder.close();

      // The flush produced its last chunks through `output`, which appended to
      // the chain rather than awaiting it. This is where they land.
      await writes;
    },
  };
}
