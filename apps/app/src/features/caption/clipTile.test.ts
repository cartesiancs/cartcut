import { describe, expect, it } from "vitest";
import { tileKey } from "../timeline/strip/tiles";
import {
  clipTiles,
  formatClipDuration,
  posterMs,
  skimMs,
  thumbRequest,
  tileWave,
} from "./clipTile";
import { captionSources } from "./sources";

const W = { startMs: 1_000, endMs: 9_000 };

describe("formatClipDuration", () => {
  it("writes minutes and seconds, and hours once there are any", () => {
    expect(formatClipDuration(5_000)).toBe("0:05");
    expect(formatClipDuration(63_000)).toBe("1:03");
    expect(formatClipDuration(3_723_000)).toBe("1:02:03");
  });

  it("rounds to the nearest second", () => {
    expect(formatClipDuration(59_900)).toBe("1:00");
    expect(formatClipDuration(59_400)).toBe("0:59");
  });

  // `0:00` reads as empty.
  it("never shows a clip with length as zero", () => {
    expect(formatClipDuration(200)).toBe("0:01");
    expect(formatClipDuration(0)).toBe("0:00");
    expect(formatClipDuration(Number.NaN)).toBe("0:00");
  });
});

describe("clipTiles", () => {
  const rows = () =>
    captionSources({
      v: {
        filetype: "video",
        localpath: "file:///take.mov",
        startTime: 0,
        duration: 8_000,
        speed: 2,
        trim: { startTime: 1_000, endTime: 9_000 },
        origin: { width: 1080, height: 1920 },
      },
      v2: {
        filetype: "video",
        localpath: "file:///take.mov",
        startTime: 65_000,
        duration: 2_000,
      },
      a: {
        filetype: "audio",
        localpath: "file:///voice.wav",
        startTime: 70_000,
        duration: 3_000,
      },
    });

  it("numbers the chosen tiles in the chosen order", () => {
    const tiles = clipTiles(rows(), ["a", "v"]);
    expect(tiles.map((t) => [t.key, t.number, t.selected])).toEqual([
      ["v", 2, true],
      ["v2", null, false],
      ["a", 1, true],
    ]);
  });

  it("shows the timeline length, not the source length", () => {
    expect(clipTiles(rows(), [])[0].durationLabel).toBe("0:04");
  });

  it("tells two clips of one file apart by where they start", () => {
    const tiles = clipTiles(rows(), []);
    expect(tiles.map((t) => t.startLabel)).toEqual(["@0:00", "@1:05", null]);
    expect(tiles.map((t) => t.name)).toEqual(["take.mov", "take.mov", "voice.wav"]);
  });

  it("picks an icon per kind and carries the window and the shape", () => {
    const [v, , a] = clipTiles(rows(), []);
    expect(v).toMatchObject({
      icon: "movie",
      window: { startMs: 1_000, endMs: 9_000 },
    });
    expect(v.aspect).toBeCloseTo(1080 / 1920);
    expect(a.icon).toBe("graphic_eq");
  });

  it("marks a video and its detached audio as twins", () => {
    const tiles = clipTiles(
      captionSources({
        v: { filetype: "video", localpath: "file:///x.mov", startTime: 0, duration: 4_000 },
        a: { filetype: "audio", localpath: "file:///x.mov", startTime: 0, duration: 4_000 },
        o: { filetype: "video", localpath: "file:///x.mov", startTime: 9_000, duration: 4_000 },
      }),
      [],
    );
    expect(tiles.map((t) => [t.key, t.twin])).toEqual([
      ["v", true],
      ["a", true],
      ["o", false],
    ]);
  });
});

describe("posterMs", () => {
  it("rests a quarter of the way in, on the frame grid", () => {
    expect(posterMs(W)).toBe(3_000);
    expect(posterMs({ startMs: 0, endMs: 1_234 })).toBe(300);
  });

  it("stays inside a window too short to have a quarter", () => {
    expect(posterMs({ startMs: 500, endMs: 520 })).toBe(500);
    expect(posterMs({ startMs: 500, endMs: 500 })).toBe(500);
  });
});

describe("skimMs", () => {
  it("answers one of a few fixed frames, so a second pass is cached", () => {
    const frames = new Set<number>();
    for (let f = 0; f <= 1; f += 0.01) {
      frames.add(skimMs(W, f, 8));
    }
    expect(frames.size).toBe(8);
  });

  it("goes from the start of the clip to its end, never past either", () => {
    expect(skimMs(W, 0, 8)).toBe(1_500);
    expect(skimMs(W, 1, 8)).toBe(8_500);
    expect(skimMs(W, -3, 8)).toBe(1_500);
    expect(skimMs(W, 9, 8)).toBe(8_500);
    expect(skimMs(W, Number.NaN, 8)).toBe(1_500);
  });

  it("is monotonic along the tile", () => {
    let last = -1;
    for (let f = 0; f <= 1; f += 0.05) {
      const at = skimMs(W, f);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });
});

describe("thumbRequest", () => {
  it("keys the frame the way the timeline's filmstrip does, so they share a cache", () => {
    expect(thumbRequest("file:///a.mov", 3_000, 159.6, 90.2)).toEqual({
      key: tileKey("file:///a.mov", 3_000, 90),
      localpath: "file:///a.mov",
      sourceMs: 3_000,
      tileW: 160,
      tileH: 90,
    });
  });
});

describe("tileWave", () => {
  /** 10 buckets of 100ms, louder bucket by bucket. */
  const data = () => {
    const peaks = new Float32Array(20);
    for (let b = 0; b < 10; b += 1) {
      peaks[b * 2] = -b / 10;
      peaks[b * 2 + 1] = b / 10;
    }
    return { peaks, bucketMs: 100, durationMs: 1_000 };
  };

  it("draws one column per pixel across the window", () => {
    const wave = tileWave(data(), { startMs: 0, endMs: 1_000 }, 5);
    expect(wave).toHaveLength(5);
    expect(wave[4].max).toBeCloseTo(0.9);
    expect(wave[0].max).toBeCloseTo(0.1);
  });

  it("reads only the clip's window", () => {
    const wave = tileWave(data(), { startMs: 500, endMs: 600 }, 2);
    expect(wave.every((c) => Math.abs(c.max - 0.5) < 1e-6)).toBe(true);
  });

  it("draws flat past the end of the audio rather than repeating it", () => {
    const wave = tileWave(data(), { startMs: 800, endMs: 1_600 }, 4);
    expect(wave[3]).toEqual({ min: 0, max: 0 });
    expect(wave[0].max).toBeCloseTo(0.9);
  });

  it("draws nothing it cannot", () => {
    expect(tileWave(data(), { startMs: 0, endMs: 1_000 }, 0)).toEqual([]);
    expect(tileWave(data(), { startMs: 5, endMs: 5 }, 10)).toEqual([]);
    expect(
      tileWave({ peaks: new Float32Array(0), bucketMs: 20, durationMs: 0 }, W, 10),
    ).toEqual([]);
  });
});
