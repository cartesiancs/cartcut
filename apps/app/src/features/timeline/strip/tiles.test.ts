import { describe, it, expect } from "vitest";
import {
  TILE_QUANTA_MS,
  chooseQuantum,
  planFilmstrip,
  tileKey,
  type FilmstripInput,
} from "./tiles";

const RANGE = 0.9; // 45px per second

/** A 4s 16:9 clip on a 40px track, starting at the left edge. */
function input(over: Partial<FilmstripInput> = {}): FilmstripInput {
  return {
    localpath: "/clip.mp4",
    clipX: 0,
    clipY: 0,
    clipW: 180,
    clipH: 40,
    spanStartMs: 0,
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
    expect(chooseQuantum(250)).toBe(250);
    expect(chooseQuantum(499)).toBe(250);
    expect(chooseQuantum(1500)).toBe(1000);
    expect(chooseQuantum(2000)).toBe(2000);
  });

  it("falls back to the finest rung when even that is too coarse", () => {
    expect(chooseQuantum(100)).toBe(TILE_QUANTA_MS[0]);
    expect(chooseQuantum(0)).toBe(TILE_QUANTA_MS[0]);
  });

  it("saturates at the largest rung for very wide tiles", () => {
    expect(chooseQuantum(10_000_000)).toBe(
      TILE_QUANTA_MS[TILE_QUANTA_MS.length - 1],
    );
  });

  it("is a ladder, so nearby scales share a rung", () => {
    // This is what keeps cache keys stable through a zoom gesture.
    expect(chooseQuantum(1100)).toBe(chooseQuantum(1900));
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

    // Quantising floors, so the first tile can sit up to one quantum before the
    // exact trim point. That is at most one tile's worth of source time — a
    // frame the eye cannot distinguish from the right one at this size, and the
    // price of keys that stay put while zooming.
    expect(plan.tiles[0].sourceMs).toBeGreaterThan(5000 - plan.quantum);
    expect(plan.tiles[0].sourceMs).toBeLessThanOrEqual(5000);

    const base = planFilmstrip(input());
    expect(plan.tiles[0].sourceMs - base.tiles[0].sourceMs).toBeGreaterThan(
      4000,
    );
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
