/**
 * Blocks arriving down a panel, and leaving up it.
 *
 * A list that lands all at once is every tile on one frame, which reads as
 * the panel blinking. Here each block gets a delay from where it sits on
 * screen, top first, so the list fills the way the eye reads it, and a grid's
 * row shares one delay because its tiles share one top. Position rather than
 * index, because one panel can hold several grids from several components
 * (the cloud view's media sections and the GIF section under them), and an
 * index only orders the blocks of the component that counted them.
 *
 * Only what is on screen moves. A block below the fold would play to nobody,
 * and a long folder would otherwise start an animation per tile in it.
 *
 * The timing is pure (`cascadeDelay`); the run takes its targets through the
 * narrow `CascadeTarget` shape, which a real `Element` already satisfies, so
 * the suite drives it with plain records under `environment: "node"`.
 */

/** A vertical extent in viewport px: what `getBoundingClientRect` answers. */
export type Span = { top: number; bottom: number };

/**
 * How long a block waits, in ms, or `null` if it is not on screen.
 *
 * `"down"` waits longer the further down the view a block starts, `"up"` the
 * reverse. A block cut by the top of the view counts as at the top. A box with
 * no height is `display: none` somewhere above it, and is not on screen either.
 */
export function cascadeDelay(
  box: Span,
  view: Span,
  spreadMs: number,
  order: "down" | "up",
): number | null {
  const span = view.bottom - view.top;
  if (!(box.bottom > box.top) || !(span > 0)) {
    return null;
  }
  if (box.bottom <= view.top || box.top >= view.bottom) {
    return null;
  }
  const at = Math.min(1, Math.max(0, (box.top - view.top) / span));
  return Math.round((order === "down" ? at : 1 - at) * spreadMs);
}

/** The part of a Web Animation a run holds on to. */
export type CascadeAnimation = {
  readonly finished: Promise<unknown>;
  reverse(): void;
  cancel(): void;
};

export type CascadeTarget = {
  getBoundingClientRect(): Span;
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): CascadeAnimation;
};

export type CascadeStep = {
  order: "down" | "up";
  keyframes: Keyframe[];
  durationMs: number;
  /** The delay of the block at the bottom of the view (or the top, going up). */
  spreadMs: number;
  /** Added to every block's delay. */
  leadMs: number;
  easing: string;
  fill: FillMode;
};

export type CascadeRun<T = CascadeTarget> = {
  /** The blocks it animated, in the order given: the ones that were on screen. */
  readonly animated: readonly T[];
  /**
   * Settles once every block has finished, in either direction, or been
   * cancelled. Never rejects: the caller decides what an interrupted run means
   * from its own state, not from an `AbortError`.
   */
  readonly finished: Promise<void>;
  /** Play every block back to where it started, from wherever it is now. */
  reverse(): void;
  cancel(): void;
};

/**
 * Animate `targets` in order down (or up) `view`.
 *
 * Every box is measured before the first animation starts. Interleaved, each
 * `animate` would dirty the style that the next measurement then has to
 * recompute, once per tile.
 */
export function cascade<T extends CascadeTarget>(
  targets: Iterable<T>,
  view: Span,
  step: CascadeStep,
): CascadeRun<T> {
  const list = Array.from(targets);
  const delays = list.map((target) =>
    cascadeDelay(target.getBoundingClientRect(), view, step.spreadMs, step.order),
  );

  const animated: T[] = [];
  const running: CascadeAnimation[] = [];
  list.forEach((target, i) => {
    const delay = delays[i];
    if (delay == null) {
      return;
    }
    animated.push(target);
    running.push(
      target.animate(step.keyframes, {
        duration: step.durationMs,
        delay: Math.max(0, step.leadMs) + delay,
        easing: step.easing,
        fill: step.fill,
      }),
    );
  });

  return {
    animated,
    finished: Promise.all(running.map((animation) => animation.finished)).then(
      () => undefined,
      () => undefined,
    ),
    reverse: () => running.forEach((animation) => animation.reverse()),
    cancel: () => running.forEach((animation) => animation.cancel()),
  };
}

/** The scroller's visible extent, or the window's when there is no scroller. */
export function viewOf(scroller: Element | null): Span {
  if (scroller != null) {
    const { top, bottom } = scroller.getBoundingClientRect();
    return { top, bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

/** The system setting, read when a run starts so a change applies to the next one. */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
