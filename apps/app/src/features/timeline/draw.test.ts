import { describe, it, expect, vi } from "vitest";
import {
  canShowFilmstrip,
  canShowFrameGrid,
  canShowWaveform,
  clipLabel,
  defaultColors,
  drawDropTarget,
  drawTimeline,
  HIDDEN_CLIP_ALPHA,
  truncateText,
} from "./draw";
import { layoutTimeline, TRACK_HEIGHT, TRACK_PITCH } from "./layout";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  setTrackHidden,
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

function paint(
  d: TimelineDocument,
  over: Partial<Parameters<typeof drawTimeline>[1]> = {},
  topOffset = 0,
  heights: Record<string, number> = {},
) {
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
    // The selection ring's tests move the row down, so there is canvas above
    // the clip to show the ring stopping at its edge.
    topOffset,
    heights,
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

/** `#rrggbb` as the channels `pixel` reports. */
function rgbOf(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
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

  it("folds a multi-line text clip onto one line", () => {
    // The label is a single `fillText` on the clip bar: a `\n` would not be
    // drawn at all, and `truncateText` would still be measuring it.
    expect(clipLabel(textElement({ text: "TOP\nBOTTOM" }))).toBe("TOP BOTTOM");
    expect(clipLabel(textElement({ text: "A\r\nB" }))).toBe("A B");
    expect(clipLabel(textElement({ text: "A\n\nB" }))).toBe("A B");
    // The spaces around the break go with it, so no double gap appears.
    expect(clipLabel(textElement({ text: "A \n B" }))).toBe("A B");
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

describe("canShowWaveform", () => {
  it("is true for the clips that make a sound", () => {
    expect(canShowWaveform(audioElement({}))).toBe(true);
    expect(canShowWaveform(videoElement({ isExistAudio: true }))).toBe(true);
  });

  it("is false for a video with no audio stream", () => {
    expect(canShowWaveform(videoElement({ isExistAudio: false }))).toBe(false);
  });

  it("is false once the video's audio has been detached", () => {
    // The trace moves to the audio clip that now carries the sound; drawing it
    // in both places would show one audio track twice.
    expect(
      canShowWaveform(
        videoElement({ isExistAudio: true, audioDetached: true }),
      ),
    ).toBe(false);
  });

  it("is false for clips with no sound at all", () => {
    expect(canShowWaveform(imageElement({}))).toBe(false);
    expect(canShowWaveform(textElement({}))).toBe(false);
  });
});

describe("drawTimeline", () => {
  it("fills the background before anything else", () => {
    const { canvas } = paint(doc({}));
    // Below the last row there is only background.
    expect(pixel(canvas, 200, 190)).toMatchObject({ r: 0x0f, g: 0x10, b: 0x12 });
  });

  it("paints a row band across the full width", () => {
    const { canvas } = paint(doc({}));
    expect(pixel(canvas, 350, 10)).toMatchObject({ r: 0x17, g: 0x18, b: 0x1c });
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
    expect(pixel(canvas, 130, 30)).toMatchObject({ r: 0x17, g: 0x18, b: 0x1c });
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

  describe("the selection ring", () => {
    // 1000..5000ms at 45px/s is x 45..225, and the row starts at y 8, so there
    // is canvas on every side of the clip to show what the ring leaves alone.
    const ringed = () =>
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 1000,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
        }),
      });
    const TOP = 8;
    const RING = rgbOf(defaultColors.selection);
    const GAP = rgbOf(defaultColors.background);
    const RED = { r: 255, g: 0, b: 0 };
    // Park the playhead off the clip: it is drawn last and 2px wide.
    const paintRinged = (selection: string[]) =>
      paint(ringed(), { selection, playheadMs: 90_000 }, TOP);

    it("rings a selected clip on all four sides, on its own edge", () => {
      const { canvas, layout } = paintRinged(["a"]);
      const r = layout.clips[0];
      const midX = r.x + r.w / 2;
      const midY = r.y + r.h / 2;

      // The first and last pixel of the clip in each direction.
      expect(pixel(canvas, midX, r.y)).toMatchObject(RING);
      expect(pixel(canvas, midX, r.y + r.h - 1)).toMatchObject(RING);
      expect(pixel(canvas, r.x, midY)).toMatchObject(RING);
      expect(pixel(canvas, r.x + r.w - 1, midY)).toMatchObject(RING);
    });

    it("starts and ends exactly where the clip does", () => {
      // The reason it is inside: a ring outside the clip marks a span three
      // pixels wider than the clip on each side.
      const { canvas, layout } = paintRinged(["a"]);
      const r = layout.clips[0];
      const midX = r.x + r.w / 2;
      const midY = r.y + r.h / 2;

      expect(pixel(canvas, r.x - 1, midY)).not.toMatchObject(RING);
      expect(pixel(canvas, r.x + r.w, midY)).not.toMatchObject(RING);
      expect(pixel(canvas, midX, r.y - 1)).not.toMatchObject(RING);
      expect(pixel(canvas, midX, r.y + r.h)).not.toMatchObject(RING);
    });

    it("keeps a dark pixel between the ring and the frames", () => {
      const { canvas, layout } = paintRinged(["a"]);
      const r = layout.clips[0];
      const midX = r.x + r.w / 2;
      const midY = r.y + r.h / 2;

      expect(pixel(canvas, midX, r.y + 2)).toMatchObject(GAP);
      expect(pixel(canvas, midX, r.y + r.h - 3)).toMatchObject(GAP);
      expect(pixel(canvas, r.x + 2, midY)).toMatchObject(GAP);
      expect(pixel(canvas, r.x + r.w - 3, midY)).toMatchObject(GAP);
      // And past it, the clip.
      expect(pixel(canvas, r.x + 3, midY)).toMatchObject(RED);
    });

    it("is absent on an unselected clip", () => {
      const { canvas, layout } = paintRinged([]);
      const r = layout.clips[0];
      expect(pixel(canvas, r.x + r.w / 2, r.y)).not.toMatchObject(RING);
      expect(pixel(canvas, r.x, r.y + r.h / 2)).not.toMatchObject(RING);
      expect(pixel(canvas, r.x + 2, r.y + r.h / 2)).toMatchObject(RED);
    });

    it("leaves an abutting neighbour alone", () => {
      const { canvas, layout } = paint(
        doc({
          a: imageElement({
            trackId: "v1",
            startTime: 0,
            duration: 2000,
            timelineOptions: { color: "#ff0000" },
          }),
          b: imageElement({
            trackId: "v1",
            startTime: 2000,
            duration: 2000,
            timelineOptions: { color: "#00ff00" },
          }),
        }),
        { selection: ["a"], playheadMs: 90_000 },
      );
      const a = layout.clips.find((c) => c.elementId === "a")!;
      const seam = a.x + a.w;
      expect(pixel(canvas, seam - 1, 20)).toMatchObject(RING);
      // The neighbour's first column is its hairline over green, not the ring.
      expect(pixel(canvas, seam, 20)).not.toMatchObject(RING);
      expect(pixel(canvas, seam + 1, 20)).toMatchObject({ r: 0, g: 255, b: 0 });
    });

    it("still marks a sliver narrower than the ring and its gap", () => {
      // 100ms is 4.5px: no room for the gap, so the ring covers it.
      const { canvas } = paint(
        doc({
          a: imageElement({
            trackId: "v1",
            startTime: 1000,
            duration: 100,
            timelineOptions: { color: "#ff0000" },
          }),
        }),
        { selection: ["a"], playheadMs: 90_000 },
      );
      expect(pixel(canvas, 47, 20)).toMatchObject(RING);
    });
  });

  describe("the clip body", () => {
    const red = (over: Record<string, any> = {}) =>
      doc({
        a: imageElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          timelineOptions: { color: "#ff0000" },
          ...over,
        }),
      });
    const ROW = { r: 0x17, g: 0x18, b: 0x1c };

    it("rounds its corners", () => {
      const { canvas } = paint(red(), { playheadMs: 90_000 });
      // The corner pixel is outside the curve and shows the row.
      expect(pixel(canvas, 0, 0)).toMatchObject(ROW);
      expect(pixel(canvas, 0, TRACK_HEIGHT - 1)).toMatchObject(ROW);
      // Away from the corners the fill reaches the edge.
      expect(pixel(canvas, 0, 20).r).toBe(255);
      expect(pixel(canvas, 90, 0).r).toBe(255);
    });

    it("still paints a sliver narrower than two radii", () => {
      // 100ms is 4.5px: the radius clamps to a pill instead of vanishing.
      const { canvas } = paint(red({ duration: 100 }), { playheadMs: 90_000 });
      expect(pixel(canvas, 2, 20)).toMatchObject({ r: 255, g: 0, b: 0 });
    });

    it("draws a hairline inside its edge", () => {
      const { canvas } = paint(red(), { playheadMs: 90_000 });
      // `clipBorder` over red lifts green and blue; one pixel further in is
      // the bare fill.
      expect(pixel(canvas, 90, TRACK_HEIGHT - 1).g).toBeGreaterThan(0);
      expect(pixel(canvas, 90, TRACK_HEIGHT - 2)).toMatchObject({ r: 255, g: 0, b: 0 });
    });

    /** Label-band pixels darker than the fill: the halo, if there is one. */
    function haloPixels(canvas: any) {
      let dark = 0;
      for (let x = 8; x < 70; x++) {
        for (let y = 3; y < 18; y++) {
          if (pixel(canvas, x, y).r < 200) dark++;
        }
      }
      return dark;
    }

    it("letters a flat bar without a halo", () => {
      const { canvas } = paint(
        doc({
          t: textElement({
            trackId: "v1",
            startTime: 0,
            duration: 4000,
            text: "Title",
            timelineOptions: { color: "#ff0000" },
          }),
        }),
        { playheadMs: 90_000 },
      );
      expect(haloPixels(canvas)).toBe(0);
      // And the label is really there: white glyphs lift green over red.
      let lit = 0;
      for (let x = 8; x < 70; x++) {
        for (let y = 3; y < 18; y++) {
          if (pixel(canvas, x, y).g > 100) lit++;
        }
      }
      expect(lit).toBeGreaterThan(0);
    });

    it("keeps the halo where frames sit behind the label", () => {
      // Same fill, same label length, but a type that shows a filmstrip.
      const { canvas } = paint(red({ localpath: "file:///Title" }), {
        playheadMs: 90_000,
      });
      expect(haloPixels(canvas)).toBeGreaterThan(0);
    });
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

  it("decodes a resized row's tiles at the next rung up, keyed by the rung", () => {
    const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    paint(filmDoc(), { provider });
    const atDefault = (provider.request as any).mock.calls[0][0];

    const tall: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    paint(filmDoc(), { provider: tall }, 0, { v1: 81 });
    const at81 = (tall.request as any).mock.calls[0][0];

    expect(at81.tileH).toBe(112);
    expect(at81.key.endsWith("|112")).toBe(true);
    // Wider in proportion: the aspect is kept at the rung, not at 81.
    expect(
      Math.abs(at81.tileW - (atDefault.tileW * 112) / TRACK_HEIGHT),
    ).toBeLessThanOrEqual(1);
  });

  it("asks for one height at every row height that shares a rung", () => {
    // What keeps a resize drag from queuing a decode per pixel. The frames a
    // plan names can change with the tile width; the height part cannot.
    for (const h of [57, 66, 80]) {
      const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
      paint(filmDoc(), { provider }, 0, { v1: h });
      const calls = (provider.request as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [request] of calls) {
        expect(request.tileH).toBe(80);
        expect(request.key.endsWith("|80")).toBe(true);
      }
    }
  });

  it("draws the frame from another rung while the right one decodes", () => {
    // Only the default rung is held. The row is 81 tall, so the exact key
    // (rung 112) misses and the 40px decode of the same frame stands in.
    const tile = solid(80, TRACK_HEIGHT, "#ff0000");
    const provider: TileProvider = {
      get: vi.fn((key: string) => (key.endsWith("|40") ? (tile as any) : null)),
      request: vi.fn(),
    };
    const { canvas } = paint(filmDoc(), { provider }, 0, { v1: 81 });
    expect(provider.request).toHaveBeenCalled();
    // Scaled to the row: red near the bottom of the 81px row too.
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 30, 70)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("shows flat colour when no rung holds the frame", () => {
    // The control for the case above: the same row, with the frame held at
    // no rung at all.
    const provider: TileProvider = { get: vi.fn(() => null), request: vi.fn() };
    const { canvas } = paint(filmDoc(), { provider }, 0, { v1: 81 });
    expect(pixel(canvas, 30, 70)).toMatchObject({ r: 0, g: 0, b: 255 });
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

describe("a detached pair drawn together", () => {
  const buckets = 500;

  function loud(): PeakData {
    const peaks = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      peaks[i * 2] = -0.9;
      peaks[i * 2 + 1] = 0.9;
    }
    return { peaks, bucketMs: 20, durationMs: buckets * 20 };
  }

  /** A silenced video on row 0 and the audio clip that took its sound on row 1. */
  function detachedDoc(): TimelineDocument {
    const shared = {
      startTime: 0,
      duration: 4000,
      localpath: "/clip.mp4",
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: 10_000,
    };
    return normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
      elements: {
        v: videoElement({
          ...shared,
          trackId: "v1",
          isExistAudio: true,
          audioDetached: true,
          timelineOptions: { color: "#000080" },
        }),
        a: audioElement({
          ...shared,
          trackId: "a1",
          timelineOptions: { color: "#008000" },
        }),
      },
    });
  }

  it("draws the waveform on the audio clip", () => {
    const { canvas } = paint(detachedDoc(), {
      peaks: { get: () => loud(), request: vi.fn() },
    });
    // Row 1, near its bottom edge: a loud signal reaches most of the way out.
    expect(
      pixel(canvas, 50, TRACK_PITCH + TRACK_HEIGHT - 3).r,
    ).toBeGreaterThan(100);
  });

  it("leaves the silenced video showing its flat colour", () => {
    // Where the 10px waveform band used to sit. Two waveforms for one audio
    // track is what this whole flag exists to prevent.
    const { canvas } = paint(detachedDoc(), {
      peaks: { get: () => loud(), request: vi.fn() },
    });
    expect(pixel(canvas, 50, TRACK_HEIGHT - 4)).toMatchObject({
      r: 0,
      g: 0,
      b: 0x80,
    });
  });

  it("decodes the shared file once, not twice", () => {
    // Both clips name the same mp4. The provider dedupes by path anyway, but
    // asking twice per frame would mean the video is still claiming the sound.
    const request = vi.fn();
    paint(detachedDoc(), { peaks: { get: () => null, request } });
    expect(request.mock.calls).toEqual([["/clip.mp4"]]);
  });

  it("still draws both clips", () => {
    // The cheapest guard against the change blanking a row outright.
    //
    // Sampled at y+32 rather than y+20 because both of these clips are
    // audible, so both carry a level line, and on a 40px row an untouched
    // clip's line sits at about y+21. The probe wants the clip's own fill.
    const { canvas } = paint(detachedDoc(), {
      peaks: { get: () => null, request: vi.fn() },
    });
    expect(pixel(canvas, 50, 32)).toMatchObject({ r: 0, g: 0, b: 0x80 });
    expect(pixel(canvas, 50, TRACK_PITCH + 32)).toMatchObject({
      r: 0,
      g: 0x80,
      b: 0,
    });
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

  it("stops asking once the clip's audio has been detached", () => {
    // The waveform follows the sound. A detached clip keeps drawing its own
    // trace *and* the new audio clip draws one, which reads as two copies of
    // an audio track that only exists once.
    const peaks: PeakProvider = { get: () => null, request: vi.fn() };
    paint(
      doc({
        v: videoElement({
          trackId: "v1",
          startTime: 0,
          duration: 4000,
          localpath: "/clip.mp4",
          isExistAudio: true,
          audioDetached: true,
        }),
      }),
      { peaks },
    );
    expect(peaks.request).not.toHaveBeenCalled();
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
import { keys } from "../renderer/testing";

describe("keyframe diamonds", () => {
  /** An image clip with opacity keyed at the given element-relative times. */
  function keyed(times: number[], over: Record<string, any> = {}) {
    const authored = keys(...times.map((t) => [t, 50] as [number, number]));
    const base = imageElement();
    return imageElement({
      trackId: "v1",
      startTime: 0,
      duration: 4000,
      // Same problem the playhead note below describes: `isDiamond` is really
      // "is this pixel light", and the clip label is light too. The label is
      // the localpath's basename, so pinning a short one here keeps these
      // assertions about diamonds rather than about how long the shared
      // fixture's filename happens to be.
      localpath: "file:///a.png",
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
    // The one at 0ms sits on the rounded corner, which cuts its outer half;
    // its inner half is still there.
    expect(isDiamond(canvas, 1, laneCenterY)).toBe(true);
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

  it("leaves the selection ring unbroken over a marker", () => {
    // Selection is the stronger signal; its ring wins, and the diamond's
    // centre is still clear of it.
    const { canvas } = paintKf(doc({ a: keyed([0, 1000, 2000]) }), {
      selection: ["a"],
    });
    expect(pixel(canvas, 45, TRACK_HEIGHT - 1)).toMatchObject(
      rgbOf(defaultColors.selection),
    );
    expect(isDiamond(canvas, 45, laneCenterY)).toBe(true);
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

// ---------------------------------------------------------------- frame grid

/**
 * A zoom and frame rate chosen to make the lattice land on whole pixels:
 * `framePx = msToPxSigned(1000 / 10, 2) = 10`. Frame `n` sits at `x = 10n`, so
 * every assertion below can name a column instead of computing one.
 */
const GRID_RANGE = 2;
const GRID_FPS = 10;
const GRID_CELL_PX = 10;

/** Dark, so the translucent white lattice actually changes a pixel. */
const DARK = "#000000";

/**
 * The theme without the clip's edge hairline.
 *
 * The hairline is a light 1px line on the clip's edge over a black fill, which
 * is exactly what `isGridInk` looks for; the edge tests here are about the
 * lattice not doubling the boundary, and the hairline has its own test above.
 */
const GRID_COLORS = { ...defaultColors, clipBorder: "rgba(0, 0, 0, 0)" };

function gridPaint(
  d: TimelineDocument,
  over: Partial<Parameters<typeof drawTimeline>[1]> = {},
) {
  const hScroll = (over.hScroll as number) ?? 0;
  const { canvas, ctx } = scene(W, H);
  const layout = layoutTimeline({
    doc: d,
    range: GRID_RANGE,
    hScroll,
    vScroll: 0,
    viewportW: W,
    viewportH: H,
    topOffset: 0,
  });

  drawTimeline(ctx, {
    layout,
    doc: d,
    range: GRID_RANGE,
    hScroll,
    viewportW: W,
    viewportH: H,
    selection: [],
    playheadMs: -1000,
    projectEndMs: 100_000,
    colors: GRID_COLORS,
    fps: GRID_FPS,
    frameGrid: true,
    ...over,
  });

  return { canvas, ctx, layout };
}

/**
 * Low in the row, below the label.
 *
 * The label's halo is `rgba(0,0,0,0.85)` and it sits across the top ~16px, so a
 * probe up there reads a grid line darkened by however much glyph happens to be
 * over it — 20 instead of 33, and not uniformly.
 */
const ROW_Y = 30;

/**
 * Whether the lattice painted this column.
 *
 * `rgba(255,255,255,0.13)` over a black clip is exactly 33 grey. The bare clip
 * is 0, also grey; the row background is `#17181c`, which is *not* grey. Testing
 * for "grey and lit" separates all three without a magic range.
 */
function isGridInk(canvas: any, x: number): boolean {
  const { r, g, b } = pixel(canvas, x, ROW_Y);
  return r === g && g === b && r > 10;
}

describe("canShowFrameGrid", () => {
  it("accepts picture and nothing else", () => {
    expect(canShowFrameGrid(videoElement())).toBe(true);
    expect(canShowFrameGrid(imageElement())).toBe(true);
    expect(canShowFrameGrid(audioElement())).toBe(false);
    expect(canShowFrameGrid(textElement())).toBe(false);
  });
});

describe("drawTimeline — frame grid", () => {
  const picture = (over: Record<string, any> = {}) =>
    imageElement({
      trackId: "v1",
      startTime: 0,
      duration: 2000,
      timelineOptions: { color: DARK },
      ...over,
    });

  it("is absent unless asked for", () => {
    const { canvas } = gridPaint(doc({ a: picture() }), { frameGrid: false });
    for (const x of [10, 20, 30]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }
  });

  it("rules the clip off at every frame", () => {
    const { canvas } = gridPaint(doc({ a: picture() }));
    for (const x of [10, 20, 30, 100, 190]) {
      expect(isGridInk(canvas, x)).toBe(true);
    }
    for (const x of [5, 15, 25, 105, 195]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }
  });

  it("draws no line on the clip's own left edge", () => {
    // The clip body already makes that boundary; a line there doubles it.
    const { canvas } = gridPaint(doc({ a: picture() }));
    expect(isGridInk(canvas, 0)).toBe(false);
  });

  it("stops at the clip's right edge", () => {
    // Clip runs 0..2000ms, so x 0..200. Beyond that is row background.
    const { canvas } = gridPaint(doc({ a: picture() }));
    for (const x of [210, 220, 300]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }
  });

  it("leaves audio and text clips alone", () => {
    const { canvas } = gridPaint(
      doc({
        a: audioElement({
          trackId: "v1",
          startTime: 0,
          duration: 2000,
          timelineOptions: { color: DARK },
        }),
      }),
    );
    for (const x of [10, 20, 30]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }

    const text = gridPaint(
      doc({
        a: textElement({
          trackId: "v1",
          startTime: 0,
          duration: 2000,
          timelineOptions: { color: DARK },
        }),
      }),
    );
    for (const x of [10, 20, 30]) {
      expect(isGridInk(text.canvas, x)).toBe(false);
    }
  });

  it("runs on one lattice across clips that do not share a phase", () => {
    // The second clip starts mid-frame. Its lines must still belong to the
    // global grid, or the two clips would show visibly different rulings.
    const { canvas } = gridPaint(
      doc({
        a: picture({ duration: 1000 }),
        b: picture({ startTime: 1550, duration: 1000 }),
      }),
    );
    for (const x of [160, 170, 180]) {
      expect(isGridInk(canvas, x)).toBe(true);
    }
    for (const x of [165, 175, 185]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }
  });

  it("moves with the scroll", () => {
    const hScroll = 5;
    const { canvas } = gridPaint(
      doc({ a: picture({ startTime: 0, duration: 4000 }) }),
      { hScroll },
    );
    for (const x of [10 - hScroll, 20 - hScroll, 30 - hScroll]) {
      expect(isGridInk(canvas, x)).toBe(true);
    }
    for (const x of [10, 20, 30]) {
      expect(isGridInk(canvas, x)).toBe(false);
    }
  });

  it("sits over the filmstrip rather than under it", () => {
    // Buried beneath the frames it would be invisible, which is the one place
    // it most needs to be seen.
    const { canvas } = gridPaint(doc({ a: picture() }), {
      provider: solidProvider("#ff0000"),
    });
    expect(pixel(canvas, 15, ROW_Y)).toMatchObject({ r: 255, g: 0, b: 0 });
    const online = pixel(canvas, 20, ROW_Y);
    expect(online.g).toBeGreaterThan(0);
  });

  it("sits under the selection ring", () => {
    // Selection is the stronger signal and its ring must stay unbroken.
    const { canvas } = gridPaint(doc({ a: picture() }), { selection: ["a"] });
    expect(pixel(canvas, 20, 0)).toMatchObject(rgbOf(defaultColors.selection));
    expect(isGridInk(canvas, 20)).toBe(true);
  });

  it("costs only what is on screen", () => {
    // A ten-minute clip at this zoom is 60,000px wide; without the viewport
    // clip that would be 6,000 lines for a 400px canvas.
    const { ctx } = scene(W, H);
    const d = doc({ a: picture({ duration: 600_000 }) });
    const layout = layoutTimeline({
      doc: d,
      range: GRID_RANGE,
      hScroll: 0,
      vScroll: 0,
      viewportW: W,
      viewportH: H,
      topOffset: 0,
    });

    let fills = 0;
    const real = ctx.fillRect.bind(ctx);
    ctx.fillRect = ((...args: any[]) => {
      fills++;
      return (real as any)(...args);
    }) as any;

    drawTimeline(ctx, {
      layout,
      doc: d,
      range: GRID_RANGE,
      hScroll: 0,
      viewportW: W,
      viewportH: H,
      selection: [],
      playheadMs: -1000,
      projectEndMs: 100_000,
      colors: defaultColors,
      fps: GRID_FPS,
      frameGrid: true,
    });

    expect(fills).toBeLessThan(W / GRID_CELL_PX + 20);
  });

  it("falls back to the default frame rate rather than throwing", () => {
    const { canvas } = gridPaint(doc({ a: picture() }), { fps: undefined });
    // 60fps at range 2 is 0.333px per frame — far too dense to read, but it
    // must not crash or paint garbage outside the clip.
    expect(isGridInk(canvas, 300)).toBe(false);
  });

  it("draws nothing on a sliver of a clip", () => {
    const { canvas } = gridPaint(doc({ a: picture({ duration: 5 }) }));
    expect(isGridInk(canvas, 0)).toBe(false);
    expect(isGridInk(canvas, 1)).toBe(false);
  });
});

// ======================================================= the rubber-band

import { drawMarquee } from "./draw";

describe("drawMarquee", () => {
  // Loud and opaque, so a pixel says which of the two values reached it.
  const loud = {
    ...defaultColors,
    marqueeFill: "#ff0000",
    marqueeStroke: "#00ff00",
  };
  const band = { x: 100, y: 10, w: 100, h: 20 };

  it("fills the band over whatever it covers", () => {
    const { canvas, ctx } = paint(doc({}));
    drawMarquee(ctx, band, loud);
    expect(pixel(canvas, 150, 20)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("outlines it, so the edge reads over a bright clip", () => {
    // The half-pixel inset is the point: without it the 1px stroke straddles
    // two columns and neither is fully the stroke colour.
    const { canvas, ctx } = paint(doc({}));
    drawMarquee(ctx, band, loud);
    expect(pixel(canvas, 100, 20)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("leaves the timeline alone outside the band", () => {
    const { canvas, ctx } = paint(doc({}));
    drawMarquee(ctx, band, loud);
    // The row colour, untouched.
    expect(pixel(canvas, 50, 20)).toMatchObject({ r: 23, g: 24, b: 28 });
  });

  it("draws nothing for a band with no width", () => {
    const { canvas, ctx } = paint(doc({}));
    expect(() =>
      drawMarquee(ctx, { x: 100, y: 10, w: 0, h: 20 }, loud),
    ).not.toThrow();
    expect(pixel(canvas, 100, 20)).toMatchObject({ r: 23, g: 24, b: 28 });
  });
});

describe("a clip on a hidden row", () => {
  const RED = { r: 255, g: 0, b: 0 };
  const ROW = rgbOf(defaultColors.row);
  const RING = rgbOf(defaultColors.selection);

  // One red clip on each row, the top row hidden.
  const twoRows = () =>
    normalizeDocument(
      setTrackHidden(
        doc({
          top: imageElement({
            trackId: "v1",
            startTime: 1000,
            duration: 4000,
            timelineOptions: { color: "#ff0000" },
          }),
          under: imageElement({
            trackId: "v2",
            startTime: 1000,
            duration: 4000,
            timelineOptions: { color: "#ff0000" },
          }),
        }),
        "v1",
        true,
      ),
    );

  const inside = (layout: ReturnType<typeof paint>["layout"], id: string) => {
    const r = layout.clips.find((clip) => clip.elementId === id)!;
    return { x: r.x + r.w / 2, y: r.y + r.h - 8, rect: r };
  };

  it("is drawn over its row at the dimmed alpha, and the lit row is not", () => {
    const { canvas, layout } = paint(twoRows(), { playheadMs: 90_000 });

    const lit = inside(layout, "under");
    expect(pixel(canvas, lit.x, lit.y)).toMatchObject(RED);

    const dim = inside(layout, "top");
    const expected = (channel: number, over: number) =>
      HIDDEN_CLIP_ALPHA * channel + (1 - HIDDEN_CLIP_ALPHA) * over;
    const got = pixel(canvas, dim.x, dim.y);
    expect(Math.abs(got.r - expected(255, ROW.r))).toBeLessThanOrEqual(2);
    expect(Math.abs(got.g - expected(0, ROW.g))).toBeLessThanOrEqual(2);
    expect(Math.abs(got.b - expected(0, ROW.b))).toBeLessThanOrEqual(2);
  });

  // It stays editable, so a selection on it has to read as clearly as any.
  it("keeps its selection ring at full strength", () => {
    const { canvas, layout } = paint(twoRows(), {
      selection: ["top"],
      playheadMs: 90_000,
    });
    const { rect } = inside(layout, "top");
    expect(pixel(canvas, rect.x + rect.w / 2, rect.y)).toMatchObject(RING);
  });
});

describe("a clip pressed in by the hold", () => {
  const RED = { r: 255, g: 0, b: 0 };
  const ROW = rgbOf(defaultColors.row);

  const twoClips = () =>
    doc({
      a: imageElement({
        trackId: "v1",
        startTime: 1000,
        duration: 4000,
        timelineOptions: { color: "#ff0000" },
      }),
      b: imageElement({
        trackId: "v2",
        startTime: 1000,
        duration: 4000,
        timelineOptions: { color: "#ff0000" },
      }),
    });

  const rectOf = (layout: ReturnType<typeof paint>["layout"], id: string) =>
    layout.clips.find((clip) => clip.elementId === id)!;

  it("opens a gap at its edge that shows the row, and only on that clip", () => {
    const { canvas, layout } = paint(twoClips(), {
      lift: { ids: new Set(["a"]), insetPx: 3 },
    });

    const a = rectOf(layout, "a");
    const b = rectOf(layout, "b");
    const mid = (r: typeof a) => r.x + r.w / 2;

    // One pixel in from the rect's edge: the inset is three, and the pixel
    // beside the new edge carries a trace of its hairline's anti-aliasing.
    expect(pixel(canvas, mid(a), a.y + 1)).toMatchObject(ROW);
    expect(pixel(canvas, a.x + 1, a.y + a.h / 2)).toMatchObject(ROW);
    expect(pixel(canvas, mid(a), a.y + a.h / 2)).toMatchObject(RED);

    expect(pixel(canvas, mid(b), b.y + 1)).toMatchObject(RED);
  });

  it("draws exactly as before with no lift, which is what the gap is measured against", () => {
    const { canvas, layout } = paint(twoClips());
    const a = rectOf(layout, "a");
    expect(pixel(canvas, a.x + a.w / 2, a.y + 1)).toMatchObject(RED);
    expect(pixel(canvas, a.x + 1, a.y + a.h / 2)).toMatchObject(RED);
  });

  it("leaves the transform as it found it for everything drawn after", () => {
    const { ctx } = paint(twoClips(), {
      lift: { ids: new Set(["a"]), insetPx: 3 },
    });
    const m = ctx.getTransform();
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("drawTimeline with a resized row", () => {
  it("paints the row at its own height and the next one below it", () => {
    const d = doc({
      a: imageElement({
        trackId: "v1",
        startTime: 0,
        duration: 4000,
        timelineOptions: { color: "#0000ff" },
      }),
      b: imageElement({
        trackId: "v2",
        startTime: 0,
        duration: 4000,
        timelineOptions: { color: "#00ff00" },
      }),
    });
    const { canvas } = paint(d, { provider: nullTileProvider }, 0, { v1: 80 });
    // Row v1 runs 0..80, the gap 80..84, row v2 from 84.
    expect(pixel(canvas, 30, 75)).toMatchObject({ r: 0, g: 0, b: 255 });
    expect(pixel(canvas, 30, 84 + 20)).toMatchObject({ r: 0, g: 255, b: 0 });

    // At the default height the same y is row v2's, which is what makes the
    // check above a measurement of the height and not of the colour.
    const { canvas: plain } = paint(d, { provider: nullTileProvider });
    expect(pixel(plain, 30, 75)).toMatchObject({ r: 0, g: 255, b: 0 });
  });
});
