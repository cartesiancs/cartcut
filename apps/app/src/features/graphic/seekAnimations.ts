/**
 * Setting every animation in a graphic to one moment.
 *
 * Reached through `getAnimations()` alone, a graphic lost each animation that
 * had finished with no fill: that list leaves such an animation out, so once a
 * seek carried it past its end no later seek could find it, and the element it
 * drove kept its resting style on every pass after the first. Words shown only
 * while their animation runs (`opacity: 0` at rest) vanished on replay. An
 * export never saw it, because it builds its mounts fresh and only moves
 * forwards.
 *
 * So the host keeps every animation it has seen, and seeks those. One that a
 * restyle cancelled (the fit pass, a rebuilt tree) is idle, and is dropped
 * rather than brought back: a cancelled CSS animation that is played again
 * runs on, detached from the style that made it.
 *
 * DOM-free, so the rule is tested against animations that behave as
 * Chromium's do.
 */

export type SeekableAnimation = {
  readonly playState: string;
  currentTime: number | null | unknown;
  pause(): void;
};

/**
 * Seek `kept`, after adding everything in `live` (what `getAnimations()`
 * answers now) to it, to `timeMs`.
 */
export function seekAnimations<A extends SeekableAnimation>(
  kept: Set<A>,
  live: readonly A[],
  timeMs: number,
): void {
  for (const animation of live) {
    kept.add(animation);
  }
  for (const animation of [...kept]) {
    if (animation.playState === "idle") {
      kept.delete(animation);
      continue;
    }
    animation.pause();
    animation.currentTime = timeMs;
  }
}

/** Seeks one graphic may take before the answer stands. */
export const MAX_SEEK_PASSES = 4;

/**
 * Seek, then ask again, until a pass turns up no animation it had not seen.
 *
 * A seek can create animations. An element whose parent's animated `display`
 * comes back at the new time gets its own animation during the style flush
 * that seek causes, and `list()` called before the seek could not have listed
 * it. Measured in Chromium 151 and WebKit 26.5 (`tests/e2e/FINDINGS.md`
 * section 11): one seek left such a child at its 0% keyframe. Bounded, because
 * a style that recreates an animation on every flush would otherwise never
 * settle. Returns the number of passes, for the tests.
 */
export function seekUntilSettled<A extends SeekableAnimation>(
  kept: Set<A>,
  list: () => readonly A[],
  timeMs: number,
  maxPasses = MAX_SEEK_PASSES,
): number {
  let passes = 0;
  while (passes < maxPasses) {
    const live = list();
    if (passes > 0 && live.every((animation) => kept.has(animation))) {
      break;
    }
    seekAnimations(kept, live, timeMs);
    passes += 1;
  }
  return passes;
}
