/**
 * The browser export: the project to a video file with nothing but the page.
 *
 *   File → Mediabunny Input (demux) → WebCodecs decode (`webFrameSource`)
 *        → `renderTimelineAtTime` (the same composite the preview draws)
 *        → WebCodecs encode → Mediabunny Output (mux) → the chosen file
 *
 * and the sound beside it: every audible clip decoded, laid out, resampled,
 * retimed, levelled and summed (`audio/mixer.ts`), the desktop export's FFmpeg
 * graph rebuilt in TypeScript and checked against it.
 *
 * The frame loop is `renderTimeline.ts`, the desktop export's own, with two
 * ports swapped: where frames come from and where they go. So everything the
 * picture can hold (text, shapes, masks, LUTs, effects, keyframes, templates,
 * graphics) reaches the file by the same code it reaches the preview by.
 *
 * Starting, cancelling and finishing belong to `exportSession.ts`, which is
 * the one entry point for both exports; this runs one job to its end.
 */

import {
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from "mediabunny";

import type { Timeline } from "../../../@types/timeline";
import type { RenderOptions } from "../../../states/renderOptionStore";
import { getLocationEnv } from "../../../functions/getLocationEnv";
import { loadedAssetStore } from "../../asset/loadedAssetStore";
import { createMediaInputs, MissingMediaError } from "../../asset/webMedia/mediaInputs";
import { displayNameOf, sourceFor } from "../../asset/webMedia/sourceFor";
import { createWebFrameSource } from "../../asset/webMedia/webFrameSource";
import { assetTimeline } from "../../template/assetTimeline";
import type { TemplateResolver } from "../../renderer/template";
import { withoutHiddenClips } from "../../timeline/tracks";
import { frameCount } from "../frames";
import { exportElementRenderers } from "../renderers";
import { renderTimeline, type FrameSink } from "../renderTimeline";
import { planAudio } from "./audio/audioPlan";
import { AudioMix } from "./audio/mixer";
import { mediabunnyPcmPort } from "./audio/pcmSource";
import { ensureEncoders, measureAudioDelay } from "./codecSupport";
import type { ExportDestination } from "./destination";
import { encodePlanFor, packetBounds } from "./encodeSettings";

export type WebExportJob = {
  readonly timeline: Timeline;
  readonly options: RenderOptions;
  readonly resolveTemplate: TemplateResolver;
  /** The sound's timeline: templates flattened in, hidden rows kept. */
  readonly audioTimeline: Timeline;
  readonly destination: ExportDestination;
  readonly signal: AbortSignal;
  onFrame(currentFrame: number, totalFrames: number): void;
  /** Called once the last frame is handed over; the mux is still to finish. */
  onFinalizing(): void;
};

/**
 * How far ahead of the picture the sound is kept, in seconds. The muxer
 * interleaves the two, so neither track waits long on the other.
 */
const AUDIO_LEAD_SEC = 1;
/** The mix is handed to the encoder in pieces this long. */
const AUDIO_BLOCK_SEC = 0.5;

/** Every file the export reads, by the name the user knows it by, that a page cannot open. */
function unreadableFiles(timeline: Timeline, audioTimeline: Timeline, env: ReturnType<typeof getLocationEnv>): string[] {
  const paths = new Set<string>();
  for (const element of Object.values(timeline) as any[]) {
    if (element?.filetype === "video") {
      paths.add(element.localpath);
    }
  }
  for (const clip of planAudio(audioTimeline as any)) {
    paths.add(clip.localpath);
  }
  return [...paths]
    .filter((localpath) => sourceFor(localpath, env) == null)
    .map(displayNameOf);
}

/** Planes into the one buffer an `f32-planar` sample holds. */
function planarBuffer(planes: readonly Float32Array[]): Float32Array {
  const frames = planes[0]?.length ?? 0;
  const data = new Float32Array(frames * planes.length);
  planes.forEach((plane, c) => data.set(plane, c * frames));
  return data;
}

export async function runWebExport(job: WebExportJob): Promise<void> {
  const { options, destination, signal } = job;
  const env = getLocationEnv();
  const fps = options.fps;
  const { w: width, h: height } = options.previewSize;
  const totalFrames = frameCount(options);
  const durationSec = totalFrames / fps;
  const plan = encodePlanFor(options.exportSettings, { width, height, fps });
  const { sampleRate, channels } = plan.audio;

  // The picture decodes only what it draws: hidden rows out, templates
  // flattened, exactly the map `renderTimeline` builds for its decoders.
  const pictureAssets = withoutHiddenClips(
    assetTimeline(withoutHiddenClips(job.timeline), job.resolveTemplate),
  );
  const missing = unreadableFiles(pictureAssets, job.audioTimeline, env);
  if (missing.length > 0) {
    throw new MissingMediaError(missing);
  }

  await ensureEncoders(plan, { width, height, fps });
  // Started this many samples early, so the encoder's priming falls before
  // zero, where the MP4 writer's edit list trims it. See `measureAudioDelay`.
  const audioDelay = await measureAudioDelay(plan);

  const inputs = createMediaInputs(env);
  const bounds = packetBounds(totalFrames, durationSec, sampleRate);
  const output = new Output({
    format:
      plan.container === "webm"
        ? new WebMOutputFormat()
        : // The index at the head of the file, as the desktop export's
          // `+faststart` puts it, with room reserved from the packet counts.
          new Mp4OutputFormat({ fastStart: "reserve" }),
    target: new StreamTarget(destination.writable, { chunked: true }),
  });

  const videoSource = new VideoSampleSource({
    codec: plan.video.codec,
    bitrate: new Quality(
      plan.video.quantizer != null
        ? { quantizer: plan.video.quantizer, bitrate: plan.video.bitrate }
        : { bitrate: plan.video.bitrate },
    ),
    keyFrameInterval: plan.video.keyFrameIntervalSec,
    latencyMode: "quality",
    hardwareAcceleration: plan.video.hardwareAcceleration,
  });
  const audioSource = new AudioSampleSource({
    codec: plan.audio.codec,
    bitrate: new Quality({ bitrate: plan.audio.bitrate }),
  });
  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: bounds.video });
  output.addAudioTrack(audioSource, { maximumPacketCount: bounds.audio });

  const mix = new AudioMix(planAudio(job.audioTimeline as any), mediabunnyPcmPort(inputs), {
    sampleRate,
    channels,
    totalFrames: Math.round(durationSec * sampleRate),
  });

  /** Encode the mix up to `untilSec`, or to its end. */
  const feedAudio = async (untilSec: number) => {
    const until = Math.min(mix.format.totalFrames, Math.round(untilSec * sampleRate));
    while (mix.produced < until) {
      const at = mix.produced;
      const block = await mix.next(Math.min(until - at, Math.round(AUDIO_BLOCK_SEC * sampleRate)));
      if (block == null) {
        break;
      }
      const sample = new AudioSample({
        data: planarBuffer(block),
        format: "f32-planar",
        numberOfChannels: channels,
        sampleRate,
        timestamp: (at - audioDelay) / sampleRate,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
    }
  };

  // One frame after another: the canvas is copied the instant it is handed
  // over (`new VideoSample(canvas)` makes a `VideoFrame` on the spot), and the
  // encode, the sound ahead of it and the progress run behind on this chain.
  let chain: Promise<void> = Promise.resolve();
  const sink: FrameSink = {
    window: 2,
    accept(canvas, index, total) {
      const sample = new VideoSample(canvas, { timestamp: index / fps, duration: 1 / fps });
      chain = chain
        .then(async () => {
          await feedAudio((index + 1) / fps + AUDIO_LEAD_SEC);
          await videoSource.add(sample);
          job.onFrame(index + 1, total);
        })
        .finally(() => sample.close());
      return chain;
    },
  };

  let finished = false;
  try {
    await output.start();
    await renderTimeline(
      loadedAssetStore.getState(),
      job.timeline,
      exportElementRenderers,
      options,
      () => {},
      {
        signal,
        resolveTemplate: job.resolveTemplate,
        frameSource: createWebFrameSource(inputs, (scope, assets) =>
          loadedAssetStore.getState().loadExportStills(scope, assets),
        ),
        sink,
      },
    );
    await chain;
    await feedAudio(Infinity);
    if (signal.aborted) {
      throw new DOMException("Export cancelled", "AbortError");
    }

    job.onFinalizing();
    destination.commitOnClose();
    await output.finalize();
    await destination.deliver();
    finished = true;
  } finally {
    await mix.close();
    if (!finished) {
      if (output.state === "started" || output.state === "pending") {
        await output.cancel().catch(() => {});
      }
      await destination.discard().catch(() => {});
    }
    inputs.dispose();
  }
}
