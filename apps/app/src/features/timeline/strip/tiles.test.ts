import { describe, it, expect } from "vitest";
import {
  TILE_QUANTA_FRAMES,
  chooseQuantum,
  chooseQuantumFrames,
  planFilmstrip,
  tileKey,
  type FilmstripInput,
} from "./tiles";
import { frameToMs, msToFrame } from "../frames";
import { MAX_RANGE } from "../zoom";

const RANGE = 0.9; // 45px per second

/** A 4s 16:9 clip on a 40px track, starting at the left edge. */
function input(over: Partial<FilmstripInput> = {}): FilmstripInput {
  return {
    localpath: "/clip.mp4",
    clipX: 0,
    clipY: 0,
    clipW: 180,
    clipH: 40,
    sourceInMs: 0,
    speed: 1,
    sourceAspect: 16 / 9,
    range: RANGE,
    viewportX0: 0,
    viewportX1: 1000,
    ...over,
  };
}

describe("chooseQuantum", () => {
  it("picks the largest rung that fits within one tile", () => {
    // Never coarser than the tile spacing: a coarser quantum rounds adjacent
    // tiles onto the same instant and the strip stops advancing.
    expect(chooseQuantumFrames(frameToMs(4, 60), 60)).toBe(4);
    expect(chooseQuantumFrames(frameToMs(7, 60), 60)).toBe(4);
    expect(chooseQuantumFrames(frameToMs(8, 60), 60)).toBe(8);
  });

  it("goes down to a single frame", () => {
    // The point of the change. A tile at maximum zoom spans ~24ms, and the old
    // floor of 250ms drew the same picture across fifteen frames of timeline.
    expect(chooseQuantumFrames(frameToMs(1, 60), 60)).toBe(1);
    expect(chooseQuantumFrames(24, 60)).toBe(1);
    expect(chooseQuantum(24, 60)).toBeCloseTo(frameToMs(1, 60), 9);
  });

  it("falls back to the finest rung when even that is too coarse", () => {
    expect(chooseQuantumFrames(1, 60)).toBe(TILE_QUANTA_FRAMES[0]);
    expect(chooseQuantumFrames(0, 60)).toBe(TILE_QUANTA_FRAMES[0]);
  });

  it("saturates at the largest rung for very wide tiles", () => {
    expect(chooseQuantumFrames(10_000_000, 60)).toBe(
      TILE_QUANTA_FRAMES[TILE_QUANTA_FRAMES.length - 1],
    );
  });

  it("is a ladder, so nearby scales share a rung", () => {
    // This is what keeps cache keys stable through a zoom gesture.
    expect(chooseQuantumFrames(1100, 60)).toBe(chooseQuantumFrames(1900, 60));
  });

  it("measures its finest rung in frames at every rate", () => {
    for (const fps of [24, 25, 30, 60]) {
      expect(chooseQuantum(frameToMs(1, fps), fps)).toBeCloseTo(
        frameToMs(1, fps),
        9,
      );
    }
  });
});

describe("filmstrip at frame-editing zoom", () => {
  /** One tile is ~71px, which at this zoom is under two frames of timeline. */
  const zoomed = () => planFilmstrip(input({ range: MAX_RANGE, clipW: 600 }));

  it("gives neighbouring tiles different frames", () => {
    // Before the quantum ladder was measured in frames, all of these collapsed
    // onto the same 250ms instant and the strip showed one picture repeatedly.
    const plan = zoomed();
    expect(plan.tiles.length).toBeGreaterThan(4);
    const sources = plan.tiles.map((tile) => tile.sourceMs);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("addresses whole frames", () => {
    for (const tile of zoomed().tiles) {
      expect(tile.sourceMs).toBeCloseTo(
        frameToMs(msToFrame(tile.sourceMs, 60), 60),
        9,
      );
    }
  });

  it("still holds one rung through a small zoom nudge", () => {
    const at = (range: number) =>
      planFilmstrip(input({ range, clipW: 600 })).quantum;
    expect(at(MAX_RANGE)).toBe(at(MAX_RANGE * 0.97));
  });
});

describe("tileKey", () => {
  it("identifies a frame by source, position and height", () => {
    expect(tileKey("/a.mp4", 1000, 40)).toBe("/a.mp4|1000|40");
  });

  it("is shared between clips cut from the same file", () => {
    // Splitting a clip must not double the decoding work.
    expect(tileKey("/a.mp4", 2000, 40)).toBe(tileKey("/a.mp4", 2000, 40));
  });

  it("separates different heights, which need different bitmaps", () => {
    expect(tileKey("/a.mp4", 0, 40)).not.toBe(tileKey("/a.mp4", 0, 80));
  });
});

describe("planFilmstrip", () => {
  it("covers the clip with whole frames plus a cut-off last one", () => {
    // 40px tall at 16:9 is a 71px tile; 180px of clip needs 3.
    const plan = planFilmstrip(input());
    expect(plan.tileW).toBe(71);
    expect(plan.tiles).toHaveLength(3);
  });

  it("never draws past the clip's edge", () => {
    const plan = planFilmstrip(input());
    for (const tile of plan.tiles) {
      expect(tile.dx + tile.dw).toBeLessThanOrEqual(180);
    }
  });

  it("marks the last tile as partial", () => {
    const plan = planFilmstrip(input());
    const last = plan.tiles[plan.tiles.length - 1];
    expect(last.swFrac).toBeLessThan(1);
    expect(plan.tiles[0].swFrac).toBe(1);
  });

  it("advances through the source as it advances across the clip", () => {
    const plan = planFilmstrip(input());
    const times = plan.tiles.map((t) => t.sourceMs);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it("starts at the trim point, not at the head of the file", () => {
    const plan = planFilmstrip(input({ sourceInMs: 5000 }));

    // The first tile is the grid cell the trim point falls in, cut by the
    // clip's edge, so its frame is from that cell's left edge — up to one tile
    // before the trim point, plus the quantum's floor. A frame the eye cannot
    // tell from the right one at this size, and the price of a strip that
    // stays put while the head is trimmed.
    const tileSourceMs = 71 / (RANGE / 4) * 5;
    expect(plan.tiles[0].sourceMs).toBeGreaterThan(
      5000 - tileSourceMs - plan.quantum,
    );
    expect(plan.tiles[0].sourceMs).toBeLessThanOrEqual(5000);

    const base = planFilmstrip(input());
    expect(plan.tiles[0].sourceMs - base.tiles[0].sourceMs).toBeGreaterThan(
      3000,
    );
  });

  it("cuts the first tile at a trimmed head rather than seating it there", () => {
    // 5000ms is 225px of source before the clip's edge: 3 whole tiles and 12px
    // of a fourth, so the first visible tile starts 12px left of the clip.
    const plan = planFilmstrip(input({ sourceInMs: 5000 }));
    const first = plan.tiles[0];
    expect(first.tileX).toBeCloseTo(-12, 6);
    expect(first.dx).toBe(0);
    expect(first.dw).toBeCloseTo(59, 6);
    expect(first.swFrac).toBeCloseTo(59 / 71, 6);
  });

  it("keeps every frame in place while the head is trimmed", () => {
    // The bug: the grid was anchored at the clip's left edge, so a head trim
    // slid the whole strip along with the edge and it looked pushed, not cut.
    // A head trim moves the edge and the trim point by the same amount, so
    // each frame must stay at the same x, and only the edge moves over it.
    const pxPerMs = RANGE / 4 / 5;
    const at = (trimMs: number) =>
      planFilmstrip(
        input({
          clipX: 50 + trimMs * pxPerMs,
          clipW: 400 - trimMs * pxPerMs,
          sourceInMs: 2000 + trimMs,
        }),
      );
    const before = at(0);
    for (const trimMs of [17, 250, 700, 1333]) {
      const after = at(trimMs);
      for (const tile of after.tiles) {
        const same = before.tiles.find((t) => t.key === tile.key);
        expect(same).toBeDefined();
        expect(tile.tileX).toBeCloseTo(same!.tileX, 6);
      }
    }
  });

  it("keeps every frame in place while the tail is trimmed", () => {
    const before = planFilmstrip(input({ clipW: 400 }));
    const after = planFilmstrip(input({ clipW: 250 }));
    for (const tile of after.tiles) {
      const same = before.tiles.find((t) => t.key === tile.key);
      expect(same).toBeDefined();
      expect(tile.tileX).toBe(same!.tileX);
    }
  });

  it("scrolls the strip with the clip, not against it", () => {
    // Moving a clip on the timeline carries its frames along with it.
    const a = planFilmstrip(input({ clipX: 100, sourceInMs: 3000 }));
    const b = planFilmstrip(input({ clipX: 160, sourceInMs: 3000 }));
    expect(b.tiles.map((t) => t.key)).toEqual(a.tiles.map((t) => t.key));
    b.tiles.forEach((t, i) => {
      expect(t.tileX - a.tiles[i].tileX).toBeCloseTo(60, 6);
    });
  });

  it("covers twice the source in the same width when sped up", () => {
    const normal = planFilmstrip(input());
    const fast = planFilmstrip(input({ speed: 2 }));
    const spanOf = (p: typeof normal) =>
      p.tiles[p.tiles.length - 1].sourceMs - p.tiles[0].sourceMs;
    expect(spanOf(fast)).toBeGreaterThan(spanOf(normal));
  });

  it("omits tiles scrolled off to the left, keeping the rest in place", () => {
    // Index must not be re-based to 0, or the strip would restart mid-clip.
    const plan = planFilmstrip(
      input({ clipX: -150, viewportX0: 0, viewportX1: 1000 }),
    );
    expect(plan.tiles.every((t) => t.dx + t.dw >= 0)).toBe(true);
    expect(plan.tiles[0].sourceMs).toBeGreaterThan(0);
  });

  it("omits tiles scrolled off to the right", () => {
    const wide = planFilmstrip(
      input({ clipW: 4000, viewportX0: 0, viewportX1: 200 }),
    );
    expect(wide.tiles.length).toBeLessThan(6);
    expect(wide.tiles.every((t) => t.dx <= 200)).toBe(true);
  });

  it("asks for nothing at all when the clip is entirely off-screen", () => {
    const plan = planFilmstrip(
      input({ clipX: 5000, viewportX0: 0, viewportX1: 500 }),
    );
    expect(plan.tiles).toEqual([]);
  });

  it("reuses keys across a zoom that stays on the same rung", () => {
    // The property that makes zooming smooth: the frames already decoded are
    // still the frames being asked for.
    const a = planFilmstrip(input({ range: 0.9 }));
    const b = planFilmstrip(input({ range: 0.95, clipW: 190 }));
    const shared = a.tiles
      .map((t) => t.key)
      .filter((k) => b.tiles.some((t) => t.key === k));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("gives a very short clip at most one tile", () => {
    const plan = planFilmstrip(input({ clipW: 3 }));
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0].dw).toBe(3);
    expect(plan.tiles[0].swFrac).toBeCloseTo(3 / 71);
  });

  it("never asks for a negative source position", () => {
    // A clip trimmed to the very head, drawn while scrolled left.
    const plan = planFilmstrip(input({ clipX: -100, sourceInMs: 0 }));
    for (const tile of plan.tiles) {
      expect(tile.sourceMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("scales tile width with track height", () => {
    const tall = planFilmstrip(input({ clipH: 80 }));
    expect(tall.tileW).toBe(142);
    expect(tall.tiles[0].dh).toBe(80);
  });

  it("handles a square source", () => {
    const plan = planFilmstrip(input({ sourceAspect: 1 }));
    expect(plan.tileW).toBe(40);
  });

  it("positions every tile inside the clip's row", () => {
    const plan = planFilmstrip(input({ clipY: 120 }));
    for (const tile of plan.tiles) {
      expect(tile.dy).toBe(120);
      expect(tile.dh).toBe(40);
    }
  });
});
