/**
 * The mix's decoder: a clip's source window, decoded by WebCodecs through
 * Mediabunny, as planar float.
 *
 * Cut to the sample at both ends, the way FFmpeg's `-ss` (an accurate seek)
 * and `-t` cut the desktop export's inputs: decoding starts at the packet
 * holding `fromSec`, the frames before it are dropped, and exactly
 * `durationSec` of source is handed over unless the file ends first.
 */

import { AudioSampleSink } from "mediabunny";
import type { MediaInputs } from "../../../asset/webMedia/mediaInputs";
import { displayNameOf } from "../../../asset/webMedia/sourceFor";
import type { PcmChunk, PcmPort } from "./mixer";

export function mediabunnyPcmPort(inputs: MediaInputs): PcmPort {
  return {
    async *read(localpath, fromSec, durationSec): AsyncGenerator<PcmChunk> {
      const media = await inputs.open(localpath);
      const track = media.audio;
      if (track == null) {
        // A video recorded without sound plays silence, as its `<video>` does.
        return;
      }
      if (!(await track.canDecode())) {
        throw new Error(
          `Cannot export: this browser cannot decode the sound of ${media.name} (${track.codec ?? "unknown codec"}).`,
        );
      }
      const start = fromSec + media.zeroSec;
      const wanted = Math.round(durationSec * track.sampleRate);
      let emitted = 0;
      const sink = new AudioSampleSink(track);
      for await (const sample of sink.samples(start, start + durationSec)) {
        try {
          const rate = sample.sampleRate;
          const skip =
            emitted === 0 && sample.timestamp < start
              ? Math.min(sample.numberOfFrames, Math.round((start - sample.timestamp) * rate))
              : 0;
          const take = Math.min(sample.numberOfFrames - skip, wanted - emitted);
          if (take <= 0) {
            if (emitted >= wanted) {
              break;
            }
            continue;
          }
          const planes: Float32Array[] = [];
          for (let c = 0; c < sample.numberOfChannels; c++) {
            const plane = new Float32Array(take);
            sample.copyTo(plane, {
              planeIndex: c,
              format: "f32-planar",
              frameOffset: skip,
              frameCount: take,
            });
            planes.push(plane);
          }
          emitted += take;
          yield { planes, sampleRate: rate };
          if (emitted >= wanted) {
            break;
          }
        } finally {
          sample.close();
        }
      }
    },
    nameOf: displayNameOf,
  };
}
