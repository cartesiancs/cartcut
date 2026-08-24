import { describe, it, expect } from "vitest";
import {
  atempoChain,
  audioFilterFor,
  buildFFmpegArgs,
  collectAudioInputs,
  isAudible,
} from "./ffmpegArgs";
import { ffmpegWindow } from "../../apps/app/src/features/timeline/geometry";
import {
  audioElement,
  imageElement,
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
