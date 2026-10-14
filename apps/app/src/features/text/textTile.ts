/**
 * What a Text panel tile shows, worked out without a canvas.
 *
 * A tile is the clip its click would add, drawn by the renderer: the same
 * `textOptionsFor` and `createTextElement`, the same `applyTextAnimation`, in a
 * one-clip timeline that `textTilePainter.ts` hands to `renderTimelineAtTime`.
 * That is the argument `animation/presetPreview.ts` and
 * `graphic/graphicPreviewProvider.ts` make for their tiles, and it buys the
 * same thing: change a preset or an animation and its tile changes with it,
 * because there is no second description of either to forget.
 *
 * This module is the arithmetic around that: the element, the instant a
 * resting tile shows, the loop a hovered tile plays, and the window of the
 * frame a tile crops to. The drawing is the painter's.
 */

import type { TextElementType, Timeline } from "../../@types/timeline";
import { createTextElement } from "../element/textElement";
import { presetDefaultMs } from "../animation/presets";
import { textOptionsFor, type PresetFrame } from "../font/textPresetOptions";
import type { TextPreset } from "../font/textPresets";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "../timeline/tracks";
import { resolveTextStyle, styleBleed } from "./style";
import {
  ANIMATED_TEXT_MS,
  DEFAULT_REST_AT,
  applyTextAnimation,
  progressStops,
  sampleTextFor,
  type TextAnimation,
} from "./textAnimations";

/**
 * Rate a tile's tracks are baked at. 240 for the reason `presetPreview.ts`
 * gives: the lanes are read by nearest sample, and a hovered tile is drawn on
 * every display frame, so a coarser bake would step visibly.
 */
export const TILE_BAKE_HZ = 240;

/** The frame an exit is laid out against on a tile. */
const TILE_FRAME_MS = 1000 / 30;

const TILE_ID = "text-tile";
const TILE_TRACK = "text-tile-track";

/** How long a hovered tile rests between plays. */
export const LOOP_HOLD_MS = 900;
/** How long an in-and-out tile rests on the whole text before it leaves. */
export const LOOP_SHOWN_MS = 600;
/** How long an in-and-out tile stays empty before it starts again. */
export const LOOP_EMPTY_MS = 300;

/**
 * The element a preset tile, or an animated tile, adds.
 *
 * The panel's click and the tile both call this, so the two are one element.
 * An animation's own sample text and its longer clip come with it.
 */
export function presetElement(
  preset: TextPreset,
  animation: TextAnimation | null,
  frame: PresetFrame,
): TextElementType {
  if (animation == null) {
    return createTextElement(textOptionsFor(preset, frame));
  }
  return createTextElement({
    ...textOptionsFor(preset, frame, sampleTextFor(animation)),
    duration: ANIMATED_TEXT_MS,
  });
}

export type TileSpec = {
  /** The frame the clip was laid out in: the project's, as the click uses. */
  frame: PresetFrame;
  /** The one-clip map the painter composites. */
  timeline: Timeline;
  /** That clip, for measuring. */
  element: TextElementType;
  /** Clip ms a resting tile shows. */
  restMs: number;
  /** The loop a hovered tile plays, or `null` for a still. */
  loop: LoopSegment[] | null;
};

/** One stretch of a hovered tile's loop: `ms` of wall time over clip `from..to`. */
export type LoopSegment = { from: number; to: number; ms: number };

export function tileSpecFor(
  preset: TextPreset,
  animation: TextAnimation | null,
  frame: PresetFrame,
): TileSpec {
  const created = presetElement(preset, animation, frame);
  const placed = { ...created, trackId: TILE_TRACK, priority: 1 } as TextElementType;

  let element = placed;
  if (animation != null) {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack(TILE_TRACK, "text", 0)],
      elements: { [TILE_ID]: placed },
    } as unknown as TimelineDocument;
    const after = applyTextAnimation(doc, TILE_ID, animation, {
      bakeHz: TILE_BAKE_HZ,
      frameMs: TILE_FRAME_MS,
    });
    element = after.elements[TILE_ID] as TextElementType;
  }

  return {
    frame,
    timeline: { [TILE_ID]: element },
    element,
    restMs: animation == null ? 0 : restMsOf(animation),
    loop: animation == null ? null : loopOf(animation, element.duration),
  };
}

export function restMsOf(animation: TextAnimation): number {
  return Math.round(animation.inMs * (animation.restAt ?? DEFAULT_REST_AT));
}

/**
 * A hovered tile's loop, as stretches of clip time.
 *
 * An arrival plays and then rests on the finished text. A whole-clip move can
 * outlast the arrival (Slow Reveal's drift), so the play runs to whichever ends
 * later, inside the clip. An exit plays too: arrive, rest, leave, a moment
 * empty, again.
 */
export function loopOf(animation: TextAnimation, clipMs: number): LoopSegment[] {
  if (animation.outMs == null) {
    const moveMs = animation.move == null ? 0 : presetDefaultMs(animation.move);
    const end = Math.min(clipMs - 1, Math.max(animation.inMs, moveMs));
    return [
      { from: 0, to: end, ms: end },
      { from: end, to: end, ms: LOOP_HOLD_MS },
    ];
  }

  const { times } = progressStops(animation, clipMs, TILE_FRAME_MS);
  const inEnd = times[1];
  const outStart = times.length === 4 ? times[2] : inEnd;
  const last = times[times.length - 1];
  return [
    { from: 0, to: inEnd, ms: inEnd },
    { from: inEnd, to: inEnd, ms: LOOP_SHOWN_MS },
    { from: outStart, to: last, ms: last - outStart },
    { from: last, to: last, ms: LOOP_EMPTY_MS },
  ];
}

/** The clip ms a hovered tile shows `elapsedMs` into its loop. */
export function loopClipTime(loop: readonly LoopSegment[], elapsedMs: number): number {
  const length = loop.reduce((sum, segment) => sum + segment.ms, 0);
  if (!(length > 0)) {
    return loop[0]?.from ?? 0;
  }
  let at = ((elapsedMs % length) + length) % length;
  for (const segment of loop) {
    if (at < segment.ms) {
      return segment.from + ((segment.to - segment.from) * at) / segment.ms;
    }
    at -= segment.ms;
  }
  return loop[loop.length - 1].to;
}

/** The tile's well: what `.asset-thumb` holds. */
export const TILE_ASPECT = 16 / 9;

/** Room around the text, so a stroke or a glow never meets the well's edge. */
const TILE_MARGIN = 1.3;

/**
 * The narrowest window, in ems. "Title" in a condensed face is under two ems
 * wide and would otherwise fill the tile edge to edge.
 */
const MIN_VIEW_EMS = 3.4;

export type TileView = { x: number; y: number; w: number; h: number };

/**
 * The part of the frame a tile shows, in project pixels: the settled text and
 * what its style draws beyond the glyphs, centred and widened to the well's
 * aspect.
 *
 * Where an animation starts its units is left out on purpose. Letter Drop
 * starts its letters most of an em above the line and Letter Zoom at three
 * times their size, and a window wide enough for either would show that one
 * tile's title at a fraction of its neighbours'. Arriving units come in from
 * past the well's edge instead, which is how a title enters a frame anyway.
 */
export function tileViewOf(
  element: TextElementType,
  block: { blockWidth: number; blockHeight: number },
): TileView {
  const style = resolveTextStyle(element);
  const band = style.background.enable ? style.background.padding : 0;
  const bleed = styleBleed(style) + band;

  const halfW = block.blockWidth / 2 + bleed;
  const halfH = block.blockHeight / 2 + bleed;
  const w =
    Math.max(2 * halfW, 2 * halfH * TILE_ASPECT, element.fontsize * MIN_VIEW_EMS) *
    TILE_MARGIN;
  const h = w / TILE_ASPECT;

  const centreX = element.location.x + element.width / 2;
  const centreY = element.location.y + block.blockHeight / 2;
  return { x: centreX - w / 2, y: centreY - h / 2, w, h };
}
