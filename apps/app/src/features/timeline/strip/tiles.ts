/**
 * Which frames a clip's filmstrip needs, and where each one goes.
 *
 * All of the awkwardness here comes from one constraint: decoding a frame costs
 * tens of milliseconds, and the timeline redraws on every scroll, zoom and
 * drag. So the tile a given pixel wants must be **stable** — if it changed
 * continuously with zoom, every frame of a zoom gesture would miss the cache and
 * queue a fresh decode that arrives too late to be used.
 *
 * Quantising the source position fixes that. A tile addresses a rounded instant
 * in the source file rather than an exact one, so panning a few pixels or
 * nudging the zoom keeps asking for the same handful of frames.
 *
 * This module is pure: no decoder, no canvas, no DOM. It is where the real
 * coverage lives.
 */

import { pxToMsSigned } from "../geometry";

/**
 * Rungs the quantum can take, in source ms.
 *
 * A ladder rather than a continuous function so that zooming lands on the same
 * rung across a range of scales, which is what makes cache keys survive a zoom.
 */
export const TILE_QUANTA_MS = [
  250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000,
] as const;

export type FilmstripTile = {
  /** Cache key: the frame this tile shows, at this height. */
  key: string;
  localpath: string;
  /** Quantised position in the source file, in source ms. */
  sourceMs: number;
  /** Destination rect on the canvas. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /**
   * Horizontal fraction of the tile to draw, 0..1.
   *
   * The last tile of a strip is nearly always cut off by the clip's edge.
   */
  swFrac: number;
};

export type FilmstripPlan = {
  tiles: FilmstripTile[];
  quantum: number;
  /** Natural width of one tile, before the last one is clipped. */
  tileW: number;
};

/**
 * The largest rung that still fits inside one tile's worth of source time.
 *
 * It has to be *at most* the tile span, not at least: a quantum coarser than
 * the spacing rounds neighbouring tiles onto the same instant, and the strip
 * shows the same frame twice in a row instead of advancing.
 *
 * Below the finest rung there is nothing smaller to pick, so very zoomed-in
 * strips do repeat frames — the right trade, since a tile there is a few pixels
 * wide and each distinct frame costs a decode.
 */
export function chooseQuantum(spanMs: number): number {
  // Typed wider than the `as const` literal so the loop can assign into it.
  let chosen: number = TILE_QUANTA_MS[0];
  for (const rung of TILE_QUANTA_MS) {
    if (rung <= spanMs) {
      chosen = rung;
    }
  }
  return chosen;
}

/** The cache key for one frame. Shared across clips cut from the same file. */
export function tileKey(
  localpath: string,
  sourceMs: number,
  tileH: number,
): string {
  return `${localpath}|${sourceMs}|${tileH}`;
}

export type FilmstripInput = {
  localpath: string;
  /** Clip rect on the canvas. */
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  /** Where the clip starts on the timeline, and how long it runs there. */
  spanStartMs: number;
  /** Source ms shown at the clip's left edge. */
  sourceInMs: number;
  speed: number;
  /** Source width / height; controls how wide one frame is drawn. */
  sourceAspect: number;
  range: number;
  /** Visible x window, so off-screen tiles are never requested. */
  viewportX0: number;
  viewportX1: number;
};

export function planFilmstrip(input: FilmstripInput): FilmstripPlan {
  const {
    localpath,
    clipX,
    clipY,
    clipW,
    clipH,
    spanStartMs,
    sourceInMs,
    speed,
    sourceAspect,
    range,
    viewportX0,
    viewportX1,
  } = input;

  const tileW = Math.max(1, Math.round(clipH * sourceAspect));
  const tileSpanTimelineMs = pxToMsSigned(tileW, range);
  const quantum = chooseQuantum(Math.abs(tileSpanTimelineMs * speed));

  const tiles: FilmstripTile[] = [];
  const count = Math.ceil(clipW / tileW);

  for (let i = 0; i < count; i++) {
    const dx = clipX + i * tileW;
    const dw = Math.min(tileW, clipX + clipW - dx);
    if (dw <= 0) {
      continue;
    }

    // Cull before quantising: an off-screen tile should not even be asked for,
    // or a long clip would queue hundreds of decodes nobody can see.
    if (dx + dw < viewportX0 || dx > viewportX1) {
      continue;
    }

    const timelineMs = spanStartMs + pxToMsSigned(i * tileW, range);
    const exactSourceMs = sourceInMs + (timelineMs - spanStartMs) * speed;
    const sourceMs = Math.max(0, Math.floor(exactSourceMs / quantum) * quantum);

    tiles.push({
      key: tileKey(localpath, sourceMs, clipH),
      localpath,
      sourceMs,
      dx,
      dy: clipY,
      dw,
      dh: clipH,
      swFrac: dw / tileW,
    });
  }

  return { tiles, quantum, tileW };
}
