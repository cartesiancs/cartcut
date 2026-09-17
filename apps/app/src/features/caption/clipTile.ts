/**
 * What one tile of the clip picker shows, and which frame it shows.
 *
 * The picker used to be a table of file names, which identifies a clip about as
 * well as a file name does: two takes called `IMG_0412.MOV` and `IMG_0413.MOV`
 * are the same row twice. A tile shows the picture instead, and skims through
 * the clip under the pointer. Everything that decides what the tile draws is
 * here, and the component only paints it.
 *
 * Frames come from `timeline/strip/videoTiles.ts`, the provider the timeline's
 * filmstrip uses, so a clip already on screen has its frames decoded. Waveforms
 * come from the shared peak cache the timeline also reads.
 */

import type { TimeRange } from "../timeline/clipOps";
import type { PeakData } from "../timeline/strip/peaks";
import type { TileRequest } from "../timeline/strip/provider";
import { tileKey } from "../timeline/strip/tiles";
import { pickNumber, type ClipPick } from "./clipPick";
import { clipTwins } from "./clips";
import { sourceDisplayName, type CaptionSource } from "./sources";

export type ClipTile = {
  key: string;
  localpath: string;
  filetype: "video" | "audio";
  /** A material-symbols ligature. */
  icon: string;
  name: string;
  /**
   * Where the clip starts, for a clip whose file name another tile shares.
   * Null otherwise: the name alone is enough.
   */
  startLabel: string | null;
  /** The clip's length on the timeline. */
  durationLabel: string;
  /** The badge, 1-based, or null when the clip is not chosen. */
  number: number | null;
  selected: boolean;
  /** Shares its recording with another tile. See `clips.ts` on twins. */
  twin: boolean;
  /** The clip's window into its file, in source ms. */
  window: TimeRange;
  aspect: number;
};

export function clipTiles(
  rows: readonly CaptionSource[],
  pick: ClipPick,
): ClipTile[] {
  const names = new Map<string, number>();
  for (const row of rows) {
    const name = sourceDisplayName(row.localpath);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const twins = clipTwins(rows);

  return rows.map((row) => {
    const name = sourceDisplayName(row.localpath);
    const number = pickNumber(pick, row.key);
    return {
      key: row.key,
      localpath: row.localpath,
      filetype: row.filetype,
      icon: row.filetype === "audio" ? "graphic_eq" : "movie",
      name,
      startLabel:
        (names.get(name) ?? 0) > 1 ? `@${formatClipDuration(row.startMs)}` : null,
      durationLabel: formatClipDuration(row.spanMs),
      number,
      selected: number != null,
      twin: twins.has(row.key),
      window: { startMs: row.trimStartMs, endMs: row.trimEndMs },
      aspect: row.aspect,
    };
  });
}

/**
 * `0:05`, `1:03`, `1:02:03`.
 *
 * Rounded to the nearest second, and never `0:00` for a clip that has any
 * length, which would read as empty.
 */
export function formatClipDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = safe > 0 ? Math.max(1, Math.round(safe / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Snap to this, so a poster and a skim step share cached frames. */
const FRAME_QUANTUM_MS = 100;

/**
 * The still a tile rests on: a quarter of the way in.
 *
 * Not the first frame, which is black for any clip that fades in and for most
 * screen recordings until the first paint.
 */
export function posterMs(window: TimeRange): number {
  const length = window.endMs - window.startMs;
  if (!(length > 0)) {
    return Math.max(0, window.startMs);
  }
  return inside(window, window.startMs + length * 0.25);
}

/**
 * The frame under the pointer while it moves across a tile.
 *
 * Quantised to `steps` positions, each the middle of its slice, so moving the
 * pointer back and forth asks for the same few frames and the tile cache
 * answers from memory after the first pass. Decoding a new frame on every
 * mouse move is a seek per event, and on this app's footage a seek is slow.
 */
export function skimMs(
  window: TimeRange,
  fraction: number,
  steps = 16,
): number {
  const length = window.endMs - window.startMs;
  if (!(length > 0)) {
    return Math.max(0, window.startMs);
  }
  const count = Math.max(1, Math.floor(steps));
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const step = Math.min(count - 1, Math.floor(f * count));
  return inside(window, window.startMs + (length * (step + 0.5)) / count);
}

/** The provider request for one frame, at the tile's device size. */
export function thumbRequest(
  localpath: string,
  sourceMs: number,
  width: number,
  height: number,
): TileRequest {
  const tileW = Math.max(1, Math.round(width));
  const tileH = Math.max(1, Math.round(height));
  return {
    key: tileKey(localpath, sourceMs, tileH),
    localpath,
    sourceMs,
    tileW,
    tileH,
  };
}

/**
 * A waveform for the clip's window, one column per pixel, each in -1..1.
 *
 * The same reading `timeline/strip/peaks.ts#planWaveform` does, minus the
 * timeline's zoom: a column covers an equal slice of the window, reads at least
 * one bucket, and intersects the file rather than clamping into it, so the
 * part of a window past the end of the audio draws flat.
 */
export function tileWave(
  data: PeakData,
  window: TimeRange,
  width: number,
): { min: number; max: number }[] {
  const columns = Math.max(0, Math.floor(width));
  const buckets = Math.floor(data.peaks.length / 2);
  const length = window.endMs - window.startMs;
  if (columns === 0 || buckets === 0 || !(data.bucketMs > 0) || !(length > 0)) {
    return [];
  }

  const perColumn = length / columns;
  const out: { min: number; max: number }[] = [];
  for (let x = 0; x < columns; x += 1) {
    const from = window.startMs + x * perColumn;
    const first = Math.floor(from / data.bucketMs);
    let last = Math.ceil((from + perColumn) / data.bucketMs);
    if (last <= first) {
      last = first + 1;
    }

    let min = 0;
    let max = 0;
    for (let b = Math.max(0, first); b < Math.min(buckets, last); b += 1) {
      min = Math.min(min, data.peaks[b * 2]);
      max = Math.max(max, data.peaks[b * 2 + 1]);
    }
    out.push({ min, max });
  }
  return out;
}

function inside(window: TimeRange, ms: number): number {
  const snapped = Math.floor(ms / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS;
  // A frame at the window's own end is past the clip's last frame.
  const last = Math.max(window.startMs, window.endMs - 1);
  return Math.min(last, Math.max(window.startMs, snapped));
}
