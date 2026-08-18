/**
 * Painting the timeline, from a layout that has already decided the geometry.
 *
 * This file owns pixels and nothing else: it never measures a clip or resolves
 * a hit, so it cannot disagree with `layout.ts` about where anything is.
 *
 * Two things changed from the drawing it replaces. A dynamic clip's bar used to
 * span the whole untrimmed source with the cut-away head and tail shaded dark —
 * so two halves of a split drew on top of each other and only the shading told
 * them apart. And `wrapText`, an ellipsis helper, sat here unused for the whole
 * life of the file: clips carried no label at all. Both are fixed below.
 */

import type { TimelineElement } from "../../@types/timeline";
import { isDynamicElement } from "./geometry";
import { xAtTime, type ClipRect, type TimelineLayout } from "./layout";
import type { TimelineDocument } from "./tracks";
import { nullTileProvider, type TileProvider } from "./strip/provider";

export type ThemeColors = {
  background: string;
  row: string;
  label: string;
  selection: string;
  playhead: string;
  projectEnd: string;
  snapGuide: string;
};

export const defaultColors: ThemeColors = {
  background: "#17181c",
  row: "#1e1f25",
  label: "#ffffff",
  selection: "#ffffff",
  playhead: "#dbdaf0",
  projectEnd: "#ff173e",
  snapGuide: "#ffd400",
};

export type DrawOptions = {
  layout: TimelineLayout;
  doc: TimelineDocument;
  range: number;
  hScroll: number;
  viewportW: number;
  viewportH: number;
  selection: string[];
  playheadMs: number;
  projectEndMs: number;
  /** Time to mark with a guide line while a drag is snapping, if any. */
  snapGuideMs?: number | null;
  provider?: TileProvider;
  colors?: ThemeColors;
};

const LABEL_FONT = '12px "Noto Sans", sans-serif';
const LABEL_PADDING = 6;
const SELECTION_WIDTH = 2;
/** Below this height a label would collide with the filmstrip; skip it. */
const MIN_LABEL_HEIGHT = 20;

/**
 * Fit `text` to `maxWidth`, ellipsising if needed.
 *
 * This is the `wrapText` that existed but was never called, made to actually
 * run. Binary search rather than the original character-at-a-time trim, which
 * re-measured the string on every step.
 */
export function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  const ellipsis = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low > 0 ? text.slice(0, low) + ellipsis : "";
}

/** What to write on a clip: its words if it has any, otherwise its file. */
export function clipLabel(element: TimelineElement): string {
  if (element.filetype === "text") {
    return (element as any).text ?? "text";
  }
  const path = element.localpath ?? "";
  const name = path.split(/[\\/]/).pop() ?? "";
  return name || element.filetype;
}

/** Whether a clip type can show frame thumbnails. */
export function canShowFilmstrip(element: TimelineElement): boolean {
  return element.filetype === "video" || element.filetype === "image";
}

export function drawClip(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: TimelineElement,
  opts: {
    selected: boolean;
    provider: TileProvider;
    colors: ThemeColors;
  },
) {
  const color = element.timelineOptions?.color ?? "#4a4b57";

  ctx.save();

  // Everything inside the clip is clipped to it, so a filmstrip tile that
  // would overhang the trimmed edge is cut rather than spilling onto the
  // neighbour.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  if (canShowFilmstrip(element)) {
    drawFilmstrip(ctx, rect, element, opts.provider);
  }

  if (rect.h >= MIN_LABEL_HEIGHT && rect.w > LABEL_PADDING * 2) {
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "top";

    // A scrim so the label survives whatever the thumbnail underneath is doing.
    const scrimHeight = 16;
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(rect.x, rect.y, rect.w, scrimHeight);

    ctx.fillStyle = opts.colors.label;
    const label = truncateText(
      ctx,
      clipLabel(element),
      rect.w - LABEL_PADDING * 2,
    );
    ctx.fillText(label, rect.x + LABEL_PADDING, rect.y + 2);
  }

  ctx.restore();

  if (opts.selected) {
    ctx.fillStyle = opts.colors.selection;
    const b = SELECTION_WIDTH;
    ctx.fillRect(rect.x, rect.y, rect.w, b);
    ctx.fillRect(rect.x, rect.y + rect.h - b, rect.w, b);
    ctx.fillRect(rect.x, rect.y, b, rect.h);
    ctx.fillRect(rect.x + rect.w - b, rect.y, b, rect.h);
  }
}

/**
 * Lay frame tiles across the clip.
 *
 * Tile planning proper — quantisation, cache keys, viewport culling — arrives
 * with the extractor. Here each tile is simply asked for and drawn if present,
 * so a provider that has nothing yet leaves the flat colour showing.
 */
function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: TimelineElement,
  provider: TileProvider,
) {
  const tileW = Math.max(8, Math.round(rect.h * (16 / 9)));
  const count = Math.ceil(rect.w / tileW);

  for (let i = 0; i < count; i++) {
    const key = `${element.localpath}|${i}|${rect.h}`;
    const tile = provider.get(key);
    if (tile == null) {
      continue;
    }
    ctx.drawImage(tile, rect.x + i * tileW, rect.y, tileW, rect.h);
  }
}

export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  opts: DrawOptions,
) {
  const colors = opts.colors ?? defaultColors;
  const provider = opts.provider ?? nullTileProvider;
  const selection = new Set(opts.selection);

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, opts.viewportW, opts.viewportH);

  for (const row of opts.layout.rows) {
    ctx.fillStyle = colors.row;
    ctx.fillRect(0, row.top, opts.viewportW, row.height);
  }

  for (const rect of opts.layout.clips) {
    const element = opts.doc.elements[rect.elementId];
    if (element == null) {
      continue;
    }
    drawClip(ctx, rect, element, {
      selected: selection.has(rect.elementId),
      provider,
      colors,
    });
  }

  // Overlays last so nothing paints over them.
  const endX = xAtTime(opts.projectEndMs, opts.range, opts.hScroll);
  ctx.fillStyle = colors.projectEnd;
  ctx.fillRect(endX, 0, 2, opts.viewportH);

  if (opts.snapGuideMs != null) {
    // `isGuide` was set on every snap and never rendered; this is the line it
    // was supposed to draw.
    const guideX = xAtTime(opts.snapGuideMs, opts.range, opts.hScroll);
    ctx.fillStyle = colors.snapGuide;
    ctx.fillRect(guideX, 0, 1, opts.viewportH);
  }

  const playheadX = xAtTime(opts.playheadMs, opts.range, opts.hScroll);
  ctx.fillStyle = colors.playhead;
  ctx.fillRect(playheadX, 0, 2, opts.viewportH);
}

/** Marks a row as the target of a drag. */
export function drawDropTarget(
  ctx: CanvasRenderingContext2D,
  layout: TimelineLayout,
  trackId: string,
  viewportW: number,
  color = "rgba(255, 255, 255, 0.18)",
) {
  const row = layout.rows.find((candidate) => candidate.trackId === trackId);
  if (row == null) {
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, row.top, viewportW, row.height);
}
