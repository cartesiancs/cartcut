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

import type {
  ImageElementType,
  TimelineElement,
  VideoElementType,
} from "../../@types/timeline";
import { isDynamicElement, spanStart, speedOf } from "./geometry";
import { xAtTime, type ClipRect, type TimelineLayout } from "./layout";
import type { TimelineDocument } from "./tracks";
import { nullTileProvider, type TileProvider } from "./strip/provider";
import { planFilmstrip } from "./strip/tiles";
import { planWaveform } from "./strip/peaks";
import { nullPeakProvider, type PeakProvider } from "./strip/audioPeaks";
import {
  KEYFRAME_LANE_PX,
  KEYFRAME_SIZE_PX,
  keyframeLane,
  planKeyframeMarkers,
} from "./keyframeMarkers";

export type ThemeColors = {
  background: string;
  row: string;
  label: string;
  selection: string;
  playhead: string;
  projectEnd: string;
  snapGuide: string;
  keyframe: string;
  /** More than one property keyed at the same instant. */
  keyframeMerged: string;
  /** Plate behind the diamonds, so they read over a bright filmstrip. */
  keyframeLane: string;
};

export const defaultColors: ThemeColors = {
  background: "#17181c",
  row: "#1e1f25",
  label: "#ffffff",
  selection: "#ffffff",
  playhead: "#dbdaf0",
  projectEnd: "#ff173e",
  snapGuide: "#ffd400",
  // The colour the dead `animation-panel` used for its CSS diamonds, which was
  // the only thing `.keyframe-diamond` in `_keyframe.scss` was ever for.
  keyframe: "#d7dce3",
  keyframeMerged: "#ffffff",
  keyframeLane: "rgba(0, 0, 0, 0.35)",
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
  peaks?: PeakProvider;
  colors?: ThemeColors;
};

const LABEL_FONT = '12px "Noto Sans", sans-serif';
const LABEL_PADDING = 6;
/** Dark outline that keeps the label readable without hiding the frame. */
const LABEL_HALO = "rgba(0, 0, 0, 0.85)";
const LABEL_HALO_WIDTH = 3;
/** How much of a video clip the waveform is allowed to take. */
const WAVEFORM_BAND_PX = 10;
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

/** Clip types with a waveform worth drawing. */
export function canShowWaveform(element: TimelineElement): boolean {
  return (
    element.filetype === "audio" ||
    (element.filetype === "video" && element.isExistAudio === true)
  );
}

/** Clip types with frames to show. A type guard so `drawFilmstrip` can rely on
 * the visual fields — audio has no width or height at all. */
export function canShowFilmstrip(
  element: TimelineElement,
): element is VideoElementType | ImageElementType {
  return element.filetype === "video" || element.filetype === "image";
}

export function drawClip(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: TimelineElement,
  opts: {
    selected: boolean;
    provider: TileProvider;
    peaks: PeakProvider;
    colors: ThemeColors;
    range: number;
    viewportW: number;
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
    drawFilmstrip(ctx, rect, element, opts.provider, {
      range: opts.range,
      viewportW: opts.viewportW,
    });
  }

  // The lane is decided before the waveform draws, because the waveform has to
  // move up out of its way — but only when there is a lane. A clip with no
  // keyframes is painted exactly as it was before diamonds existed.
  const lane = keyframeLane(rect, element, opts.range);

  if (canShowWaveform(element)) {
    drawWaveform(ctx, rect, element, opts.peaks, {
      range: opts.range,
      viewportW: opts.viewportW,
      bottomInset: lane == null ? 0 : KEYFRAME_LANE_PX,
    });
  }

  if (lane != null) {
    drawKeyframeLane(ctx, rect, element, {
      colors: opts.colors,
      range: opts.range,
    });
  }

  if (rect.h >= MIN_LABEL_HEIGHT && rect.w > LABEL_PADDING * 2) {
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "top";

    const label = truncateText(
      ctx,
      clipLabel(element),
      rect.w - LABEL_PADDING * 2,
    );

    // Outlined rather than sat on an opaque strip. The strip was 16px of a
    // 40px row, and with the waveform below it left about 8px of actual
    // frames — which is why the filmstrip looked absent on any clip with
    // sound. An outline costs nothing and hides nothing.
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = LABEL_HALO_WIDTH;
    ctx.strokeStyle = LABEL_HALO;
    ctx.strokeText(label, rect.x + LABEL_PADDING, rect.y + 2);

    ctx.fillStyle = opts.colors.label;
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
 * Every tile is drawn if the provider already has it and requested if not —
 * `request` is cheap and deduplicating, so calling it each frame is fine. A
 * miss leaves the flat colour showing until a later repaint, which is the
 * normal state while a strip fills in.
 */
function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: VideoElementType | ImageElementType,
  provider: TileProvider,
  opts: { range: number; viewportW: number },
) {
  // A video knows its source pixels; an image only has its on-screen box, which
  // is the same shape unless it has been stretched.
  const origin = element.filetype === "video" ? element.origin : null;
  const aspect =
    origin != null && origin.width > 0 && origin.height > 0
      ? origin.width / origin.height
      : element.width > 0 && element.height > 0
        ? element.width / element.height
        : 16 / 9;

  const plan = planFilmstrip({
    localpath: element.localpath,
    clipX: rect.x,
    clipY: rect.y,
    clipW: rect.w,
    clipH: rect.h,
    spanStartMs: spanStart(element),
    sourceInMs: isDynamicElement(element) ? element.trim.startTime : 0,
    speed: speedOf(element),
    sourceAspect: aspect,
    range: opts.range,
    viewportX0: 0,
    viewportX1: opts.viewportW,
  });

  for (const tile of plan.tiles) {
    const bitmap = provider.get(tile.key);
    if (bitmap == null) {
      provider.request({
        key: tile.key,
        localpath: tile.localpath,
        sourceMs: tile.sourceMs,
        tileW: plan.tileW,
        tileH: rect.h,
      });
      continue;
    }

    // Draw the whole tile at its natural width and let the clip's own clip path
    // cut the overhang; scaling the last tile down instead would squash it.
    ctx.drawImage(bitmap, tile.dx, tile.dy, plan.tileW, tile.dh);
  }
}

/**
 * Draw the clip's waveform across its lower half.
 *
 * Lower half rather than the whole clip: on a video with sound the filmstrip
 * owns the frame and the waveform rides underneath it, and on a bare audio clip
 * a centred trace reads the same either way.
 */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: TimelineElement,
  provider: PeakProvider,
  opts: { range: number; viewportW: number; bottomInset?: number },
) {
  const data = provider.get(element.localpath);
  if (data == null) {
    provider.request(element.localpath);
    return;
  }

  // Room reserved at the bottom for the keyframe lane, and zero whenever the
  // clip has no keyframes — which is why an unanimated clip's waveform is
  // pixel-identical to what it was before the lane existed. Audio never has a
  // lane (its type carries no `animation` block), so a bare audio clip keeps
  // the full row.
  const inset = opts.bottomInset ?? 0;
  const isVideo = element.filetype === "video";
  const available = Math.max(0, rect.h - inset);
  // A thin trace on a video, so the frames keep the height; a bare audio clip
  // has nothing to compete with and uses the whole row.
  const band = isVideo ? Math.min(WAVEFORM_BAND_PX, available) : available;
  const top = rect.y + rect.h - inset - band;
  const mid = top + band / 2;
  const half = band / 2;

  const columns = planWaveform({
    data,
    clipX: rect.x,
    clipW: rect.w,
    spanStartMs: spanStart(element),
    sourceInMs: isDynamicElement(element) ? element.trim.startTime : 0,
    speed: speedOf(element),
    range: opts.range,
    viewportX0: 0,
    viewportX1: opts.viewportW,
  });

  // No backing plate: at full opacity the trace reads against bright frames on
  // its own, and a plate would cost another tenth of the clip's height.
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  for (const column of columns) {
    const y0 = mid - column.max * half;
    const y1 = mid - column.min * half;
    // A silent column still gets a hairline, so the clip reads as audio rather
    // than as a gap.
    ctx.fillRect(column.x, y0, 1, Math.max(1, y1 - y0));
  }
}

/**
 * A diamond, as an explicit path.
 *
 * Four `lineTo`s rather than a rotated square: `ctx.rotate` would need a
 * `save`/`restore` around every marker and would antialias the points into a
 * blur at this size. Adding to an open path rather than filling here is what
 * lets every diamond on a clip go down in one fill.
 */
function diamondPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const r = size / 2;
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

/**
 * Mark where the clip's keyframes are.
 *
 * Drawn inside `drawClip`'s clip path, so a diamond on the clip's last frame is
 * cut at the edge instead of poking into its neighbour — the same treatment the
 * final filmstrip tile gets. That also means the selection border, which is
 * painted after `ctx.restore()`, sits on top of a diamond at either end. That
 * is the right way round: selection is the stronger signal and its 2px frame
 * stays unbroken.
 *
 * Two fills total, however many diamonds there are.
 */
export function drawKeyframeLane(
  ctx: CanvasRenderingContext2D,
  rect: ClipRect,
  element: TimelineElement,
  opts: { colors: ThemeColors; range: number },
): void {
  const lane = keyframeLane(rect, element, opts.range);
  if (lane == null) {
    return;
  }

  const markers = planKeyframeMarkers({ element, rect, range: opts.range });
  if (markers.length === 0) {
    return;
  }

  ctx.fillStyle = opts.colors.keyframeLane;
  ctx.fillRect(rect.x, lane.top, rect.w, lane.height);

  ctx.beginPath();
  for (const marker of markers) {
    if (marker.count === 1) {
      diamondPath(ctx, marker.x, lane.centerY, KEYFRAME_SIZE_PX);
    }
  }
  ctx.fillStyle = opts.colors.keyframe;
  ctx.fill();

  ctx.beginPath();
  for (const marker of markers) {
    if (marker.count > 1) {
      diamondPath(ctx, marker.x, lane.centerY, KEYFRAME_SIZE_PX);
    }
  }
  ctx.fillStyle = opts.colors.keyframeMerged;
  ctx.fill();
}

export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  opts: DrawOptions,
) {
  const colors = opts.colors ?? defaultColors;
  const provider = opts.provider ?? nullTileProvider;
  const peaks = opts.peaks ?? nullPeakProvider;
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
      peaks,
      colors,
      range: opts.range,
      viewportW: opts.viewportW,
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
