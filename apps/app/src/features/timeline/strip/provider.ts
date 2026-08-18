/**
 * How the timeline asks for a thumbnail without ever waiting for one.
 *
 * Decoding a video frame costs tens of milliseconds; a draw pass cannot afford
 * that, and a filmstrip needs many frames per clip. So `get` is synchronous and
 * only ever reads an already-decoded tile, while `request` queues the work and
 * returns immediately. A miss paints the clip's flat colour and is filled in on
 * a later frame once the extractor calls back.
 *
 * Phase 2 wires the null implementation so the drawing code and its tests are
 * complete before any decoding exists; the video extractor slots in behind the
 * same interface.
 */

export type TileRequest = {
  /** Cache key: source path, quantum, index and tile height. */
  key: string;
  localpath: string;
  /** Quantized position in the source file, in source ms. */
  sourceMs: number;
  tileW: number;
  tileH: number;
};

export interface TileProvider {
  /** An already-decoded tile, or null. Never blocks. */
  get(key: string): CanvasImageSource | null;
  /** Queue a tile for decoding. Safe to call every frame; requests dedupe. */
  request(request: TileRequest): void;
}

/** Draws nothing, asks for nothing — clips fall back to a flat colour. */
export const nullTileProvider: TileProvider = {
  get: () => null,
  request: () => {},
};
