/**
 * Turning a horizontal drag into a number.
 *
 * The arithmetic of a Figma-style scrub, with no DOM in it — the pointer lock,
 * the listeners and the cursor all live in `scrubSession.ts`. Keeping the sums
 * here is what lets them be tested under `environment: "node"`, the same rule
 * `features/timeline/` follows.
 *
 * Three decisions carry the whole module, and each is load-bearing:
 *
 * - **The accumulator is in value space, not pixel space.** `raw` is advanced by
 *   `movementX * sensitivity * factor` on every event. Accumulating *pixels* and
 *   multiplying at the end would mean that pressing Shift halfway through a drag
 *   retroactively rescales the distance already travelled, and the number jumps.
 *
 * - **`raw` itself is clamped, not just the value read out of it.** Clamping only
 *   on the way out lets the accumulator wind up: drag 500px past the maximum and
 *   you must drag 500px back before the number moves at all.
 *
 * - **Crossing the threshold spends the threshold.** The travel that recognised
 *   the drag is subtracted, so the value at the instant of engagement is exactly
 *   the value the field started with. That also quietly absorbs a second
 *   discontinuity: before the lock `movementX` is a CSS-pixel screen delta and
 *   after it is an OS-accelerated device delta, and the scale changes at the one
 *   moment when nothing has moved yet.
 */

/** Pixels of travel before a press counts as a drag rather than a click. */
export const SCRUB_THRESHOLD_PX = 4;
/** Shift — the After Effects/Premiere convention. */
export const SCRUB_COARSE = 10;
/** Command / Control. */
export const SCRUB_FINE = 0.1;
/**
 * The most one event may move the value, in pixels.
 *
 * Chromium warps the cursor to the centre of the window as the lock engages and
 * can report that warp as a single enormous `movementX`; waking from a display
 * change or an app switch has the same shape. Neither is travel the user made.
 */
export const SCRUB_MAX_STEP_PX = 200;

export type ScrubOptions = {
  /** Value units per pixel of travel, before any modifier. */
  sensitivity: number;
  /** The grid the emitted value snaps to. `0` means no snapping. */
  step: number;
  min?: number;
  max?: number;
  /** Decimal places the emitted value is rounded to. Default 2. */
  decimals?: number;
  /** Default `SCRUB_THRESHOLD_PX`. */
  threshold?: number;
};

export type ScrubModifiers = {
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
};

export type ScrubState = {
  readonly startValue: number;
  /** The unquantized accumulator, already clamped to `min`/`max`. */
  readonly raw: number;
  /** Signed pixels seen while the drag was still being recognised. */
  readonly armed: number;
  readonly dragging: boolean;
};

/** Fine beats coarse: holding both is a request to slow down, not to speed up. */
export function scrubFactor(modifiers: ScrubModifiers): number {
  if (modifiers.meta === true || modifiers.ctrl === true) {
    return SCRUB_FINE;
  }
  if (modifiers.shift === true) {
    return SCRUB_COARSE;
  }
  return 1;
}

/** The modifier state of a mouse or keyboard event, in this module's vocabulary. */
export function modifiersOf(event: {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): ScrubModifiers {
  return {
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    ctrl: event.ctrlKey === true,
  };
}

function clampValue(value: number, options: ScrubOptions): number {
  let next = value;
  if (options.min != null && next < options.min) {
    next = options.min;
  }
  if (options.max != null && next > options.max) {
    next = options.max;
  }
  return next;
}

/** Two decimal places by default, and the float artefact that comes with them removed. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function beginScrub(value: number): ScrubState {
  const start = Number.isFinite(value) ? value : 0;
  return { startValue: start, raw: start, armed: 0, dragging: false };
}

/**
 * Fold one pointer movement into the drag.
 *
 * Returns its input **by identity** when nothing changed — the decline
 * convention the pure ops in `features/timeline/` follow, and here it is what
 * keeps a stationary mousemove from waking the store.
 */
export function scrubMove(
  state: ScrubState,
  movementX: number,
  modifiers: ScrubModifiers,
  options: ScrubOptions,
): ScrubState {
  const px = Number.isFinite(movementX)
    ? Math.max(-SCRUB_MAX_STEP_PX, Math.min(SCRUB_MAX_STEP_PX, movementX))
    : 0;
  if (px === 0) {
    return state;
  }

  const perPixel = options.sensitivity * scrubFactor(modifiers);

  if (state.dragging) {
    const raw = clampValue(state.raw + px * perPixel, options);
    if (raw === state.raw) {
      return state;
    }
    return { ...state, raw };
  }

  const threshold = options.threshold ?? SCRUB_THRESHOLD_PX;
  const armed = state.armed + px;
  if (Math.abs(armed) < threshold) {
    return { ...state, armed };
  }

  // Spend the threshold on recognising the drag, so engagement itself moves
  // nothing. See the header.
  const excess = armed - Math.sign(armed) * threshold;
  return {
    startValue: state.startValue,
    armed,
    dragging: true,
    raw: clampValue(state.startValue + excess * perPixel, options),
  };
}

/** The number to show and emit for a drag in this state. */
export function scrubValueOf(state: ScrubState, options: ScrubOptions): number {
  const snapped =
    options.step > 0
      ? Math.round(state.raw / options.step) * options.step
      : state.raw;
  // Clamped after snapping, because the snap can step over the bound.
  return roundTo(clampValue(snapped, options), options.decimals ?? 2);
}

/**
 * One keyboard nudge, in the same vocabulary.
 *
 * The arrow keys and the drag have to agree — `step` is the same grid, and the
 * modifiers are the same multipliers — so they share this module rather than
 * each carrying their own idea of what Shift means.
 */
export function nudgeValue(
  value: number,
  direction: 1 | -1,
  modifiers: ScrubModifiers,
  options: ScrubOptions,
): number {
  const grid = options.step > 0 ? options.step : 1;
  const next = value + direction * grid * scrubFactor(modifiers);
  return roundTo(clampValue(next, options), options.decimals ?? 2);
}
