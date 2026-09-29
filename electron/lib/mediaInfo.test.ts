/**
 * The ffprobe reduction, against hand-written output modelled on ffprobe 9.
 *
 * `mediaInfoProbe.test.ts` runs the real binary against generated files; this
 * suite covers what cannot be generated cheaply there: a phone's HDR portrait
 * clip, a screen recording's drifting frame rate, cover art, and garbage.
 */

import { describe, expect, it } from "vitest";
import { parseProbe, rateOf, rotationOf } from "./mediaInfo";

describe("rateOf", () => {
  it("divides a rational", () => {
    expect(rateOf("30000/1001")).toBeCloseTo(29.97, 2);
    expect(rateOf("25/1")).toBe(25);
  });

  it("passes a positive number through", () => {
    expect(rateOf(60)).toBe(60);
  });

  it("reads ffprobe's unknowns as null rather than 0", () => {
    expect(rateOf("0/0")).toBeNull();
    expect(rateOf("N/A")).toBeNull();
    expect(rateOf(undefined)).toBeNull();
    expect(rateOf("abc")).toBeNull();
    expect(rateOf("-1/1")).toBeNull();
    expect(rateOf(0)).toBeNull();
  });
});

describe("rotationOf", () => {
  it("reads the display matrix as counter-clockwise", () => {
    // What an iPhone portrait clip reports.
    expect(rotationOf({ side_data_list: [{ rotation: -90 }] })).toBe(90);
    expect(rotationOf({ side_data_list: [{ rotation: 90 }] })).toBe(270);
    expect(rotationOf({ side_data_list: [{ rotation: 180 }] })).toBe(180);
    expect(rotationOf({ side_data_list: [{ rotation: -180 }] })).toBe(180);
  });

  it("reads the legacy rotate tag as clockwise", () => {
    expect(rotationOf({ tags: { rotate: "90" } })).toBe(90);
    expect(rotationOf({ tags: { rotate: "270" } })).toBe(270);
  });

  it("prefers the display matrix when both are present", () => {
    expect(
      rotationOf({ side_data_list: [{ rotation: -90 }], tags: { rotate: "0" } }),
    ).toBe(90);
  });

  it("skips side data that is not a rotation", () => {
    expect(
      rotationOf({
        side_data_list: [
          { side_data_type: "Content light level metadata" },
          { side_data_type: "Display Matrix", rotation: -90 },
        ],
      }),
    ).toBe(90);
  });

  it("is 0 for an upright stream and for anything unreadable", () => {
    expect(rotationOf({ side_data_list: [{ rotation: 0 }] })).toBe(0);
    expect(rotationOf({})).toBe(0);
    expect(rotationOf(null)).toBe(0);
    expect(rotationOf("90")).toBe(0);
  });
});

/** An iPhone 15 portrait clip: HEVC Main 10, HLG, stored landscape. */
const iphoneHdr = {
  streams: [
    {
      index: 0,
      codec_name: "hevc",
      profile: "Main 10",
      codec_type: "video",
      width: 3840,
      height: 2160,
      sample_aspect_ratio: "1:1",
      pix_fmt: "yuv420p10le",
      color_space: "bt2020nc",
      color_transfer: "arib-std-b67",
      color_primaries: "bt2020",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      bit_rate: "47901234",
      nb_frames: "370",
      disposition: { default: 1, attached_pic: 0 },
      tags: { language: "und", handler_name: "Core Media Video" },
      side_data_list: [
        { side_data_type: "DOVI configuration record" },
        { side_data_type: "Display Matrix", rotation: -90 },
      ],
    },
    {
      index: 1,
      codec_name: "aac",
      profile: "LC",
      codec_type: "audio",
      sample_rate: "44100",
      channels: 2,
      channel_layout: "stereo",
      bits_per_sample: 0,
      bit_rate: "189072",
      disposition: { default: 1, attached_pic: 0 },
      tags: { language: "und" },
    },
    { index: 2, codec_type: "data", codec_tag_string: "mebx" },
  ],
  format: { duration: "12.345000", bit_rate: "48213000" },
};

describe("parseProbe", () => {
  it("reduces a phone's HDR portrait clip", () => {
    const info = parseProbe(iphoneHdr);

    expect(info.durationMs).toBeCloseTo(12_345, 6);
    expect(info.bitRate).toBe(48_213_000);
    expect(info.video).toEqual({
      codec: "hevc",
      profile: "Main 10",
      width: 3840,
      height: 2160,
      rotation: 90,
      sampleAspect: null,
      fps: 30,
      avgFps: 30,
      pixelFormat: "yuv420p10le",
      bitDepth: null,
      colorTransfer: "arib-std-b67",
      colorPrimaries: "bt2020",
      bitRate: 47_901_234,
      frames: 370,
    });
    expect(info.audio).toEqual([
      {
        codec: "aac",
        profile: "LC",
        sampleRate: 44_100,
        channels: 2,
        channelLayout: "stereo",
        bitDepth: null,
        bitRate: 189_072,
        language: null,
      },
    ]);
  });

  it("keeps a screen recording's two frame rates apart", () => {
    const info = parseProbe({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          profile: "High",
          width: 3600,
          height: 2338,
          sample_aspect_ratio: "0:1",
          r_frame_rate: "120/1",
          avg_frame_rate: "7179/60",
          bits_per_raw_sample: "8",
        },
      ],
      format: { duration: "4.000000" },
    });

    expect(info.video?.fps).toBe(120);
    expect(info.video?.avgFps).toBeCloseTo(119.65, 2);
    expect(info.video?.bitDepth).toBe(8);
    // `0:1` is ffprobe's "not stated", not a zero-width pixel.
    expect(info.video?.sampleAspect).toBeNull();
    expect(info.audio).toEqual([]);
  });

  it("reads a non-square pixel aspect", () => {
    const info = parseProbe({
      streams: [{ codec_type: "video", sample_aspect_ratio: "4:3" }],
    });
    expect(info.video?.sampleAspect).toEqual([4, 3]);
  });

  it("reduces a PNG with transparency", () => {
    const info = parseProbe({
      streams: [
        {
          codec_type: "video",
          codec_name: "png",
          width: 64,
          height: 32,
          pix_fmt: "rgba",
          r_frame_rate: "25/1",
        },
      ],
      format: { format_name: "png_pipe" },
    });

    expect(info.video?.codec).toBe("png");
    expect(info.video?.pixelFormat).toBe("rgba");
    expect(info.durationMs).toBeNull();
  });

  it("does not count cover art as the picture", () => {
    const info = parseProbe({
      streams: [
        {
          codec_type: "audio",
          codec_name: "mp3",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo",
          bits_per_sample: 0,
          bit_rate: "128000",
        },
        {
          codec_type: "video",
          codec_name: "png",
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
      ],
      format: { duration: "1.000000" },
    });

    expect(info.video).toBeNull();
    expect(info.audio).toHaveLength(1);
    expect(info.audio[0].bitDepth).toBeNull();
  });

  it("keeps every audio stream in order, with its language", () => {
    const info = parseProbe({
      streams: [
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
        {
          codec_type: "audio",
          codec_name: "pcm_s24le",
          bits_per_sample: 24,
          bits_per_raw_sample: "24",
          tags: { language: "kor" },
        },
      ],
    });

    expect(info.audio.map((a) => a.language)).toEqual(["eng", "kor"]);
    expect(info.audio[1].bitDepth).toBe(24);
  });

  it("falls back to the longest stream when the container states no length", () => {
    const info = parseProbe({
      streams: [
        { codec_type: "video", duration: "0.500000" },
        { codec_type: "audio", duration: "0.750000" },
      ],
      format: { duration: "N/A" },
    });
    expect(info.durationMs).toBe(750);
  });

  it("never throws, and says nothing it was not told", () => {
    const empty = { durationMs: null, bitRate: null, video: null, audio: [] };

    for (const junk of [null, undefined, "x", 42, [], { streams: "x" }]) {
      expect(parseProbe(junk)).toEqual(empty);
    }
    expect(parseProbe({ streams: [null, 3, "video"] })).toEqual(empty);
  });
});
