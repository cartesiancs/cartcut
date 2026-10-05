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
