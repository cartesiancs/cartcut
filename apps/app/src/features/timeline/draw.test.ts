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
