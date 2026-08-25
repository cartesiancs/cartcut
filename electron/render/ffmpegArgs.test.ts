import { describe, it, expect } from "vitest";
import {
  atempoChain,
  audioFilterFor,
  buildFFmpegArgs,
  collectAudioInputs,
  frameByteLength,
  frameFormatFor,
  isAudible,
} from "./ffmpegArgs";
import { ffmpegWindow } from "../../apps/app/src/features/timeline/geometry";
import {
  audioTwinOf,
  isAudibleElement,
} from "../../apps/app/src/features/timeline/audio";
import { detachAudioFrom } from "../../apps/app/src/features/timeline/audioOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../apps/app/src/features/timeline/tracks";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../../apps/app/src/features/renderer/testing";

/**
 * The pre-`exportSettings` shape. Kept exactly as it was on purpose: the
 * HTTP/offscreen path still builds this, so every assertion made against it here
 * doubles as the back-compatibility guarantee.
 */
const options = {
  videoDuration: 10,
  videoBitrate: 4000,
  videoDestination: "/tmp/out.mp4",
};

/**
 * The current shape, which carries a frame size and therefore reaches the
 * default `rawvideo` pipe. `options` above deliberately does not.
 */
const rawOptions = {
  ...options,
  fps: 60,
  previewSize: { w: 1920, h: 1080 },
};

/** Reads back the value FFmpeg was given for a flag preceding an input path. */
function flagsForInput(args: string[], localpath: string) {
  const at = args.indexOf(localpath);
  // ... -ss <v> -t <v> -i <path>
  return { ss: Number(args[at - 4]), t: Number(args[at - 2]) };
}

function filterComplexOf(args: string[]): string[] {
  return args[args.indexOf("-filter_complex") + 1].split(";");
}

describe("isAudible", () => {
  it("takes audio clips and video clips that carry a track", () => {
    expect(isAudible(audioElement({}))).toBe(true);
    expect(isAudible(videoElement({ isExistAudio: true }))).toBe(true);
  });

  it("skips silent video and everything that is not a media clip", () => {
    expect(isAudible(videoElement({ isExistAudio: false }))).toBe(false);
    expect(isAudible(imageElement({}))).toBe(false);
  });

  it("skips a video whose audio has been detached", () => {
    expect(
      isAudible(videoElement({ isExistAudio: true, audioDetached: true })),
    ).toBe(false);
  });

  it("agrees with the renderer's isAudibleElement on every shape", () => {
    // The two are hand-copied across the `rootDir` boundary — see the comment
    // on `isAudible`. If they ever disagree, the preview and the export make
    // different sounds and nothing else would say so.
    const cases = [
      videoElement({ isExistAudio: true }),
      videoElement({ isExistAudio: false }),
      videoElement({ isExistAudio: true, audioDetached: true }),
      videoElement({ isExistAudio: false, audioDetached: true }),
      videoElement({ isExistAudio: true, audioDetached: false }),
      audioElement({}),
      imageElement({}),
      gifElement({}),
      shapeElement({}),
      textElement({}),
      groupElement({}),
    ];

    for (const element of cases) {
      expect([element.filetype, isAudible(element)]).toEqual([
        element.filetype,
        isAudibleElement(element),
      ]);
    }
  });
});

describe("collectAudioInputs", () => {
  it("agrees with geometry.ffmpegWindow", () => {
    // The two definitions live in separate build graphs on purpose; this is
    // what stops them drifting apart.
    const element = videoElement({
      startTime: 2500,
      duration: 4000,
      speed: 2,
      trim: { startTime: 30_000, endTime: 34_000 },
      sourceDuration: 90_000,
      isExistAudio: true,
    });

    const [input] = collectAudioInputs({ v: element });
    const window = ffmpegWindow(element);

    expect(input.ssSec).toBe(window.ssSec);
    expect(input.tSec).toBe(window.tSec);
    expect(input.delayMs).toBe(window.delayMs);
  });

  it("seeks to the trim point without scaling it by speed", () => {
    // The old graph used trim.startTime * speed and landed on the wrong frame.
    const [input] = collectAudioInputs({
      v: videoElement({
        startTime: 0,
        duration: 2000,
        speed: 2,
        trim: { startTime: 6000, endTime: 8000 },
        sourceDuration: 60_000,
        isExistAudio: true,
      }),
    });
    expect(input.ssSec).toBe(6);
  });

  it("delays by the clip's timeline position, not by its trim", () => {
    // The old graph added trim.startTime here, so exported audio ran late.
    const [input] = collectAudioInputs({
      a: audioElement({
        startTime: 7000,
        duration: 1000,
        trim: { startTime: 4000, endTime: 5000 },
        sourceDuration: 20_000,
      }),
    });
    expect(input.delayMs).toBe(7000);
  });

  it("never emits a negative delay", () => {
    // adelay rejects one, and the old code had a whole branch tangled around it.
    const [input] = collectAudioInputs({
      a: audioElement({ startTime: -500, duration: 1000 }),
    });
    expect(input.delayMs).toBe(0);
  });

  it("keeps timeline order stable across clips", () => {
    const inputs = collectAudioInputs({
      a: audioElement({ startTime: 0, duration: 1000 }),
      b: audioElement({ startTime: 3000, duration: 1000 }),
    });
    expect(inputs.map((i) => i.delayMs)).toEqual([0, 3000]);
  });

  it("returns nothing for a timeline with no audible clip", () => {
    expect(
      collectAudioInputs({
        i: imageElement({}),
        v: videoElement({ isExistAudio: false }),
      }),
    ).toEqual([]);
  });
});

describe("atempoChain", () => {
  it("is empty at natural speed", () => {
    expect(atempoChain(1)).toEqual([]);
  });

  it("passes a factor FFmpeg accepts directly", () => {
    expect(atempoChain(1.5)).toEqual([1.5]);
    expect(atempoChain(0.75)).toEqual([0.75]);
    expect(atempoChain(2)).toEqual([2]);
    expect(atempoChain(0.5)).toEqual([0.5]);
  });

  it("chains past the 2x ceiling", () => {
    expect(atempoChain(4)).toEqual([2, 2]);
    expect(atempoChain(3)).toEqual([2, 1.5]);
  });

  it("chains past the 0.5x floor", () => {
    expect(atempoChain(0.25)).toEqual([0.5, 0.5]);
  });

  it("multiplies back out to the requested speed", () => {
    for (const speed of [0.25, 0.5, 0.75, 1.5, 2, 3, 4, 8]) {
      const product = atempoChain(speed).reduce((a, b) => a * b, 1);
      expect(product).toBeCloseTo(speed, 6);
    }
  });

  it("keeps every factor inside the range FFmpeg accepts", () => {
    for (const speed of [0.1, 0.25, 3, 8, 16]) {
      for (const factor of atempoChain(speed)) {
        expect(factor).toBeGreaterThanOrEqual(0.5);
        expect(factor).toBeLessThanOrEqual(2);
      }
    }
  });

  it("treats a missing or absurd rate as natural speed", () => {
    expect(atempoChain(0)).toEqual([]);
    expect(atempoChain(-2)).toEqual([]);
  });
});

describe("audioFilterFor", () => {
  it("delays without touching tempo at natural speed", () => {
    const filter = audioFilterFor(
      { localpath: "/a.mp3", ssSec: 0, tSec: 1, delayMs: 2000, speed: 1 },
      1,
      "audio0",
    );
    expect(filter).toBe("[1:a]adelay=2000|2000[audio0]");
  });

  it("applies tempo before placement", () => {
    // Delaying first then stretching would scale the delay too.
    const filter = audioFilterFor(
      { localpath: "/a.mp3", ssSec: 0, tSec: 4, delayMs: 1000, speed: 2 },
      2,
      "audio1",
    );
    expect(filter).toBe("[2:a]atempo=2,adelay=1000|1000[audio1]");
  });

  it("emits a chain for a rate beyond the single-stage range", () => {
    const filter = audioFilterFor(
      { localpath: "/a.mp3", ssSec: 0, tSec: 4, delayMs: 0, speed: 4 },
      1,
      "audio0",
    );
    expect(filter).toBe("[1:a]atempo=2,atempo=2,adelay=0|0[audio0]");
  });

  it("rounds a fractional delay, which adelay requires", () => {
    const filter = audioFilterFor(
      { localpath: "/a.mp3", ssSec: 0, tSec: 1, delayMs: 1500.6, speed: 1 },
      1,
      "audio0",
    );
    expect(filter).toContain("adelay=1501|1501");
  });
});

describe("frameFormatFor", () => {
  it("defaults to rawvideo once a frame size is known", () => {
    expect(frameFormatFor(rawOptions)).toBe("rawvideo");
  });

  it("falls back to PNG when no frame size is carried", () => {
    // rawvideo has no dimensions of its own, so `-s WxH` is mandatory and
    // FFmpeg refuses to start without it. Legacy and HTTP/offscreen callers
    // build the flat shape, which has none — PNG is the runnable answer, not
    // an unrunnable command.
    expect(frameFormatFor(options)).toBe("png");
    expect(
      frameFormatFor({ ...options, previewSize: { w: 0, h: 1080 } }),
    ).toBe("png");
    expect(
      frameFormatFor({
        ...options,
        previewSize: { w: Number.NaN, h: 1080 },
      }),
    ).toBe("png");
  });

  it("honours an explicit PNG request even with a frame size", () => {
    expect(frameFormatFor({ ...rawOptions, frameFormat: "png" })).toBe("png");
  });
});

describe("frameByteLength", () => {
  it("is four bytes per pixel, matching -pix_fmt rgba", () => {
    expect(frameByteLength(1920, 1080)).toBe(1920 * 1080 * 4);
    expect(frameByteLength(2, 3)).toBe(24);
  });
});

describe("buildFFmpegArgs, rawvideo pipe", () => {
  it("declares the stride before the input, as FFmpeg requires", () => {
    const args = buildFFmpegArgs(rawOptions, {});
    expect(args.slice(0, 12)).toEqual([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "1920x1080",
      "-r",
      "60",
      "-thread_queue_size",
      "512",
      "-i",
      "pipe:0",
    ]);
  });

  it("puts -pix_fmt and -s before -i, or they parse as output options", () => {
    const args = buildFFmpegArgs(rawOptions, {});
    const input = args.indexOf("pipe:0");
    expect(args.indexOf("-pix_fmt")).toBeLessThan(input);
    expect(args.indexOf("-s")).toBeLessThan(input);
  });

  it("sizes the frame from previewSize, not the encoder settings", () => {
    const args = buildFFmpegArgs(
      { ...rawOptions, previewSize: { w: 640, h: 360 } },
      {},
    );
    expect(args[args.indexOf("-s") + 1]).toBe("640x360");
  });

  it("clocks the pipe at the project's frame rate", () => {
    const args = buildFFmpegArgs({ ...rawOptions, fps: 30 }, {});
    expect(args[args.indexOf("-r") + 1]).toBe("30");
  });

  it("leaves the audio graph and output settings untouched", () => {
    // The pipe format is a transport detail; swapping it must not disturb
    // anything downstream of stream 0.
    const raw = buildFFmpegArgs(rawOptions, { a: audioElement({}) });
    const png = buildFFmpegArgs(
      { ...rawOptions, frameFormat: "png" },
      { a: audioElement({}) },
    );
    expect(filterComplexOf(raw)).toEqual(filterComplexOf(png));
    expect(raw.slice(raw.indexOf("-map"))).toEqual(
      png.slice(png.indexOf("-map")),
    );
  });
});

describe("buildFFmpegArgs", () => {
  it("reads video frames from the PNG pipe as stream 0", () => {
    const args = buildFFmpegArgs(options, {});
    expect(args.slice(0, 8)).toEqual([
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-r",
      "60",
      "-i",
      "pipe:0",
    ]);
  });

  it("clocks the PNG pipe at the project's frame rate", () => {
    // renderTimeline emits frames at options.fps, so the pipe has to agree or
    // the export comes out time-stretched.
    const args = buildFFmpegArgs({ ...options, fps: 30 }, {});
    expect(args[args.indexOf("-r") + 1]).toBe("30");
  });

  it("substitutes a silent track when nothing is audible", () => {
    const args = buildFFmpegArgs(options, { i: imageElement({}) });
    const filters = filterComplexOf(args);
    expect(filters[0]).toContain("anullsrc");
    expect(filters[0]).toContain("d=10");
    expect(filters).toContain("[silent]aresample=async=1[aout]");
  });

  it("shapes the silence like the audio settings that were chosen", () => {
    const args = buildFFmpegArgs(
      {
        ...options,
        exportSettings: { sampleRate: 48000, channels: 1 },
      },
      { i: imageElement({}) },
    );
    const silence = filterComplexOf(args)[0];
    expect(silence).toContain("sample_rate=48000");
    expect(silence).toContain("channel_layout=mono");
  });

  it("places a single clip's source window on the command line", () => {
    const args = buildFFmpegArgs(options, {
      a: audioElement({
        localpath: "/song.mp3",
        startTime: 2000,
        duration: 3000,
        trim: { startTime: 1000, endTime: 4000 },
        sourceDuration: 30_000,
      }),
    });

    expect(flagsForInput(args, "/song.mp3")).toEqual({ ss: 1, t: 3 });
    expect(filterComplexOf(args)).toContain(
      "[1:a]adelay=2000|2000[audio0]",
    );
  });

  it("numbers clip streams from 1, after the pipe", () => {
    const args = buildFFmpegArgs(options, {
      a: audioElement({ localpath: "/a.mp3", startTime: 0, duration: 1000 }),
      b: audioElement({ localpath: "/b.mp3", startTime: 1000, duration: 1000 }),
    });
    const filters = filterComplexOf(args);
    expect(filters[0]).toContain("[1:a]");
    expect(filters[1]).toContain("[2:a]");
  });

  it("mixes when more than one clip is audible", () => {
    const args = buildFFmpegArgs(options, {
      a: audioElement({ localpath: "/a.mp3", startTime: 0, duration: 1000 }),
      b: audioElement({ localpath: "/b.mp3", startTime: 1000, duration: 1000 }),
    });
    expect(filterComplexOf(args)).toContain(
      "[audio0][audio1]amix=inputs=2[aout]",
    );
  });

  it("corrects tempo for a sped-up clip", () => {
    // Without this the 4s of source stayed 4s long against a 2s clip.
    const args = buildFFmpegArgs(options, {
      v: videoElement({
        localpath: "/clip.mp4",
        startTime: 0,
        duration: 4000,
        speed: 2,
        trim: { startTime: 0, endTime: 4000 },
        sourceDuration: 4000,
        isExistAudio: true,
      }),
    });

    expect(flagsForInput(args, "/clip.mp4")).toEqual({ ss: 0, t: 4 });
    expect(filterComplexOf(args)[0]).toContain("atempo=2");
  });

  it("takes source seconds for -t so the output lands at the clip's span", () => {
    // -t is a source-domain length; atempo then compresses it to the timeline
    // span. 4s of source at 2x occupies 2s of output.
    const args = buildFFmpegArgs(options, {
      v: videoElement({
        localpath: "/clip.mp4",
        duration: 4000,
        speed: 2,
        trim: { startTime: 0, endTime: 4000 },
        sourceDuration: 4000,
        isExistAudio: true,
      }),
    });
    const { t } = flagsForInput(args, "/clip.mp4");
    expect(t).toBe(4);
    expect(t / 2).toBe(2);
  });

  it("omits a silent video from the audio graph entirely", () => {
    const args = buildFFmpegArgs(options, {
      v: videoElement({ localpath: "/silent.mp4", isExistAudio: false }),
    });
    expect(args).not.toContain("/silent.mp4");
    expect(filterComplexOf(args)[0]).toContain("anullsrc");
  });
});

/**
 * Detaching audio moves a clip's sound to a second element pointing at the
 * *same file*, and this is where that has to cost nothing.
 *
 * `amix` runs with its default `normalize=1`, so the output is divided by the
 * input count. A detach that added the twin without silencing its source would
 * not merely double that clip — it would pull down every other clip in the
 * project. These tests pin the count, not just the shape.
 */
describe("a detached clip in the export graph", () => {
  /** The video as it stands before the detach. */
  const source = () =>
    videoElement({
      localpath: "/clip.mp4",
      startTime: 2500,
      duration: 4000,
      speed: 1,
      trim: { startTime: 6000, endTime: 10_000 },
      sourceDuration: 30_000,
      isExistAudio: true,
    });

  /** The same clip after the detach: silenced video plus its audio twin. */
  const detached = (over = {}) => {
    const video = { ...source(), ...over };
    return {
      v: { ...video, audioDetached: true },
      a: audioTwinOf(video as any),
    };
  };

  function amixInputs(args: string[]): number {
    const mix = filterComplexOf(args).find((stage) => stage.includes("amix="));
    return mix == null ? 1 : Number(/amix=inputs=(\d+)/.exec(mix)![1]);
  }

  it("mixes the same number of inputs as before the detach", () => {
    // The whole reason `audioDetached` exists.
    const before = buildFFmpegArgs(options, { v: source() });
    const after = buildFFmpegArgs(options, detached());
    expect(amixInputs(after)).toBe(amixInputs(before));
  });

  it("adds the source file exactly once", () => {
    const args = buildFFmpegArgs(options, detached());
    expect(args.filter((arg) => arg === "/clip.mp4")).toHaveLength(1);
  });

  it("builds exactly one audio chain", () => {
    const args = buildFFmpegArgs(options, detached());
    const chains = filterComplexOf(args).filter((stage) =>
      /^\[\d+:a\]/.test(stage),
    );
    expect(chains).toHaveLength(1);
  });

  it("lands the sound where the video's own audio would have", () => {
    const before = buildFFmpegArgs(options, { v: source() });
    const after = buildFFmpegArgs(options, detached());

    expect(flagsForInput(after, "/clip.mp4")).toEqual(
      flagsForInput(before, "/clip.mp4"),
    );
    expect(filterComplexOf(after)[0]).toBe(filterComplexOf(before)[0]);
  });

  it("carries the clip's speed onto the twin", () => {
    const args = buildFFmpegArgs(
      options,
      detached({
        speed: 2,
        duration: 4000,
        trim: { startTime: 0, endTime: 4000 },
      }),
    );
    expect(filterComplexOf(args)[0]).toContain("atempo=2");
    // -t is source seconds; atempo compresses it to the 2s timeline span.
    expect(flagsForInput(args, "/clip.mp4").t).toBe(4);
  });

  it("does not quieten the other clips in the project", () => {
    const song = audioElement({
      localpath: "/song.mp3",
      startTime: 0,
      duration: 8000,
      trim: { startTime: 0, endTime: 8000 },
      sourceDuration: 8000,
    });

    const before = buildFFmpegArgs(options, { v: source(), s: song });
    const after = buildFFmpegArgs(options, { ...detached(), s: song });

    expect(amixInputs(after)).toBe(2);
    expect(amixInputs(after)).toBe(amixInputs(before));
  });

  it("moves the sound when the twin is dragged away from the picture", () => {
    // The point of detaching: the audio can sit somewhere the video does not.
    const clips = detached();
    const args = buildFFmpegArgs(options, {
      ...clips,
      a: { ...clips.a, startTime: clips.a.startTime + 1500 },
    });
    expect(filterComplexOf(args)[0]).toContain("adelay=4000|4000");
  });

  it("still mixes one input when only the twin survives a delete", () => {
    const args = buildFFmpegArgs(options, { a: detached().a });
    expect(amixInputs(args)).toBe(1);
    expect(filterComplexOf(args)).not.toContainEqual(
      expect.stringContaining("anullsrc"),
    );
  });

  /**
   * The same claims again, but driven by the real op rather than by the
   * fixture above.
   *
   * `detached()` states what this file *believes* a detached document looks
   * like. These run `detachAudioFrom` for real and export what it produced, so
   * a change to the op that the fixture no longer matches fails here instead
   * of passing everywhere and being wrong in the app.
   */
  describe("driven by detachAudioFrom", () => {
    function exported(over = {}) {
      const before = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v1", "video", 0)],
        elements: { v: { ...source(), trackId: "v1", ...over } },
      });

      let n = 0;
      const after = detachAudioFrom(before, ["v"], () => `id${n++}`);
      return {
        before: buildFFmpegArgs(options, before.elements),
        after: buildFFmpegArgs(options, after.elements),
      };
    }

    it("keeps the mix at one input", () => {
      const { before, after } = exported();
      expect(amixInputs(after)).toBe(1);
      expect(amixInputs(after)).toBe(amixInputs(before));
    });

    it("produces the byte-identical audio graph it had before", () => {
      // The strongest statement available: detaching audio changes *where the
      // sound is editable*, and nothing at all about how it is exported.
      const { before, after } = exported();
      expect(filterComplexOf(after)).toEqual(filterComplexOf(before));
    });

    it("keeps the graph identical for a sped-up, trimmed clip too", () => {
      const { before, after } = exported({
        speed: 2,
        duration: 3000,
        trim: { startTime: 6000, endTime: 9000 },
      });
      expect(filterComplexOf(after)).toEqual(filterComplexOf(before));
      expect(flagsForInput(after, "/clip.mp4")).toEqual(
        flagsForInput(before, "/clip.mp4"),
      );
    });

    it("never goes silent", () => {
      // A detach that silenced the video without placing the twin would fall
      // through to `anullsrc` and export an empty track.
      const { after } = exported();
      expect(after).toContain("/clip.mp4");
      expect(filterComplexOf(after)).not.toContainEqual(
        expect.stringContaining("anullsrc"),
      );
    });
  });

  it("always maps both output streams and ends at the destination", () => {
    const args = buildFFmpegArgs(options, {});
    expect(args).toContain("-map");
    expect(args).toContain("[vout]");
    expect(args).toContain("[aout]");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("carries the project duration and bitrate through", () => {
    const args = buildFFmpegArgs(options, {});
    expect(args[args.indexOf("-b:v") + 1]).toBe("4000k");
    expect(args[args.lastIndexOf("-t") + 1]).toBe("10");
    // A legacy options object means bitrate mode, not the UI's CRF default.
    expect(args).not.toContain("-crf");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
  });

  it("encodes at constant quality when the settings ask for it", () => {
    const args = buildFFmpegArgs(
      { ...options, exportSettings: { qualityMode: "crf", crf: 23 } },
      {},
    );
    expect(args[args.indexOf("-crf") + 1]).toBe("23");
    expect(args).not.toContain("-b:v");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("builds a webm the VP9 and Opus encoders will accept", () => {
    const args = buildFFmpegArgs(
      {
        ...options,
        videoDestination: "/tmp/out.webm",
        exportSettings: {
          videoCodec: "vp9",
          container: "webm",
          qualityMode: "crf",
          audioCodec: "opus",
        },
      },
      {},
    );
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args[args.indexOf("-c:a") + 1]).toBe("libopus");
    expect(args[args.indexOf("-b:v") + 1]).toBe("0");
    expect(args).not.toContain("-preset");
    expect(args).not.toContain("-movflags");
    expect(args.slice(-3)).toEqual(["-f", "webm", "/tmp/out.webm"]);
  });

  it("builds a ProRes mov with a profile instead of rate control", () => {
    const args = buildFFmpegArgs(
      {
        ...options,
        videoDestination: "/tmp/out.mov",
        exportSettings: { videoCodec: "prores", proresProfile: 3 },
      },
      {},
    );
    expect(args[args.indexOf("-c:v") + 1]).toBe("prores_ks");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("3");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv422p10le");
    expect(args).not.toContain("-crf");
    expect(args).not.toContain("-b:v");
    expect(args.slice(-3)).toEqual(["-f", "mov", "/tmp/out.mov"]);
  });

  it("keeps the destination last whatever the settings", () => {
    const variants: any[] = [
      options,
      { ...options, exportSettings: { qualityMode: "crf" } },
      { ...options, exportSettings: { videoCodec: "h265" } },
      { ...options, exportSettings: { videoCodec: "vp9" } },
      { ...options, exportSettings: { videoCodec: "prores" } },
    ];
    for (const variant of variants) {
      const args = buildFFmpegArgs(variant, {
        a: audioElement({ localpath: "/song.mp3" }),
      });
      expect(args[args.length - 1]).toBe(variant.videoDestination);
    }
  });
});
