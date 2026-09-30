/**
 * Painting the ruler band, from a tick plan `rulerTicks.ts` has already laid
 * out.
 *
 * Kept apart from `element-timeline-ruler` so the look can be drawn onto a Skia
 * canvas under `environment: "node"` and checked in pixels; the component only
 * measures, plans and calls this.
 *
 * The band is the timeline's own background with a hairline under it. Ticks
 * rise from that hairline and the labels sit above them in the greys the
 * sidebar and the inspector use for a muted label, so the ruler reads as chrome
 * and the clips below stay the brightest thing on the timeline.
 */

import type { RulerPlan } from "./rulerTicks";
import { LABEL_FONT, defaultColors } from "./draw";

/** The ruler's height, in CSS px. `RULER_OFFSET` in `layout.ts` clears it. */
export const RULER_HEIGHT_PX = 30;

export type RulerColors = {
  band: string;
  /** The hairline along the band's lower edge. */
  edge: string;
  minorTick: string;
  majorTick: string;
  label: string;
  playhead: string;
};

export const defaultRulerColors: RulerColors = {
  // `$background-color`, so the ruler and the timeline under it are one
  // surface. The hairline is what separates them.
  band: defaultColors.background,
  // `$opt-line` in `_option.scss`.
  edge: "rgba(255, 255, 255, 0.07)",
  // A minor tick every 8px is a texture, and anything brighter reads as a comb
  // laid over the labels.
  minorTick: "rgba(255, 255, 255, 0.16)",
  majorTick: "rgba(255, 255, 255, 0.3)",
  // `$opt-label`.
  label: "#7f878f",
  // The line `draw.ts` paints down the timeline, so head and line are one mark.
  playhead: defaultColors.playhead,
};

/** Ticks stand on the hairline; a labelled one is taller. */
const MINOR_TICK_PX = 4;
const MAJOR_TICK_PX = 9;
/** Label inset from its tick, and its baseline. */
const LABEL_INSET_PX = 4;
const LABEL_BASELINE_PX = 14;

/** The playhead head: a rounded tab narrowing to the 2px line beneath it. */
const HEAD_WIDTH_PX = 11;
const HEAD_HEIGHT_PX = 13;
/** Where the tab's straight sides give way to the taper, above the bottom. */
const HEAD_TAPER_PX = 5;
const HEAD_RADIUS_PX = 3;
/** Half of `draw.ts`'s 2px playhead line. */
const HEAD_NECK_PX = 1;
/** The band-coloured ring that keeps ticks and labels off the head. */
const HEAD_RING_PX = 3;

export type RulerDrawOptions = {
  plan: RulerPlan;
  /** CSS px; the context's transform already maps them to device pixels. */
  width: number;
  height: number;
  /** Centre of the playhead line, in canvas px. */
  playheadX: number;
  colors?: RulerColors;
};

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  opts: RulerDrawOptions,
): void {
  const { plan, width, height, playheadX } = opts;
  const colors = opts.colors ?? defaultRulerColors;
  const floor = height - 1;

  ctx.fillStyle = colors.band;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = colors.edge;
  ctx.fillRect(0, floor, width, 1);

  // Filled rects on whole pixels rather than strokes: a 1px stroke centred on a
  // fractional x smears across two pixels at half strength, which was most of
  // why the old ticks looked soft.
  for (const tick of plan.ticks) {
    const x = Math.round(tick.x);
    const length = tick.major ? MAJOR_TICK_PX : MINOR_TICK_PX;
    ctx.fillStyle = tick.major ? colors.majorTick : colors.minorTick;
    ctx.fillRect(x, floor - length, 1, length);
  }

  // Filled, never stroked. `strokeText` traced each glyph's outline in white,
  // which at 11px is a bold, blurred word rather than a label.
  ctx.font = LABEL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.label;
  for (const tick of plan.ticks) {
    if (tick.label != null) {
      ctx.fillText(
        tick.label,
        Math.round(tick.x) + LABEL_INSET_PX,
        LABEL_BASELINE_PX,
      );
    }
  }

  drawPlayheadHead(ctx, playheadX, width, height, colors);
}

function drawPlayheadHead(
  ctx: CanvasRenderingContext2D,
  cx: number,
  width: number,
  height: number,
  colors: RulerColors,
): void {
  const half = HEAD_WIDTH_PX / 2;
  // Half the tab plus the ring stroked around it: past that, no pixel of the
  // head lands on the canvas.
  const reach = half + HEAD_RING_PX / 2;
  if (!Number.isFinite(cx) || cx < -reach || cx > width + reach) {
    return;
  }

  const left = cx - half;
  const right = cx + half;
  const top = height - HEAD_HEIGHT_PX;
  const shoulder = height - HEAD_TAPER_PX;
  const r = HEAD_RADIUS_PX;

  ctx.beginPath();
  ctx.moveTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.lineTo(right - r, top);
  ctx.arcTo(right, top, right, top + r, r);
  ctx.lineTo(right, shoulder);
  ctx.lineTo(cx + HEAD_NECK_PX, height);
  ctx.lineTo(cx - HEAD_NECK_PX, height);
  ctx.lineTo(left, shoulder);
  ctx.closePath();

  // A ring of the band's own grey first, so a tick or a label passing behind
  // the head stops short of it instead of touching it.
  ctx.lineJoin = "round";
  ctx.lineWidth = HEAD_RING_PX;
  ctx.strokeStyle = colors.band;
  ctx.stroke();

  ctx.fillStyle = colors.playhead;
  ctx.fill();
}
