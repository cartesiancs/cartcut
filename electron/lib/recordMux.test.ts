import { describe, expect, it } from "vitest";

import { muxArgs } from "./recordMux.js";

const VIDEO = "/tmp/session/video.h264";
const FPS = 30;
const OUT = "/tmp/out.mp4";
const MIC = { path: "/tmp/session/mic.pcm", sampleRate: 48_000, channels: 1 };
const SYSTEM = {
  path: "/tmp/session/system.pcm",
  sampleRate: 48_000,
  channels: 2,
};

/** The value that follows `flag`, or undefined. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("muxArgs", () => {
  // The whole point of this call: the picture the encoder produced is the
  // picture the editor receives, byte for byte.
  it("copies the video stream in every configuration", () => {
    for (const audio of [[], [MIC], [MIC, SYSTEM]]) {
      const args = muxArgs({ videoPath: VIDEO, fps: FPS, audio, outputPath: OUT });
      expect(valueAfter(args, "-c:v")).toBe("copy");
    }
  });

  it("moves the index to the front and writes to the output path last", () => {
    const args = muxArgs({ videoPath: VIDEO, fps: FPS, audio: [MIC], outputPath: OUT });

    expect(valueAfter(args, "-movflags")).toBe("+faststart");
    expect(args[args.length - 1]).toBe(OUT);
  });

  // An elementary stream carries no timestamps. `-r` before `-i` tells the raw
  // demuxer what rate the frames were encoded at; after `-i` it would ask for a
  // conversion of timing that is already right.
  it("states the rate as an input option, ahead of the video input", () => {
    const args = muxArgs({ videoPath: VIDEO, fps: 60, audio: [], outputPath: OUT });

    expect(args.slice(0, 9)).toEqual([
      "-y",
      "-v",
      "error",
      "-r",
      "60",
      "-f",
      "h264",
      "-i",
      VIDEO,
    ]);
  });

  // `-shortest` would truncate the picture whenever the microphone stopped a
  // frame early, losing recorded video to tidy up milliseconds of silence.
  it("never asks ffmpeg to cut to the shortest stream", () => {
    const args = muxArgs({ videoPath: VIDEO, fps: FPS, audio: [MIC], outputPath: OUT });
    expect(args).not.toContain("-shortest");
  });

  describe("with no audio", () => {
    const args = muxArgs({ videoPath: VIDEO, fps: FPS, audio: [], outputPath: OUT });

    it("maps only the picture and names no audio codec", () => {
      expect(args).toContain("-map");
      expect(args).toContain("0:v");
      expect(args).not.toContain("-c:a");
      expect(args).not.toContain("-filter_complex");
    });
  });

  describe("with one source", () => {
    const args = muxArgs({ videoPath: VIDEO, fps: FPS, audio: [MIC], outputPath: OUT });

    // Headerless PCM cannot state its own length, so the format is passed on
    // the command line — from the same constants that wrote the file.
    it("describes the raw PCM on the way in", () => {
      const inputIndex = args.indexOf(MIC.path);
      expect(args.slice(inputIndex - 7, inputIndex)).toEqual([
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
      ]);
    });

    it("encodes it to AAC with no mixing", () => {
      expect(valueAfter(args, "-c:a")).toBe("aac");
      expect(args).toContain("1:a");
      expect(args).not.toContain("-filter_complex");
    });
  });

  describe("with a microphone and system audio", () => {
    const args = muxArgs({
      videoPath: VIDEO,
      fps: FPS,
      audio: [MIC, SYSTEM],
      outputPath: OUT,
    });

    // `amix` divides by the number of inputs unless told not to, which would
    // halve both sources — a recording that is quiet for no visible reason.
    it("mixes without normalising, and keeps the longer source", () => {
      const filter = valueAfter(args, "-filter_complex");

      expect(filter).toBe(
        "[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[aout]",
      );
      expect(args).toContain("[aout]");
    });

    it("carries each source's own channel count", () => {
      expect(args.filter((arg) => arg === "-ac")).toHaveLength(2);
      const micIndex = args.indexOf(MIC.path);
      const systemIndex = args.indexOf(SYSTEM.path);
      expect(args[micIndex - 2]).toBe("1");
      expect(args[systemIndex - 2]).toBe("2");
    });
  });
});
