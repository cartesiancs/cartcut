/**
 * The browser export's decoders: WebCodecs, through Mediabunny, one cursor per
 * clip.
 *
 * Answers the same `ExportFrameSource` contract the desktop export's `<video>`
 * handles do, so the frame loop is the same loop. Before every composite it
 * puts each visible clip's frame into `scope.frames`, which
 * `loadedAssetStore.getElementFrame` answers first; the renderers never learn
 * which decoder ran.
 *
 * Which frame each clip shows is `frameAddress.ts`'s answer, the same function
 * the `<video>` seek asks, and the walk is `frameCursor.ts`.
 */

import { EncodedPacketSink, VideoSampleSink, type VideoSample } from "mediabunny";
import type { Timeline, VideoElementType } from "../../../@types/timeline";
import type { ExportFrameSource } from "../../export/frameSource";
import { frameAddressSec, needsFrameAt } from "../frameAddress";
import type { FrameSurface, VideoScope } from "../videoScope";
import { FrameCursor, type SamplePort } from "./frameCursor";
import type { MediaInputs, OpenedMedia } from "./mediaInputs";

type ClipDecoder = {
  readonly cursor: FrameCursor<VideoSample>;
  /** Only for a rotated or flipped source, which has to be drawn upright once. */
  canvas: OffscreenCanvas | null;
};

/** Every video clip the export draws, by element id. */
function videoClipsOf(assets: Timeline): [string, VideoElementType][] {
  return Object.entries(assets).filter(
    (entry): entry is [string, VideoElementType] =>
      entry[1]?.filetype === "video" && typeof entry[1].localpath === "string",
  );
}

function samplePortFor(media: OpenedMedia): SamplePort<VideoSample> {
  const track = media.video!;
  const samples = new VideoSampleSink(track);
  const packets = new EncodedPacketSink(track);
  const zero = media.zeroSec;
  return {
    open(fromSec) {
      const generator = samples.samples(fromSec + zero);
      return {
        async next() {
          const step = await generator.next();
          if (step.done) {
            return { done: true, value: undefined };
          }
          const sample = step.value;
          return {
            done: false,
            value: {
              timestamp: sample.timestamp - zero,
              frame: sample,
              close: () => sample.close(),
            },
          };
        },
        async return() {
          await generator.return(undefined);
          return { done: true, value: undefined };
        },
      };
    },
    async keyFrameAt(atSec) {
      const packet = await packets.getKeyPacket(atSec + zero, { metadataOnly: true });
      return packet == null ? null : packet.timestamp - zero;
    },
  };
}

/**
 * The picture to draw, upright and at its displayed size.
 *
 * A decoder's frame is drawn as it is: `drawImage` and `texImage2D` both take
 * a `VideoFrame`, and its display size already carries the pixel aspect. A
 * rotated or mirrored source (a phone held upright) is drawn once onto a canvas
 * the clip keeps, because a `<video>` presents it upright and every renderer
 * downstream assumes that.
 */
function surfaceOf(sample: VideoSample, decoder: ClipDecoder): FrameSurface {
  const width = sample.displayWidth;
  const height = sample.displayHeight;
  if (sample.rotation === 0 && !sample.flip) {
    return { source: sample.toCanvasImageSource(), width, height };
  }
  let canvas = decoder.canvas;
  if (canvas == null || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    decoder.canvas = canvas;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  sample.draw(ctx, 0, 0, width, height);
  return { source: canvas, width, height };
}

/**
 * `loadStills` puts the export's images and GIFs where their renderers look
 * (`loadedAssetStore.loadExportStills`); passed in so this file needs no store.
 */
export function createWebFrameSource(
  inputs: MediaInputs,
  loadStills: (scope: VideoScope, assets: Timeline) => Promise<void>,
): ExportFrameSource {
  const decoders = new Map<string, ClipDecoder>();
  const media = new Map<string, OpenedMedia>();

  const closeDecoder = async (scope: VideoScope, elementId: string) => {
    // The entry goes first: once the cursor closes, its frame is closed too,
    // and drawing a closed `VideoFrame` throws.
    scope.frames.delete(elementId);
    const decoder = decoders.get(elementId);
    decoders.delete(elementId);
    await decoder?.cursor.close();
  };

  return {
    async load(scope, assets) {
      await loadStills(scope, assets);
      // Every file opened, and every one checked, before the first frame: a
      // file this browser cannot decode fails the export now, by name, rather
      // than turning up as a black clip in the delivered file.
      const clips = videoClipsOf(assets);
      const opened = await Promise.all(
        clips.map(async ([id, element]) => {
          const file = await inputs.open(element.localpath);
          return [id, file] as const;
        }),
      );
      const undecodable = new Set<string>();
      for (const [id, file] of opened) {
        if (file.video == null) {
          undecodable.add(`${file.name} (no video track)`);
          continue;
        }
        if (!(await file.video.canDecode())) {
          undecodable.add(`${file.name} (${file.video.codec ?? "unknown codec"})`);
          continue;
        }
        media.set(id, file);
      }
      if (undecodable.size > 0) {
        throw new Error(
          `Cannot export: this browser cannot decode ${[...undecodable].join(", ")}.`,
        );
      }
    },

    async advance(scope, assets, timeMs, fps) {
      const work: Promise<void>[] = [];
      for (const [id, element] of videoClipsOf(assets)) {
        if (!needsFrameAt(assets, id, timeMs)) {
          // Off screen: its decoder is let go, so a long timeline holds only
          // the decoders of what is showing. A clip that comes back opens a
          // fresh one where it is needed.
          if (decoders.has(id) || scope.frames.has(id)) {
            work.push(closeDecoder(scope, id));
          }
          continue;
        }
        const file = media.get(id);
        if (file == null) {
          continue;
        }
        let decoder = decoders.get(id);
        if (decoder == null) {
          decoder = { cursor: new FrameCursor(samplePortFor(file)), canvas: null };
          decoders.set(id, decoder);
        }
        const clip = decoder;
        const want = frameAddressSec(element, assets, timeMs, fps);
        work.push(
          clip.cursor.at(want).then((shown) => {
            if (shown == null) {
              scope.frames.delete(id);
              return;
            }
            scope.frames.set(id, surfaceOf(shown.frame, clip));
          }),
        );
      }
      await Promise.all(work);
    },

    async release(scope) {
      await Promise.allSettled(
        [...decoders.keys()].map((id) => closeDecoder(scope, id)),
      );
      scope.frames.clear();
      media.clear();
    },
  };
}
