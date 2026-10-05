/**
 * How far the prompter's script has moved, as arithmetic.
 *
 * Nothing here touches the DOM, a store or a clock. `prompterSession.ts` asks
 * these questions once per animation frame and the panel only measures and
 * paints, so every number the reader sees comes out of a function a node suite
 * can call.
 *
 * ## The unit is lines per second, not pixels
 *
 * The type is sized in container units (`_prompter.scss`, `8cqi`), so a line
 * holds about the same number of characters at any window width and a wider
 * window only makes each line taller. A speed in pixels per second would read a
 * narrow window faster than a wide one at the same setting. A speed in lines
 * per second reads the same words per minute however the window is docked.
 */

/** 1.0x, the pace a new user starts at. */
export const DEFAULT_PROMPTER_SPEED = 1;
export const MIN_PROMPTER_SPEED = 0.3;
export const MAX_PROMPTER_SPEED = 3;
export const PROMPTER_SPEED_STEP = 0.1;

/**
 * Lines per second at 1.0x.
 *
 * A line at `8cqi` holds about eleven Korean syllables or twenty Latin
 * characters, three or four English words. Half a line a second is therefore
 * about 100 words a minute, slower than most people read aloud, which leaves
 * the user speeding up to their pace rather than chasing the text from the
 * first line.
 */
export const BASE_LINES_PER_SECOND = 0.5;

/**
 * The longest frame `advance` will account for.
 *
 * A frame that arrives late (a long GC, a blocked main thread, a window that
 * Chromium stopped painting) would otherwise move the text by everything it
 * missed in one step, and the reader loses their place. Capped, the text pauses
 * for the stall and carries on from where it was.
 */
export const MAX_FRAME_MS = 100;

const tenths = (value: number): number => Math.round(value * 10) / 10;

/**
 * Any value, made into a speed the panel can show.
 *
 * Runs on what `localStorage` hands back, so it has to survive a string, a
 * `NaN` or nothing at all. Rounded to tenths because the readout shows one
 * decimal, and `0.1 + 0.2` would otherwise drift the stored value away from it.
 */
export function coerceSpeed(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_PROMPTER_SPEED;
  }
  return tenths(Math.min(MAX_PROMPTER_SPEED, Math.max(MIN_PROMPTER_SPEED, raw)));
}

/**
 * One step slower or faster.
 *
 * At a bound it returns `speed` unchanged, which is how the panel knows to
 * disable the button: `stepSpeed(s, 1) === s` means there is nowhere to go.
 */
export function stepSpeed(speed: number, direction: -1 | 1): number {
  const next = coerceSpeed(tenths(speed + direction * PROMPTER_SPEED_STEP));
  return next === speed ? speed : next;
}

/** `offset`, kept inside `[0, max]`. A negative `max` is read as zero. */
export function clampOffset(offset: number, max: number): number {
  return Math.min(Math.max(offset, 0), Math.max(max, 0));
}

/**
 * The furthest the text can move: the point where its bottom meets the bottom
 * of the stage. The stylesheet pads the text so that this is also the moment
 * the last line has crossed the reading line.
 */
export function maxOffset(contentPx: number, viewportPx: number): number {
  return Math.max(0, contentPx - viewportPx);
}

/**
 * Where the text is after `dtMs` more of reading.
 *
 * `linePx` is the measured height of one line, which is what turns a speed in
 * lines per second into pixels for this frame.
 */
export function advance(
  offset: number,
  dtMs: number,
  speed: number,
  linePx: number,
  max: number,
): number {
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  const moved = speed * BASE_LINES_PER_SECOND * linePx * (dt / 1000);
  return clampOffset(offset + moved, max);
}

/** The wheel, moving the text by hand. */
export function nudge(offset: number, deltaPx: number, max: number): number {
  return clampOffset(offset + deltaPx, max);
}
