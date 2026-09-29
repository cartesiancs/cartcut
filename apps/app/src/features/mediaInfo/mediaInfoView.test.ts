import { describe, expect, it } from "vitest";
import type {
  MediaAudioStream,
  MediaFileInfo,
  MediaInfoResult,
  MediaVideoStream,
} from "../../../../../electron/lib/mediaInfo";
import type { TimelineElement } from "../../@types/timeline";
import {
  PENDING,
  aspectLabel,
  bitrateLabel,
  buildInfoView,
  channelsLabel,
  codecLabel,
  colorLabel,
  depthLabel,
  durationLabel,
  fpsLabel,
  hasAlpha,
  infoAsText,
  resolutionLabel,
  revealLabel,
  sampleRateLabel,
  targetForAsset,
  targetForElement,
  type InfoKind,
  type InfoTarget,
  type InfoView,
  type ShownSize,
} from "./mediaInfoView";

function element(fields: Record<string, unknown>): TimelineElement {
  return fields as unknown as TimelineElement;
}

describe("targetForElement", () => {
  it("asks about a video clip's own file, as an OS path", () => {
    expect(
      targetForElement(
        element({ filetype: "video", localpath: "file:///Users/me/Movies/take %231.mp4" }),
      ),
    ).toEqual({
      kind: "video",
      name: "take #1.mp4",
      fsPath: "/Users/me/Movies/take #1.mp4",
      localpath: "file:///Users/me/Movies/take %231.mp4",
      reversedCopy: null,
    });
  });

  it("asks a reversed clip about its original, and names the copy", () => {
    const target = targetForElement(
      element({
        filetype: "video",
        localpath: "file:///Users/me/Library/Cartcut/reversed/abc.mp4",
        reversed: { localpath: "file:///Users/me/Movies/a.mp4", from: 0, to: 1000 },
      }),
    );
    expect(target?.fsPath).toBe("/Users/me/Movies/a.mp4");
    expect(target?.name).toBe("a.mp4");
    expect(target?.reversedCopy).toBe("/Users/me/Library/Cartcut/reversed/abc.mp4");
  });

  it("reads the malformed Windows form the app writes", () => {
    const target = targetForElement(
      element({ filetype: "image", localpath: "file://C:\\Users\\me\\a.png" }),
    );
    expect(target?.fsPath).toBe("C:\\Users\\me\\a.png");
    expect(target?.name).toBe("a.png");
  });

  it("takes a bare path, which rasterized text and recordings write", () => {
    expect(
      targetForElement(element({ filetype: "image", localpath: "/tmp/r.png" }))?.fsPath,
    ).toBe("/tmp/r.png");
  });

  it("covers photos, GIFs and sound", () => {
    for (const filetype of ["image", "gif", "audio"]) {
      expect(
        targetForElement(element({ filetype, localpath: "file:///a/b.x" }))?.kind,
      ).toBe(filetype);
    }
  });

  it("declines everything else, which keeps the row off the menu", () => {
    for (const filetype of ["text", "shape", "group", "template", "effect", "transition"]) {
      expect(targetForElement(element({ filetype, localpath: "" }))).toBeNull();
    }
    expect(targetForElement(undefined)).toBeNull();
    expect(targetForElement(element({ filetype: "video", localpath: "" }))).toBeNull();
  });
});

describe("targetForAsset", () => {
  it("keeps the tile's path for ffprobe and its URL for the image loader", () => {
    expect(
      targetForAsset("/Users/me/a.mov", "file:///Users/me/a.mov", "a.mov", "video"),
    ).toEqual({
      kind: "video",
      name: "a.mov",
      fsPath: "/Users/me/a.mov",
      localpath: "file:///Users/me/a.mov",
      reversedCopy: null,
    });
  });

  it("declines a file it cannot describe", () => {
    expect(targetForAsset("/a.srt", "file:///a.srt", "a.srt", "unknown")).toBeNull();
    expect(targetForAsset("", "", "a.mp4", "video")).toBeNull();
  });
});

describe("labels", () => {
  it("names codecs with their profile", () => {
    expect(codecLabel("h264", "High")).toBe("H.264 High");
    expect(codecLabel("hevc", "Main 10")).toBe("HEVC (H.265) Main 10");
    expect(codecLabel("aac", "LC")).toBe("AAC LC");
    expect(codecLabel("prores", "HQ")).toBe("Apple ProRes HQ");
    expect(codecLabel("pcm_s24le", null)).toBe("PCM 24-bit");
    expect(codecLabel("pcm_f32le", null)).toBe("PCM 32-bit float");
    expect(codecLabel("somecodec", null)).toBe("SOMECODEC");
    expect(codecLabel(null, "High")).toBe("Unknown");
  });

  it("calls mjpeg a JPEG in a photo and Motion JPEG in a video", () => {
    expect(codecLabel("mjpeg", null, true)).toBe("JPEG");
    expect(codecLabel("mjpeg", null)).toBe("Motion JPEG");
  });

  it("reads frame rates, and says when one drifts", () => {
    expect(fpsLabel(30000 / 1001, 30000 / 1001)).toBe("29.97 fps");
    expect(fpsLabel(25, 25)).toBe("25 fps");
    expect(fpsLabel(null, 24)).toBe("24 fps");
    // A QuickTime screen recording, which writes frames only when the screen
    // changes.
    expect(fpsLabel(60, 3547 / 66)).toBe("Variable (avg 53.74 fps)");
    // Under 1%: a few dropped frames, not a variable rate.
    expect(fpsLabel(30, 29.8)).toBe("30 fps");
    expect(fpsLabel(120, 7179 / 60)).toBe("120 fps");
    expect(fpsLabel(null, null)).toBeNull();
  });

  it("reads bitrates", () => {
    expect(bitrateLabel(48_213_000)).toBe("48.2 Mbps");
    expect(bitrateLabel(8_000_000)).toBe("8 Mbps");
    expect(bitrateLabel(150_400_000)).toBe("150 Mbps");
    expect(bitrateLabel(256_000)).toBe("256 kbps");
    expect(bitrateLabel(900)).toBe("900 bps");
    expect(bitrateLabel(null)).toBeNull();
  });

  it("reads bit depth and sampling from the pixel format", () => {
    expect(depthLabel("yuv420p", null)).toBe("8-bit 4:2:0");
    expect(depthLabel("yuvj420p", null)).toBe("8-bit 4:2:0");
    expect(depthLabel("yuv420p10le", null)).toBe("10-bit 4:2:0");
    expect(depthLabel("p010le", null)).toBe("10-bit 4:2:0");
    expect(depthLabel("yuvj422p", null)).toBe("8-bit 4:2:2");
    expect(depthLabel("yuv444p12le", null)).toBe("12-bit 4:4:4");
    expect(depthLabel("yuva420p", null)).toBe("8-bit 4:2:0 with alpha");
    expect(depthLabel("rgba", null)).toBe("8-bit RGBA");
    expect(depthLabel("rgba64be", null)).toBe("16-bit RGBA");
    expect(depthLabel("rgb48le", null)).toBe("16-bit RGB");
    expect(depthLabel("gray", null)).toBe("8-bit Grayscale");
    expect(depthLabel("gray16le", null)).toBe("16-bit Grayscale");
    expect(depthLabel("ya8", null)).toBe("8-bit Grayscale with alpha");
  });

  it("does not read a format's name as its depth", () => {
    // The digits in these name the layout, not the bits per sample.
    expect(depthLabel("rgb24", null)).toBe("8-bit RGB");
    expect(depthLabel("nv12", null)).toBe("8-bit 4:2:0");
  });

  it("prefers the depth the stream states", () => {
    expect(depthLabel("yuv420p", 10)).toBe("10-bit 4:2:0");
  });

  it("says nothing about a pixel format it does not know", () => {
    expect(depthLabel("monob", null)).toBeNull();
    expect(depthLabel(null, 8)).toBeNull();
  });

  it("knows which pixel formats carry alpha", () => {
    expect(hasAlpha("rgba")).toBe(true);
    expect(hasAlpha("yuva420p")).toBe(true);
    expect(hasAlpha("ya8")).toBe(true);
    expect(hasAlpha("yuvj420p")).toBe(false);
    expect(hasAlpha("rgb24")).toBe(false);
    expect(hasAlpha("pal8")).toBeNull();
    expect(hasAlpha(null)).toBeNull();
  });

  it("names HDR and SDR only from what the stream states", () => {
    expect(colorLabel("smpte2084", "bt2020")).toBe("HDR10 (PQ, Rec. 2020)");
    expect(colorLabel("arib-std-b67", "bt2020")).toBe("HLG (Rec. 2020)");
    expect(colorLabel("arib-std-b67", null)).toBe("HLG");
    expect(colorLabel("bt709", "bt709")).toBe("SDR (Rec. 709)");
    expect(colorLabel("bt709", null)).toBe("SDR (Rec. 709)");
    expect(colorLabel(null, "smpte432")).toBe("SDR (Display P3)");
    expect(colorLabel("iec61966-2-1", null)).toBe("SDR (sRGB)");
    expect(colorLabel(null, null)).toBeNull();
    expect(colorLabel("gamma22", "film")).toBeNull();
  });

  it("names aspect ratios", () => {
    expect(aspectLabel(1920, 1080)).toBe("16:9");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(640, 480)).toBe("4:3");
    expect(aspectLabel(1000, 1000)).toBe("1:1");
    expect(aspectLabel(2048, 858)).toBe("2.39:1");
    expect(aspectLabel(1998, 1080)).toBe("1.85:1");
    // The user's screen recordings: no name, so the ratio.
    expect(aspectLabel(3600, 2338)).toBe("1.54:1");
    expect(aspectLabel(2338, 3600)).toBe("1:1.54");
  });

  it("writes a resolution with its aspect, and a non-square pixel", () => {
    expect(resolutionLabel(3840, 2160)).toBe("3840 × 2160 (16:9)");
    expect(resolutionLabel(1440, 1080, [4, 3])).toBe(
      "1440 × 1080 (4:3, pixel aspect 4:3)",
    );
  });

  it("names channel counts", () => {
    expect(channelsLabel(1, "mono")).toBe("Mono");
    expect(channelsLabel(2, null)).toBe("Stereo");
    expect(channelsLabel(6, "5.1(side)")).toBe("5.1");
    expect(channelsLabel(8, null)).toBe("7.1");
    expect(channelsLabel(4, "quad")).toBe("4 channels (quad)");
    expect(channelsLabel(3, null)).toBe("3 channels");
    expect(channelsLabel(null, "stereo")).toBe("stereo");
    expect(channelsLabel(null, null)).toBeNull();
  });

  it("reads sample rates and durations", () => {
    expect(sampleRateLabel(48_000)).toBe("48 kHz");
    expect(sampleRateLabel(44_100)).toBe("44.1 kHz");
    expect(sampleRateLabel(22_050)).toBe("22.05 kHz");
    expect(sampleRateLabel(null)).toBeNull();
    expect(durationLabel(252_480)).toBe("00:04:12.480");
    expect(durationLabel(null)).toBe("Unknown");
  });

  it("names Reveal in the platform's words", () => {
    expect(revealLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "Show in Finder",
    );
    expect(revealLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "Show in Explorer",
    );
    expect(revealLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Show in Folder");
  });
});

function target(kind: InfoKind, fields: Partial<InfoTarget> = {}): InfoTarget {
  return {
    kind,
    name: "a.mov",
    fsPath: "/Users/me/a.mov",
    localpath: "file:///Users/me/a.mov",
    reversedCopy: null,
    ...fields,
  };
}

function videoStream(fields: Partial<MediaVideoStream> = {}): MediaVideoStream {
  return {
    codec: "h264",
    profile: "High",
    width: 1920,
    height: 1080,
    rotation: 0,
    sampleAspect: null,
    fps: 30,
    avgFps: 30,
    pixelFormat: "yuv420p",
    bitDepth: null,
    colorTransfer: null,
    colorPrimaries: null,
    bitRate: null,
    frames: null,
    ...fields,
  };
}

function audioStream(fields: Partial<MediaAudioStream> = {}): MediaAudioStream {
  return {
    codec: "aac",
    profile: "LC",
    sampleRate: 48_000,
    channels: 2,
    channelLayout: "stereo",
    bitDepth: null,
    bitRate: null,
    language: null,
    ...fields,
  };
}

function ok(info: Partial<MediaFileInfo>, shown: ShownSize | null = null) {
  return {
    result: {
      ok: true,
      info: { durationMs: null, bitRate: null, video: null, audio: [], ...info },
    } as MediaInfoResult,
    shown,
  };
}

function rowsOf(view: InfoView, title: string) {
  return Object.fromEntries(
    (view.sections.find((s) => s.title === title)?.rows ?? []).map((r) => [r.label, r.value]),
  );
}

function generalOf(view: InfoView) {
  return Object.fromEntries(view.general.map((r) => [r.label, r.value]));
}

/** An iPhone portrait clip: stored landscape, turned a quarter, HLG. */
const phoneClip = ok({
  durationMs: 12_345,
  video: videoStream({
    codec: "hevc",
    profile: "Main 10",
    width: 3840,
    height: 2160,
    rotation: 90,
    pixelFormat: "yuv420p10le",
    colorTransfer: "arib-std-b67",
    colorPrimaries: "bt2020",
    bitRate: 47_901_234,
  }),
  audio: [audioStream({ sampleRate: 44_100, bitRate: 189_072 })],
});

describe("buildInfoView", () => {
  it("shows where the file is at once, and placeholders for the rest", () => {
    const view = buildInfoView(target("video"), null);

    expect(view.status).toBe("loading");
    expect(view.location).toBe("/Users/me/a.mov");
    expect(view.general).toEqual([
      { label: "Resolution", value: PENDING },
      { label: "Duration", value: PENDING },
    ]);
    expect(view.sections).toEqual([]);
    expect(buildInfoView(target("image"), null).general.map((r) => r.label)).toEqual([
      "Resolution",
    ]);
    expect(buildInfoView(target("audio"), null).general.map((r) => r.label)).toEqual([
      "Duration",
    ]);
  });

  it("describes a phone's portrait HDR clip the way it lands on the canvas", () => {
    const view = buildInfoView(target("video"), phoneClip);

    expect(view.status).toBe("ready");
    expect(generalOf(view)).toEqual({
      Resolution: "2160 × 3840 (9:16)",
      Duration: "00:00:12.345",
    });
    expect(view.sections.map((s) => s.title)).toEqual(["Video", "Audio"]);
    expect(rowsOf(view, "Video")).toEqual({
      Codec: "HEVC (H.265) Main 10",
      "Frame rate": "30 fps",
      Bitrate: "47.9 Mbps",
      "Bit depth": "10-bit 4:2:0",
      Color: "HLG (Rec. 2020)",
      Rotation: "90° (stored as 3840 × 2160)",
    });
    expect(rowsOf(view, "Audio")).toEqual({
      Codec: "AAC LC",
      "Sample rate": "44.1 kHz",
      Channels: "Stereo",
      Bitrate: "189 kbps",
    });
  });

  it("says a silent video has no audio track", () => {
    const view = buildInfoView(target("video"), ok({ video: videoStream() }));
    expect(rowsOf(view, "Audio")).toEqual({ Track: "None" });
  });

  it("numbers several audio tracks and names their languages", () => {
    const view = buildInfoView(
      target("video"),
      ok({
        video: videoStream(),
        audio: [
          audioStream({ language: "eng" }),
          audioStream({ codec: "pcm_s24le", profile: null, bitDepth: 24, language: "kor" }),
        ],
      }),
    );
    expect(view.sections.map((s) => s.title)).toEqual(["Video", "Audio 1", "Audio 2"]);
    expect(rowsOf(view, "Audio 1").Language).toBe("eng");
    expect(rowsOf(view, "Audio 1")["Bit depth"]).toBeUndefined();
    expect(rowsOf(view, "Audio 2")).toMatchObject({
      Codec: "PCM 24-bit",
      "Bit depth": "24-bit",
      Language: "kor",
    });
  });

  it("describes only the sound of a sound clip cut from a video", () => {
    const view = buildInfoView(target("audio"), phoneClip);
    expect(view.general.map((r) => r.label)).toEqual(["Duration"]);
    expect(view.sections.map((s) => s.title)).toEqual(["Audio"]);
  });

  it("takes a photo's size from how Chromium shows it", () => {
    const view = buildInfoView(
      target("image"),
      ok(
        { video: videoStream({ codec: "mjpeg", profile: null, width: 4032, height: 3024, pixelFormat: "yuvj420p" }) },
        { width: 3024, height: 4032 },
      ),
    );
    expect(generalOf(view)).toEqual({ Resolution: "3024 × 4032 (3:4)" });
    expect(rowsOf(view, "Image")).toEqual({
      Format: "JPEG",
      "Bit depth": "8-bit 4:2:0",
      Transparency: "No",
      Rotation: "From EXIF (stored as 4032 × 3024)",
    });
  });

  it("falls back to ffprobe's size when the photo could not be measured", () => {
    const view = buildInfoView(
      target("image"),
      ok({ video: videoStream({ codec: "png", profile: null, width: 64, height: 32, pixelFormat: "rgba" }) }),
    );
    expect(generalOf(view)).toEqual({ Resolution: "64 × 32 (2:1)" });
    expect(rowsOf(view, "Image")).toEqual({
      Format: "PNG",
      "Bit depth": "8-bit RGBA",
      Transparency: "Yes",
    });
  });

  it("describes a GIF", () => {
    const view = buildInfoView(
      target("gif"),
      ok({
        durationMs: 500,
        video: videoStream({ codec: "gif", profile: null, width: 64, height: 36, fps: 10, avgFps: 10, frames: 5, pixelFormat: "bgra" }),
      }),
    );
    expect(generalOf(view)).toEqual({
      Resolution: "64 × 36 (16:9)",
      Duration: "00:00:00.500",
    });
    expect(rowsOf(view, "GIF")).toEqual({
      Format: "GIF",
      Frames: "5",
      "Frame rate": "10 fps",
    });
  });

  it("says Unknown for a basic it was not told, and leaves details out", () => {
    const view = buildInfoView(
      target("video"),
      ok({
        video: videoStream({ codec: null, profile: null, width: null, height: null, fps: null, avgFps: null, pixelFormat: null }),
      }),
    );
    expect(generalOf(view)).toEqual({ Resolution: "Unknown", Duration: "Unknown" });
    expect(rowsOf(view, "Video")).toEqual({ Codec: "Unknown" });
  });

  it("says why it could not read the file, and hides Reveal when nothing is there", () => {
    const failed = (reason: string) =>
      buildInfoView(target("video"), {
        result: { ok: false, reason } as MediaInfoResult,
        shown: null,
      });

    const missing = failed("missing");
    expect(missing.status).toBe("failed");
    expect(missing.failure).toBe("File not found. It was moved, renamed or deleted.");
    expect(missing.canReveal).toBe(false);
    expect(missing.general).toEqual([]);
    expect(missing.sections).toEqual([]);
    expect(missing.location).toBe("/Users/me/a.mov");

    expect(failed("invalid").canReveal).toBe(false);
    expect(failed("unreadable").canReveal).toBe(true);
    expect(failed("timeout").failure).toBe("Reading this file took too long.");
  });

  it("carries a reversed clip's copy", () => {
    const view = buildInfoView(
      target("video", { reversedCopy: "/cache/r.mp4" }),
      phoneClip,
    );
    expect(view.reversedCopy).toBe("/cache/r.mp4");
  });
});

describe("infoAsText", () => {
  it("writes the dialog in the order it is painted", () => {
    const view = buildInfoView(
      target("image", { name: "a.png", fsPath: "/Users/me/a.png" }),
      ok({ video: videoStream({ codec: "png", profile: null, width: 64, height: 32, pixelFormat: "rgba" }) }),
    );
    expect(infoAsText(view)).toBe(
      [
        "a.png",
        "",
        "General",
        "Resolution: 64 × 32 (2:1)",
        "Location: /Users/me/a.png",
        "",
        "Image",
        "Format: PNG",
        "Bit depth: 8-bit RGBA",
        "Transparency: Yes",
      ].join("\n"),
    );
  });

  it("includes a failure and a reversed copy", () => {
    const text = infoAsText(
      buildInfoView(target("video", { reversedCopy: "/cache/r.mp4" }), {
        result: { ok: false, reason: "missing" },
        shown: null,
      }),
    );
    expect(text).toContain("Reversed copy: /cache/r.mp4");
    expect(text).toContain("File not found.");
  });
});

describe("the writing rules", () => {
  it("puts no em-dash and no middle dot in anything it shows", () => {
    const views = [
      buildInfoView(target("video"), null),
      buildInfoView(target("video"), phoneClip),
      buildInfoView(target("audio"), phoneClip),
      buildInfoView(target("gif"), ok({ video: videoStream({ codec: "gif" }) })),
      ...(["missing", "unreadable", "timeout", "invalid"] as const).map((reason) =>
        buildInfoView(target("image"), { result: { ok: false, reason }, shown: null }),
      ),
    ];
    for (const view of views) {
      const shown = JSON.stringify(view) + infoAsText(view);
      expect(shown).not.toMatch(/[—·]/);
    }
  });
});
