import { describe, it, expect } from "vitest";
import {
  buildMediaElement,
  fitToPreview,
  mediaKindOf,
  DEFAULT_STILL_MS,
  type MediaProbe,
} from "./mediaElement";
import { assertTrimInvariant, spanLength } from "../timeline/geometry";

function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    kind: "video",
    localpath: "file:///clip.mp4",
    durationMs: 5_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    ...over,
  };
}

describe("mediaKindOf", () => {
  it("names the four kinds the editor can place", () => {
    expect(mediaKindOf("a.mp4")).toBe("video");
    expect(mediaKindOf("a.mov")).toBe("video");
    expect(mediaKindOf("a.png")).toBe("image");
    expect(mediaKindOf("a.jpg")).toBe("image");
    expect(mediaKindOf("a.mp3")).toBe("audio");
    expect(mediaKindOf("a.wav")).toBe("audio");
  });

  it("keeps gif apart from image, because they take different paths", () => {
    expect(mediaKindOf("a.gif")).toBe("gif");
  });

  it("is case insensitive", () => {
    expect(mediaKindOf("A.MP4")).toBe("video");
  });

  it("returns null for anything the editor has no renderer for", () => {
    expect(mediaKindOf("a.pdf")).toBeNull();
    expect(mediaKindOf("a.txt")).toBeNull();
    expect(mediaKindOf("noextension")).toBeNull();
  });

  it("takes the last extension, not the first dot in the path", () => {
    expect(mediaKindOf("/some.dir/clip.mp4")).toBe("video");
  });
});

describe("fitToPreview", () => {
  const preview = { w: 1920, h: 1080 };

  it("caps height at the frame and keeps the aspect", () => {
    const fitted = fitToPreview(3840, 2160, preview);
    expect(fitted.height).toBe(1080);
    expect(fitted.width).toBeCloseTo(1920);
  });

  it("leaves something smaller than the frame alone", () => {
    expect(fitToPreview(640, 480, preview)).toEqual({ width: 640, height: 480 });
  });

  it("keeps a portrait source portrait", () => {
    const fitted = fitToPreview(1080, 1920, preview);
    expect(fitted.height).toBe(1080);
    expect(fitted.width).toBeCloseTo(607.5);
  });
});

describe("buildMediaElement", () => {
  it("leaves the track and paint rank for placeNewElement to set", () => {
    const element = buildMediaElement(probe());
    expect(element.trackId).toBe("");
    expect(element.priority).toBe(0);
  });

  it("carries no blob — nothing on the preview or export path reads one", () => {
    for (const kind of ["video", "audio", "image", "gif"] as const) {
      expect(buildMediaElement(probe({ kind })).blob).toBe("");
    }
  });

  it("holds the trim invariant for video", () => {
    const element = buildMediaElement(probe({ kind: "video", durationMs: 7_500 }));
    expect(() => assertTrimInvariant(element)).not.toThrow();
    expect(element.duration).toBe(7_500);
    expect(spanLength(element)).toBe(7_500);
  });

  it("holds the trim invariant for audio", () => {
    const element = buildMediaElement(
      probe({ kind: "audio", durationMs: 3_200, width: 0, height: 0 }),
    );
    expect(() => assertTrimInvariant(element)).not.toThrow();
    expect((element as any).trim).toEqual({ startTime: 0, endTime: 3_200 });
    expect((element as any).sourceDuration).toBe(3_200);
  });

  it("records whether a video has sound", () => {
    expect(
      (buildMediaElement(probe({ hasAudio: false })) as any).isExistAudio,
    ).toBe(false);
    expect(
      (buildMediaElement(probe({ hasAudio: true })) as any).isExistAudio,
    ).toBe(true);
  });

  it("gives video its native size, not a fitted one", () => {
    // Deliberate: `addVideo` has always done this while `addImage` fits, and
    // changing it here would make an agent-added clip a different size from a
    // user-added one.
    const element = buildMediaElement(
      probe({ kind: "video", width: 3840, height: 2160 }),
    );
    expect((element as any).width).toBe(3840);
    expect((element as any).height).toBe(2160);
    expect((element as any).origin).toEqual({ width: 3840, height: 2160 });
  });

  it("fits an image to the project frame", () => {
    const element = buildMediaElement(
      probe({ kind: "image", width: 3840, height: 2160 }),
      { previewSize: { w: 1920, h: 1080 } },
    );
    expect((element as any).height).toBe(1080);
  });

  it("gives a still the default length, or the one asked for", () => {
    expect(buildMediaElement(probe({ kind: "image" })).duration).toBe(
      DEFAULT_STILL_MS,
    );
    expect(
      buildMediaElement(probe({ kind: "image" }), { durationMs: 4_000 }).duration,
    ).toBe(4_000);
  });

  it("takes video length from the file, ignoring durationMs", () => {
    const element = buildMediaElement(probe({ kind: "video", durationMs: 5_000 }), {
      durationMs: 999,
    });
    expect(element.duration).toBe(5_000);
  });

  it("starts a video and audio clip unfiltered and at normal speed", () => {
    const video = buildMediaElement(probe({ kind: "video" })) as any;
    expect(video.speed).toBe(1);
    expect(video.filter).toEqual({ enable: false, list: [] });
  });

  it("places at the start time it is given", () => {
    expect(buildMediaElement(probe(), { startTime: 2_500 }).startTime).toBe(2_500);
  });

  it("gives a gif its frame size and no animation block", () => {
    const element = buildMediaElement(probe({ kind: "gif", width: 320, height: 240 }));
    expect((element as any).width).toBe(320);
    expect((element as any).animation).toBeUndefined();
  });
});
