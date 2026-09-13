/**
 * The level rubber band: where a clip's gain envelope is drawn, and what a
 * press on it means.
 *
 * The line every editor puts across an audio clip. Drag it to change the level,
 * add points to it to shape one, drag a point to place a fade. Premiere,
 * Resolve and Final Cut all draw the same thing, and the vocabulary here is
 * theirs.
 *
 * **Deliberately the opposite of `keyframeMarkers.ts`.** That module keeps its
 * diamonds out of `TimelineLayout` so a press can never land on them, which is
 * right for a display-only lane. This one has to be grabbed, so `layout.ts`
 * imports it and `hitTest` asks it. The dependency runs one way only, exactly
 * as `draw.ts` depends on `keyframeMarkers.ts` and neither is imported back:
 * `ClipRect` comes in as a **type**, so there is no runtime cycle.
 *
 * Pure and DOM-free.
 */

import type { TimelineElement } from "../../@types/timeline";
import {
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  clampVolumeDb,
  isAudibleElement,
  volumeDbAt,
  volumeDbOf,
} from "./audio";
import { msToPxSigned, spanLength, spanStart } from "./geometry";
import type { ClipRect } from "./layout";

/** How near the line a press has to be to mean the line rather than the clip. */
export const LEVEL_GRAB_PX = 4;
/** The same for a point, which is a smaller target and a more specific intent. */
export const LEVEL_POINT_GRAB_PX = 6;
/** Drawn radius of a point. */
export const LEVEL_POINT_R_PX = 3;
/**
 * The top of the band, measured from the top of the clip.
 *
 * The label is drawn at `rect.y + 2` in a 12px face, so it occupies about the
 * first sixteen pixels; a line at +12 dB any higher than this would run through
 * its halo and be unreadable. One pixel of clearance and no more, because on a
 * 40px row every pixel taken from the band is a pixel of level resolution.
 */
export const LEVEL_TOP_INSET_PX = 17;
/**
 * Below this the band is too short to aim at and no line is offered.
 *
 * The rule `layout.ts` states for a locked clip's trim handles: an affordance
 * that could only be fumbled is not offered, because it also swallows the drag
 * that would have moved the clip.
 */
export const LEVEL_MIN_BAND_PX = 12;

/** The strip of a clip the level line may occupy. */
export type LevelBand = { top: number; height: number };

/** What a press on the band landed on. */
export type LevelHit =
  /** The line itself, away from any point. */
  | { kind: "line" }
  /** An authored keyframe, by index into the `x` lane. */
  | { kind: "point"; index: number };

/**
 * The band this clip's level line lives in, or `null` if it has none.
 *
 * **It runs to the bottom of the clip, keyframe lane included.** The waveform
 * insets out of the lane's way and the line deliberately does not, because the
 * arithmetic does not leave room: a 40px row minus the label is 23 pixels, and
 * taking the lane's 8 as well leaves 11, which is under the minimum. The line
 * would then vanish the moment the user added the first keyframe, which is the
 * one moment it must not.
 *
 * The overlap costs almost nothing. The diamonds sit in the bottom 8px, so the
 * line only reaches them near the floor of the fader, and both are drawn with
 * the same dark halo.
 *
 * Gated on `isAudibleElement`, which is what `draw.ts#canShowWaveform` asks
 * too, so the line appears and disappears with the waveform. A video whose
 * audio has been detached loses both at the moment the new clip gains them.
 */
export function levelBandOf(
  rect: ClipRect,
  element: TimelineElement,
): LevelBand | null {
  if (!isAudibleElement(element)) {
    return null;
  }
  const top = rect.y + LEVEL_TOP_INSET_PX;
  const height = rect.h - LEVEL_TOP_INSET_PX;
  if (height < LEVEL_MIN_BAND_PX) {
    return null;
  }
  return { top, height };
}

/**
 * Where the scale bends, and how much of the band it has spent by then.
 *
 * A fader taper. The band is 23 pixels on a 40px row and the range is 72 dB,
 * so a straight mapping gives 3.1 dB per pixel and -18 dB sits six pixels below
 * unity: drawn, that is the difference between a clip at full level and one
 * turned down by two thirds, and the two are not distinguishable. Measured on a
 * rendered strip before this existed, and it is the reason the taper is here.
 *
 * So three quarters of the band carries +12 to -18, where all level work
 * happens, at about 1.8 dB per pixel, and the last quarter carries -18 to -60,
 * where the only question is how fast it reaches silence. Every physical fader
 * is laid out this way for the same reason.
 */
export const LEVEL_KNEE_DB = -18;
const LEVEL_KNEE_FRACTION = 0.75;

/**
 * Where a level sits in the band, 0 at the top and 1 at the bottom.
 *
 * Piecewise linear in dB, bending at `LEVEL_KNEE_DB`, and exactly invertible by
 * `dbFromFraction` below. Both ends are exact: +12 is 0 and -60 is 1, so the
 * fader reaches silence at the bottom of the band rather than somewhere near
 * it.
 *
 * **Not `audioLevel.ts#meterFractionOf`, and the two must not be merged.** That
 * one maps a *meter* reading, which is output dBFS and cannot exceed 0. This
 * maps a clip's *gain*, which can, and it is tapered where the meter is not.
 * They would still look alike at a glance, and unifying them would silently
 * rescale one of them.
 */
export function levelFractionOf(db: number): number {
  const clamped = clampVolumeDb(db);
  if (clamped >= LEVEL_KNEE_DB) {
    return (
      ((MAX_VOLUME_DB - clamped) / (MAX_VOLUME_DB - LEVEL_KNEE_DB)) *
      LEVEL_KNEE_FRACTION
    );
  }
  return (
    LEVEL_KNEE_FRACTION +
    ((LEVEL_KNEE_DB - clamped) / (LEVEL_KNEE_DB - MIN_VOLUME_DB)) *
      (1 - LEVEL_KNEE_FRACTION)
  );
}

/** The exact inverse of `levelFractionOf`. */
function dbFromFraction(fraction: number): number {
  if (fraction <= LEVEL_KNEE_FRACTION) {
    return clampVolumeDb(
      MAX_VOLUME_DB -
        (fraction / LEVEL_KNEE_FRACTION) * (MAX_VOLUME_DB - LEVEL_KNEE_DB),
    );
  }
  return clampVolumeDb(
    LEVEL_KNEE_DB -
      ((fraction - LEVEL_KNEE_FRACTION) / (1 - LEVEL_KNEE_FRACTION)) *
        (LEVEL_KNEE_DB - MIN_VOLUME_DB),
  );
}

/** A level as a y in the band. */
export function dbToY(db: number, band: LevelBand): number {
  return band.top + levelFractionOf(db) * band.height;
}

/** A y in the band as a level. The exact inverse of `dbToY`. */
export function yToDb(y: number, band: LevelBand): number {
  if (!(band.height > 0)) {
    return MAX_VOLUME_DB;
  }
  return dbFromFraction((y - band.top) / band.height);
}

/**
 * How many dB one pixel of travel is worth, around the level being dragged.
 *
 * Taken at the current level rather than as one number for the band, so a drag
 * moves the line at the rate the scale is drawn at: a pixel near unity is worth
 * about 1.8 dB and a pixel down in the floor about 7. Using a single average
 * would make the line lag the pointer at the top and outrun it at the bottom,
 * which is the one thing a direct-manipulation control must not do.
 */
export function dbPerPx(band: LevelBand, atDb: number): number {
  if (!(band.height > 0)) {
    return 0;
  }
  const span =
    atDb >= LEVEL_KNEE_DB
      ? (MAX_VOLUME_DB - LEVEL_KNEE_DB) / LEVEL_KNEE_FRACTION
      : (LEVEL_KNEE_DB - MIN_VOLUME_DB) / (1 - LEVEL_KNEE_FRACTION);
  return span / band.height;
}

/** The live level track, or `null` when the clip is not keyframed. */
function liveTrack(element: TimelineElement): any {
  const track = (element as any)?.animation?.volumeDb;
  if (track == null || track.isActivate !== true) {
    return null;
  }
  return Array.isArray(track.x) && track.x.length > 0 ? track : null;
}

/** Whether this clip's level is keyframed, rather than a flat line. */
export function hasLevelEnvelope(element: TimelineElement): boolean {
  return liveTrack(element) != null;
}

/**
 * The authored points of this clip's envelope, in screen coordinates.
 *
 * Empty for an unkeyframed clip, which draws a flat line and has no points to
 * grab. Times are element-local timeline ms, so the mapping is
 * `rect.x + msToPxSigned(tMs, range)` with no scroll term and no speed term:
 * `keyframeMarkers.ts` states why, and a level keyframe follows the same rule.
 */
export function levelPoints(
  rect: ClipRect,
  element: TimelineElement,
  band: LevelBand,
  range: number,
): Array<{ x: number; y: number; index: number; tMs: number; db: number }> {
  const track = liveTrack(element);
  if (track == null) {
    return [];
  }
  const span = spanLength(element);
  const out: Array<{
    x: number;
    y: number;
    index: number;
    tMs: number;
    db: number;
  }> = [];

  track.x.forEach((keyframe: any, index: number) => {
    const tMs = keyframe?.p?.[0];
    const db = keyframe?.p?.[1];
    if (typeof tMs !== "number" || typeof db !== "number") {
      return;
    }
    // A trim can leave keyframes outside the clip. They are kept, so dragging
    // the edge back out restores them, but they have nowhere to draw.
    if (tMs < 0 || tMs > span) {
      return;
    }
    out.push({
      x: rect.x + msToPxSigned(tMs, range),
      y: dbToY(db, band),
      index,
      tMs,
      db,
    });
  });

  return out;
}

/**
 * The line itself, as one y per pixel column of the clip.
 *
 * Sampled through `volumeDbAt`, the same function the preview and the meter
 * ask, so the line is a picture of what will be heard rather than a second
 * drawing of the curve. One column per pixel is the resolution the screen has;
 * `planWaveform` samples the same way for the same reason.
 */
export function levelPolyline(
  rect: ClipRect,
  element: TimelineElement,
  band: LevelBand,
  range: number,
  viewportW: number,
): Array<{ x: number; y: number }> {
  if (!(rect.w > 0)) {
    return [];
  }
  const start = spanStart(element);
  const span = spanLength(element);

  // A flat line needs two points, not a thousand. This is the common case:
  // most clips are never keyframed at all.
  if (!hasLevelEnvelope(element)) {
    const y = dbToY(volumeDbOf(element), band);
    return [
      { x: rect.x, y },
      { x: rect.x + rect.w, y },
    ];
  }

  // Clipped to the viewport, because a long clip zoomed in is otherwise
  // thousands of samples per repaint for pixels nothing will show.
  const from = Math.max(rect.x, 0);
  const to = Math.min(rect.x + rect.w, viewportW);
  if (!(to > from)) {
    return [];
  }

  const msPerPx = span / rect.w;
  const out: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(from); x <= Math.ceil(to); x++) {
    const tMs = (x - rect.x) * msPerPx;
    out.push({ x, y: dbToY(volumeDbAt(element, start + tMs), band) });
  }
  return out;
}

/** The level the line is drawn at, at one x. */
export function dbAtX(
  rect: ClipRect,
  element: TimelineElement,
  x: number,
): number {
  if (!(rect.w > 0)) {
    return volumeDbOf(element);
  }
  const span = spanLength(element);
  return volumeDbAt(element, spanStart(element) + ((x - rect.x) * span) / rect.w);
}

/**
 * What a press at `(x, y)` on this clip lands on, or `null` for the clip body.
 *
 * Points win over the line, because a press on a point is the more specific
 * intent and the two targets overlap by design.
 *
 * The caller has already decided the press is inside the clip and not in a trim
 * handle. That ordering is deliberate and is `layout.ts`'s to keep: the line
 * runs the full width of the clip, including under both handles, and trimming
 * has to keep working at the edges.
 */
export function hitLevelLine(
  rect: ClipRect,
  element: TimelineElement,
  band: LevelBand,
  range: number,
  x: number,
  y: number,
): LevelHit | null {
  for (const point of levelPoints(rect, element, band, range)) {
    if (
      Math.abs(x - point.x) <= LEVEL_POINT_GRAB_PX &&
      Math.abs(y - point.y) <= LEVEL_POINT_GRAB_PX
    ) {
      return { kind: "point", index: point.index };
    }
  }
  if (Math.abs(y - dbToY(dbAtX(rect, element, x), band)) <= LEVEL_GRAB_PX) {
    return { kind: "line" };
  }
  return null;
}
