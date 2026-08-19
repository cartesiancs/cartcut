import { describe, it, expect, vi } from "vitest";
import {
  canShowFilmstrip,
  clipLabel,
  defaultColors,
  drawDropTarget,
  drawTimeline,
  truncateText,
} from "./draw";
import { layoutTimeline, TRACK_HEIGHT, TRACK_PITCH } from "./layout";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { nullTileProvider, type TileProvider } from "./strip/provider";
import type { PeakProvider } from "./strip/audioPeaks";
import type { PeakData } from "./strip/peaks";
import { pixel, scene, solid } from "../renderer/testing";
import { audioElement, imageElement, textElement, videoElement } from "../renderer/testing";

const RANGE = 0.9;
const W = 400;
const H = 200;

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
    elements,
  });
}

function paint(d: TimelineDocument, over: Partial<Parameters<typeof drawTimeline>[1]> = {}) {
  const { canvas, ctx } = scene(W, H);
  const layout = layoutTimeline({
    doc: d,
    range: RANGE,
    hScroll: 0,
    vScroll: 0,
    viewportW: W,
    viewportH: H,
    // Pixel assertions below are written against the top of the canvas; the
    // ruler strip the real timeline reserves would just offset every one.
    topOffset: 0,
  });

  drawTimeline(ctx, {
    layout,
    doc: d,
    range: RANGE,
    hScroll: 0,
    viewportW: W,
    viewportH: H,
    selection: [],
    playheadMs: 0,
    projectEndMs: 100_000,
    colors: defaultColors,
    ...over,
  });

  return { canvas, ctx, layout };
}

/** A provider that always returns the same solid tile. */
function solidProvider(color: string): TileProvider {
  const tile = solid(80, TRACK_HEIGHT, color);
  return { get: () => tile as any, request: () => {} };
}

describe("truncateText", () => {
  const { ctx } = scene(10, 10);
  ctx.font = '12px "Noto Sans", sans-serif';

  it("leaves text that already fits", () => {
    expect(truncateText(ctx, "ab", 1000)).toBe("ab");
  });

  it("ellipsises text that does not", () => {
    const result = truncateText(ctx, "a very long clip name indeed", 40);
    expect(result.endsWith("…")).toBe(true);
    expect(ctx.measureText(result).width).toBeLessThanOrEqual(40);
  });

  it("returns nothing when there is no room at all", () => {
    expect(truncateText(ctx, "abc", 0)).toBe("");
    expect(truncateText(ctx, "abc", -5)).toBe("");
  });

  it("never returns more than it was given", () => {
    const result = truncateText(ctx, "abcdef", 20);
    expect(result.replace("…", "").length).toBeLessThanOrEqual(6);
  });
});

describe("clipLabel", () => {
  it("uses a text clip's own words", () => {
    expect(clipLabel(textElement({ text: "HELLO" }))).toBe("HELLO");
  });

  it("uses the file name for media", () => {
    expect(clipLabel(videoElement({ localpath: "/a/b/clip.mp4" }))).toBe(
      "clip.mp4",
    );
  });

  it("falls back to the type when there is no path", () => {
    expect(clipLabel(imageElement({ localpath: "" }))).toBe("image");
  });
});

describe("canShowFilmstrip", () => {
  it("is true for the types that have frames to show", () => {
    expect(canShowFilmstrip(videoElement({}))).toBe(true);
    expect(canShowFilmstrip(imageElement({}))).toBe(true);
  });

  it("is false for audio and text", () => {
    expect(canShowFilmstrip(audioElement({}))).toBe(false);
    expect(canShowFilmstrip(textElement({}))).toBe(false);
  });
});

describe("drawTimeline", () => {
  it("fills the background before anything else", () => {
    const { canvas } = paint(doc({}));
    // Below the last row there is only background.
    expect(pixel(canvas, 200, 190)).toMatchObject({ r: 0x17, g: 0x18, b: 0x1c });
  });

  it("paints a row band across the full width", () => {
    const { canvas } = paint(doc({}));
    expect(pixel(canvas, 350, 10)).toMatchObject({ r: 0x1e, g: 0x1f, b: 0x25 });
  });

  it("paints a clip in its own colour", () => {
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      }),
    );
    // Below the label scrim, inside the clip.
    expect(pixel(canvas, 90, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("stops the clip at its trimmed edge", () => {
    // 4000ms at 45px/s is 180px wide.
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      }),
    );
    expect(pixel(canvas, 175, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 185, 30)).not.toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("draws two clips on one row side by side with a gap between", () => {
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 2000,
          timelineOptions: { color: "#ff0000" },
        }),
        b: imageElement({
          trackId: "v1",
          startTime: 4000,
          duration: 2000,
          timelineOptions: { color: "#00ff00" },
        }),
      }),
    );
    // "a" spans 0..90px, the gap runs 90..180, "b" spans 180..270.
    expect(pixel(canvas, 45, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 220, 30)).toMatchObject({ r: 0, g: 255, b: 0 });
    // The gap between them shows the row, not a clip.
    expect(pixel(canvas, 130, 30)).toMatchObject({ r: 0x1e, g: 0x1f, b: 0x25 });
  });

  it("draws adjacent halves of a split with no gap and no overlap", () => {
    const { canvas } = paint(
      doc({
        left: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 2000,
          timelineOptions: { color: "#ff0000" },
        }),
        right: imageElement({
          trackId: "v1",
          startTime: 2000,
          duration: 2000,
          timelineOptions: { color: "#00ff00" },
        }),
      }),
    );
    // 2000ms == 90px. Either side of the seam is a different clip, and neither
    // is the row background.
    expect(pixel(canvas, 88, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 92, 30)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("puts a clip on the second track lower down", () => {
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v2",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      }),
    );
    expect(pixel(canvas, 90, 30)).not.toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 90, TRACK_PITCH + 30)).toMatchObject({
      r: 255,
      g: 0,
      b: 0,
    });
  });

  it("outlines a selected clip on all four sides", () => {
    const d = doc({
      a: imageElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        timelineOptions: { color: "#ff0000" },
      }),
    });
    // Park the playhead off the clip: it is drawn last and 2px wide, so at its
    // default of 0ms it sits exactly on the left-hand border being asserted.
    const { canvas } = paint(d, { selection: ["a"], playheadMs: 90_000 });

    expect(pixel(canvas, 90, 0)).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(pixel(canvas, 90, TRACK_HEIGHT - 1)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(pixel(canvas, 0, 20)).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(pixel(canvas, 179, 20)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("leaves an unselected clip unoutlined", () => {
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      }),
    );
    expect(pixel(canvas, 90, 0)).not.toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("draws the playhead over the clips", () => {
    const { canvas } = paint(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      }),
      { playheadMs: 2000 },
    );
    expect(pixel(canvas, 90, 30)).toMatchObject({
      r: 0xdb,
      g: 0xda,
      b: 0xf0,
    });
  });

  it("draws the project-end marker", () => {
    const { canvas } = paint(doc({}), { projectEndMs: 4000 });
    expect(pixel(canvas, 180, 30)).toMatchObject({ r: 0xff, g: 0x17, b: 0x3e });
  });

  it("draws a snap guide only when there is one", () => {
    const withGuide = paint(doc({}), { snapGuideMs: 2000 });
    expect(pixel(withGuide.canvas, 90, 30)).toMatchObject({
      r: 0xff,
      g: 0xd4,
      b: 0x00,
    });

    // `isGuide` was computed on every snap and never drawn before this.
    const without = paint(doc({}), { snapGuideMs: null });
    expect(pixel(without.canvas, 90, 30)).not.toMatchObject({
      r: 0xff,
      g: 0xd4,
      b: 0x00,
    });
  });

  it("survives a clip whose element has gone missing", () => {
    const d = doc({
      a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
    });
    const layout = layoutTimeline({
      doc: d,
      range: RANGE,
      hScroll: 0,
      vScroll: 0,
      viewportW: W,
      viewportH: H,
      topOffset: 0,
    });
    const stale = { ...d, elements: {} };
    const { ctx } = scene(W, H);

    expect(() =>
      drawTimeline(ctx, {
        layout,
        doc: stale,
        range: RANGE,
        hScroll: 0,
        viewportW: W,
        viewportH: H,
        selection: [],
        playheadMs: 0,
        projectEndMs: 100_000,
      }),
    ).not.toThrow();
  });
});

describe("drawTimeline filmstrip", () => {
  const filmDoc = () =>
    doc({
      a: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        localpath: "/clip.mp4",
        timelineOptions: { color: "#0000ff" },
      }),
    });

  it("draws tiles the provider has", () => {
    const { canvas } = paint(filmDoc(), {
      provider: solidProvider("#ff0000"),
    });
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("falls back to the flat colour when the provider has nothing", () => {
    // A miss must leave a usable clip, not a hole — this is the normal state
    // while frames are still decoding.
    const { canvas } = paint(filmDoc(), { provider: nullTileProvider });
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("clips tiles to the clip, so a wide tile does not spill over", () => {
    // The last tile of a strip is almost always cut off mid-frame.
    const { canvas } = paint(
      doc({
        a: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 1000,
          localpath: "/clip.mp4",
          timelineOptions: { color: "#0000ff" },
        }),
      }),
      { provider: solidProvider("#ff0000") },
    );
    // The clip is 45px wide; a tile is ~71px. Nothing red past 45.
    expect(pixel(canvas, 40, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 50, 30)).not.toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("requests the frames it is missing, keyed by source position", () => {
    const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    paint(filmDoc(), { provider });

    expect(provider.request).toHaveBeenCalled();
    const first = (provider.request as any).mock.calls[0][0];
    expect(first.localpath).toBe("/clip.mp4");
    expect(first.key).toContain("/clip.mp4|");
    expect(first.tileH).toBe(TRACK_HEIGHT);
    expect(first.tileW).toBeGreaterThan(0);
  });

  it("does not re-request a frame it already has", () => {
    const provider: TileProvider = {
      get: vi.fn(() => solid(80, TRACK_HEIGHT, "#ff0000") as any),
      request: vi.fn(),
    };
    paint(filmDoc(), { provider });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("asks for distinct frames along the strip, not the same one twice", () => {
    // A quantum coarser than the tile spacing used to round neighbouring tiles
    // onto one instant, so the strip repeated a frame instead of advancing.
    const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    paint(filmDoc(), { provider });

    const keys = (provider.request as any).mock.calls.map((c: any[]) => c[0].key);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never asks the provider about audio or text", () => {
    const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    paint(
      doc({
        a: audioElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        t: textElement({ trackId: "v2", startTime: 0, duration: 4000 }),
      }),
      { provider },
    );
    expect(provider.get).not.toHaveBeenCalled();
  });
});

describe("drawTimeline waveform", () => {
  /** Peaks at a constant level, covering 10s of source. */
  function loudPeaks(level = 0.9): PeakData {
    const buckets = 500;
    const peaks = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      peaks[i * 2] = -level;
      peaks[i * 2 + 1] = level;
    }
    return { peaks, bucketMs: 20, durationMs: buckets * 20 };
  }

  const audioDoc = () =>
    doc({
      a: audioElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        localpath: "/song.mp3",
        timelineOptions: { color: "#000080" },
      }),
    });

  it("draws a trace when the peaks are decoded", () => {
    const peaks: PeakProvider = { get: () => loudPeaks(), request: vi.fn() };
    const { canvas } = paint(audioDoc(), { peaks });

    // A loud signal reaches most of the way to the row's edges.
    expect(pixel(canvas, 50, TRACK_HEIGHT - 3).r).toBeGreaterThan(100);
  });

  it("requests the file when it has no peaks yet", () => {
    const peaks: PeakProvider = { get: () => null, request: vi.fn() };
    paint(audioDoc(), { peaks });
    expect(peaks.request).toHaveBeenCalledWith("/song.mp3");
  });

  it("leaves the flat colour showing while the decode is pending", () => {
    const { canvas } = paint(audioDoc(), {
      peaks: { get: () => null, request: vi.fn() },
    });
    expect(pixel(canvas, 50, 30)).toMatchObject({ r: 0, g: 0, b: 0x80 });
  });

  it("draws a quiet passage smaller than a loud one", () => {
    const quiet = paint(audioDoc(), {
      peaks: { get: () => loudPeaks(0.05), request: vi.fn() },
    });
    const loud = paint(audioDoc(), {
      peaks: { get: () => loudPeaks(0.95), request: vi.fn() },
    });

    const ink = (c: any) => {
      let count = 0;
      for (let y = 0; y < TRACK_HEIGHT; y++) {
        if (pixel(c, 50, y).r > 100) count++;
      }
      return count;
    };
    expect(ink(quiet.canvas)).toBeLessThan(ink(loud.canvas));
  });

  it("does not ask for a waveform for a silent video", () => {
    const peaks: PeakProvider = { get: () => null, request: vi.fn() };
    paint(
      doc({
        v: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          isExistAudio: false,
        }),
      }),
      { peaks },
    );
    expect(peaks.request).not.toHaveBeenCalled();
  });

  it("asks for one for a video that carries sound", () => {
    const peaks: PeakProvider = { get: () => null, request: vi.fn() };
    paint(
      doc({
        v: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          localpath: "/clip.mp4",
          isExistAudio: true,
        }),
      }),
      { peaks },
    );
    expect(peaks.request).toHaveBeenCalledWith("/clip.mp4");
  });

  it("does not ask for one for text", () => {
    const peaks: PeakProvider = { get: () => null, request: vi.fn() };
    paint(
      doc({ t: textElement({ trackId: "v1", startTime: 0, duration: 4000 }) }),
      { peaks },
    );
    expect(peaks.request).not.toHaveBeenCalled();
  });

  it("keeps the trace inside the clip", () => {
    const peaks: PeakProvider = { get: () => loudPeaks(1), request: vi.fn() };
    const { canvas } = paint(audioDoc(), { peaks });
    // The clip is 180px wide; nothing past it.
    expect(pixel(canvas, 190, 20).r).toBeLessThan(100);
  });
});

describe("how much of a clip the frames actually get", () => {
  /** Peaks at a constant level, covering 10s of source. */
  function loudPeaks(level = 0.9): PeakData {
    const buckets = 500;
    const peaks = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      peaks[i * 2] = -level;
      peaks[i * 2 + 1] = level;
    }
    return { peaks, bucketMs: 20, durationMs: buckets * 20 };
  }

  /** Rows at `x` showing the filmstrip's colour rather than a decoration. */
  function frameRows(canvas: any, x: number) {
    let rows = 0;
    for (let y = 0; y < TRACK_HEIGHT; y++) {
      const p = pixel(canvas, x, y);
      if (p.r > 200 && p.g < 80 && p.b < 80) {
        rows++;
      }
    }
    return rows;
  }

  const withSound = () =>
    doc({
      v: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        localpath: "/clip.mp4",
        isExistAudio: true,
        timelineOptions: { color: "#0000ff" },
      }),
    });

  it("leaves the top of the clip showing frames, not a black bar", () => {
    // The label used to sit on a 16px opaque strip — 40% of the row.
    const { canvas } = paint(withSound(), {
      provider: solidProvider("#ff0000"),
      peaks: { get: () => loudPeaks(), request: vi.fn() },
    });
    // Clear of the glyphs, still inside the label band.
    expect(pixel(canvas, 170, 3).r).toBeGreaterThan(200);
  });

  it("keeps a video's waveform to a thin trace", () => {
    // This is the assertion whose absence let an earlier check pass: it was
    // run on a silent clip, so no waveform band was drawn and the strip looked
    // fine. With sound, the label strip plus a 40%-height waveform left about
    // 8 of 40 rows showing frames.
    const { canvas } = paint(withSound(), {
      provider: solidProvider("#ff0000"),
      peaks: { get: () => loudPeaks(), request: vi.fn() },
    });
    expect(frameRows(canvas, 100)).toBeGreaterThanOrEqual(26);
  });

  it("gives a silent video essentially the whole clip", () => {
    const { canvas } = paint(
      doc({
        v: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          localpath: "/clip.mp4",
          isExistAudio: false,
          timelineOptions: { color: "#0000ff" },
        }),
      }),
      { provider: solidProvider("#ff0000") },
    );
    expect(frameRows(canvas, 100)).toBeGreaterThanOrEqual(36);
  });

  it("still draws the label legibly over a bright frame", () => {
    // The outline has to be doing its job now that there is no strip.
    const { canvas } = paint(withSound(), {
      provider: solidProvider("#ffffff"),
      peaks: { get: () => loudPeaks(), request: vi.fn() },
    });

    let dark = 0;
    for (let x = 6; x < 70; x++) {
      for (let y = 0; y < 16; y++) {
        if (pixel(canvas, x, y).r < 80) {
          dark++;
        }
      }
    }
    expect(dark).toBeGreaterThan(0);
  });

  it("gives a bare audio clip the full height", () => {
    const { canvas } = paint(
      doc({
        a: audioElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          localpath: "/song.mp3",
          timelineOptions: { color: "#000080" },
        }),
      }),
      { peaks: { get: () => loudPeaks(1), request: vi.fn() } },
    );
    // A full-scale signal reaches close to both edges of the row. Sampled
    // clear of the label, whose dark outline would otherwise be read as the
    // absence of a trace.
    expect(pixel(canvas, 150, 2).r).toBeGreaterThan(100);
    expect(pixel(canvas, 150, TRACK_HEIGHT - 3).r).toBeGreaterThan(100);
  });
});

describe("drawDropTarget", () => {
  it("highlights the row being dropped onto", () => {
    const d = doc({});
    const { canvas, ctx, layout } = paint(d);
    drawDropTarget(ctx, layout, "v2", W, "#ffffff");
    expect(pixel(canvas, 200, TRACK_PITCH + 10)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("does nothing for a track that is not laid out", () => {
    const { ctx, layout } = paint(doc({}));
    expect(() => drawDropTarget(ctx, layout, "nope", W)).not.toThrow();
  });
});

// ===================================================== keyframe diamonds

import { drawKeyframeLane } from "./draw";
import {
  KEYFRAME_LANE_PX,
  KEYFRAME_SIZE_PX,
  keyframeLane,
} from "./keyframeMarkers";
import { bakeTrack } from "../animation/keyframes";
import { audioElement, keys } from "../renderer/testing";

describe("keyframe diamonds", () => {
  /** An image clip with opacity keyed at the given element-relative times. */
  function keyed(times: number[], over: Record<string, any> = {}) {
    const authored = keys(...times.map((t) => [t, 50] as [number, number]));
    const base = imageElement();
    return imageElement({
      trackId: "v1",
      startTime: 0,
      duration: 4000,
      timelineOptions: { color: "#0000ff" },
      animation: {
        ...(base.animation as any),
        opacity: { isActivate: true, x: authored, ax: bakeTrack(authored) },
      } as any,
      ...over,
    });
  }

  /** The lane's vertical centre for a clip on the first row at topOffset 0. */
  const laneCenterY = TRACK_HEIGHT - KEYFRAME_LANE_PX / 2;

  /**
   * Paint with the playhead parked off-canvas.
   *
   * The playhead is `#dbdaf0` and the diamonds `#d7dce3` — near enough that a
   * "is this pixel light" test cannot tell them apart, and it defaults to x=0
   * where a keyframe at t=0 also lands. Moving it aside keeps these assertions
   * about diamonds.
   */
  const paintKf = (
    d: TimelineDocument,
    over: Partial<Parameters<typeof drawTimeline>[1]> = {},
  ) => paint(d, { playheadMs: -999_999, ...over });

  /** Whether a pixel is the diamond colour rather than the clip or the plate. */
  function isDiamond(canvas: any, x: number, y: number) {
    const p = pixel(canvas, x, y);
    return p.r > 180 && p.g > 180 && p.b > 180;
  }

  it("marks each keyframe at its own time", () => {
    // 45px per second at range 0.9, so 0ms / 1000ms / 2000ms land at 0 / 45 / 90.
    const { canvas } = paintKf(doc({ a: keyed([0, 1000, 2000]) }));
    expect(isDiamond(canvas, 0, laneCenterY)).toBe(true);
    expect(isDiamond(canvas, 45, laneCenterY)).toBe(true);
    expect(isDiamond(canvas, 90, laneCenterY)).toBe(true);
    // And nothing between them.
    expect(isDiamond(canvas, 22, laneCenterY)).toBe(false);
    expect(isDiamond(canvas, 67, laneCenterY)).toBe(false);
  });

  it("draws nothing for a clip with no keyframes", () => {
    // A dark clip colour, so "is this pixel the diamond" is not confused by the
    // default white element fill.
    const { canvas } = paintKf(
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#0000ff" },
        }),
      }),
    );
    for (let x = 0; x < 180; x += 5) {
      expect(isDiamond(canvas, x, laneCenterY)).toBe(false);
    }
  });

  it("draws nothing when the track is switched off", () => {
    const off = keyed([0, 1000]);
    (off as any).animation.opacity.isActivate = false;
    const { canvas } = paintKf(doc({ a: off }));
    expect(isDiamond(canvas, 45, laneCenterY)).toBe(false);
  });

  /**
   * A diamond, not a square: its widest row is the middle one.
   */
  it("is diamond-shaped", () => {
    const { canvas } = paintKf(doc({ a: keyed([1000]) }));

    const runAt = (y: number) => {
      let lit = 0;
      for (let x = 30; x < 62; x++) {
        if (isDiamond(canvas, x, y)) lit++;
      }
      return lit;
    };

    const middle = runAt(laneCenterY);
    const above = runAt(laneCenterY - 2);
    const below = runAt(laneCenterY + 2);

    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeGreaterThan(above);
    expect(middle).toBeGreaterThan(below);
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it("is about the size it says it is", () => {
    const { canvas } = paintKf(doc({ a: keyed([1000]) }));
    let minX = Infinity;
    let maxX = -Infinity;
    for (let x = 20; x < 70; x++) {
      if (isDiamond(canvas, x, laneCenterY)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    expect(maxX - minX + 1).toBeLessThanOrEqual(KEYFRAME_SIZE_PX + 1);
    expect(maxX - minX + 1).toBeGreaterThanOrEqual(KEYFRAME_SIZE_PX - 2);
  });

  it("sits in the lane, not over the label", () => {
    const { canvas } = paintKf(doc({ a: keyed([1000]) }));
    // The label band at the top of the clip is untouched.
    for (let y = 0; y < TRACK_HEIGHT - KEYFRAME_LANE_PX - 1; y++) {
      expect(isDiamond(canvas, 45, y)).toBe(false);
    }
  });

  it("is cut at the clip's edge rather than spilling onto the neighbour", () => {
    // A keyframe on the very last frame of a clip. Half the diamond is outside
    // the clip box, and the clip path has to remove it.
    const d = doc({
      a: keyed([4000]),
      b: imageElement({
        trackId: "v1",
        startTime: 4000,
        duration: 4000,
        timelineOptions: { color: "#0000ff" },
      }),
    });
    const { canvas, layout } = paintKf(d);
    const edge = layout.clips.find((c) => c.elementId === "a")!;
    const boundary = Math.round(edge.x + edge.w);
    for (let x = boundary + 1; x < boundary + 5; x++) {
      expect(isDiamond(canvas, x, laneCenterY)).toBe(false);
    }
  });

  it("leaves the selection border unbroken over a marker", () => {
    // Selection is the stronger signal; its 2px frame wins.
    const { canvas } = paintKf(doc({ a: keyed([0, 1000, 2000]) }), {
      selection: ["a"],
    });
    const p = pixel(canvas, 45, TRACK_HEIGHT - 1);
    expect(p).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("merges keyframes too close together into one marker", () => {
    const { canvas } = paintKf(doc({ a: keyed([1000, 1001, 1002]) }));
    let lit = 0;
    for (let x = 30; x < 62; x++) {
      if (isDiamond(canvas, x, laneCenterY)) lit++;
    }
    // One diamond's worth of pixels, not three overlapping smears.
    expect(lit).toBeLessThanOrEqual(KEYFRAME_SIZE_PX + 1);
  });

  /** A full-scale waveform, as the block above builds one. */
  function loudTrack(level = 1) {
    const buckets = 200;
    const peaks = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      peaks[i * 2] = -level;
      peaks[i * 2 + 1] = level;
    }
    return { peaks, bucketMs: 20, durationMs: buckets * 20 };
  }

  /** Rows at `x` showing the filmstrip's colour rather than a decoration. */
  function framePixelRows(canvas: any, x: number) {
    let rows = 0;
    for (let y = 0; y < TRACK_HEIGHT; y++) {
      const p = pixel(canvas, x, y);
      if (p.r > 200 && p.g < 80 && p.b < 80) rows++;
    }
    return rows;
  }

  it("gives an animated video's waveform room without taking the frames", () => {
    // With no keyframes this clip keeps its existing budget (>= 26 frame rows,
    // pinned above). The lane costs it 8 more, and no more than that.
    const authored = keys([0, 0], [2000, 100]);
    const base = videoElement();
    const d = doc({
      v: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        localpath: "/clip.mp4",
        isExistAudio: true,
        timelineOptions: { color: "#0000ff" },
        animation: {
          ...(base.animation as any),
          opacity: { isActivate: true, x: authored, ax: bakeTrack(authored) },
        } as any,
      }),
    });

    const { canvas } = paintKf(d, {
      provider: solidProvider("#ff0000"),
      peaks: { get: () => loudTrack(), request: vi.fn() },
    });
    expect(framePixelRows(canvas, 100)).toBeGreaterThanOrEqual(18);
  });

  it("keeps a bare audio clip's full-height waveform", () => {
    // Audio carries no animation block, so it never gets a lane and never
    // loses any of its row.
    const d = doc({
      a: audioElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        localpath: "/clip.mp3",
      }),
    });
    expect(
      keyframeLane(
        { elementId: "a", trackId: "v1", x: 0, y: 0, w: 180, h: TRACK_HEIGHT },
        d.elements.a,
      ),
    ).toBeNull();
  });

  it("paints 200 clips of 300 keyframes each without stalling", () => {
    // Two fills per clip regardless of keyframe count is what makes this cheap.
    const elements: Record<string, any> = {};
    const times = Array.from({ length: 300 }, (_, i) => i * 13);
    for (let i = 0; i < 200; i++) {
      elements[`e${i}`] = keyed(times, {
        startTime: i * 4000,
        trackId: i % 2 === 0 ? "v1" : "v2",
      });
    }

    const start = Date.now();
    paintKf(doc(elements));
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("draws nothing when asked directly for a clip with no lane", () => {
    const { ctx } = scene(W, H);
    expect(() =>
      drawKeyframeLane(
        ctx,
        { elementId: "a", trackId: "v1", x: 0, y: 0, w: 180, h: 8 },
        imageElement(),
        { colors: defaultColors, range: RANGE },
      ),
    ).not.toThrow();
  });
});
