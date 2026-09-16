/**
 * A damped spring, sampled into a CSS `linear()` easing.
 *
 * CSS has no spring timing function, and the usual stand-in is a
 * `cubic-bezier` with a hump in it, which is a drawing of a spring rather than
 * one: its overshoot and its settle are whatever the four handles happen to
 * give. `linear()` takes a list of samples and interpolates between them, so a
 * spring integrated properly here reaches the compositor exactly as computed,
 * and the *duration* comes out of the same numbers as the curve rather than
 * being guessed alongside it.
 *
 * DOM-free and node-testable, like the rest of `features/`: the component's
 * only job is to hand the strings to CSS as custom properties.
 */

/**
 * The usual three, in the units every spring-animation library uses.
 *
 * `damping` is what decides the character. Below `criticalDamping` the spring
 * overshoots and comes back; at or above it, it eases in and never passes its
 * target. Which of those you want is a layout question, not a taste one: art
 * that sits flush against an edge has nowhere to overshoot *to*, and a gap
 * opens where the card shows through.
 */
export type Spring = {
  stiffness: number;
  damping: number;
  /** Defaults to 1, which is what makes stiffness and damping comparable. */
  mass?: number;
};

/**
 * The damping at which a spring stops overshooting.
 *
 * Takes only what it needs rather than a whole `Spring`: damping is the field
 * it exists to compute, so requiring one would mean inventing a value to throw
 * away.
 */
export const criticalDamping = ({
  stiffness,
  mass = 1,
}: Omit<Spring, "damping">): number => 2 * Math.sqrt(stiffness * mass);

/**
 * Where the spring is at `t` seconds, travelling from 0 to 1 from rest.
 *
 * The three cases are the three roots of the same characteristic equation, and
 * the middle one is not reachable by the under-damped branch: `sqrt(1 - 1)` is
 * zero and the angular frequency it divides by is too.
 */
export function springPosition(spring: Spring, t: number): number {
  const { stiffness, damping, mass = 1 } = spring;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (t <= 0) return 0;

  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
  }

  if (zeta === 1) {
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }

  const r = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * zeta + r;
  const r2 = -w0 * zeta - r;
  const a = -r2 / (r2 - r1);
  const b = r1 / (r2 - r1);
  return 1 + a * Math.exp(r1 * t) + b * Math.exp(r2 * t);
}

/**
 * How long until the spring has settled, in ms.
 *
 * "Settled" is within `epsilon` of 1 *and staying there*: an under-damped
 * spring crosses its target on the way to each overshoot, so the first time it
 * is close is not the time it is done. Rounded up to a whole ms because that
 * is the unit CSS is handed.
 */
export function springDurationMs(spring: Spring, epsilon = 0.004): number {
  const stepSeconds = 1 / 240;
  let settledSince: number | null = null;

  for (let i = 1; i <= 240 * 10; i++) {
    const t = i * stepSeconds;
    const close = Math.abs(springPosition(spring, t) - 1) < epsilon;

    if (!close) {
      settledSince = null;
      continue;
    }
    if (settledSince === null) settledSince = t;
    // A tenth of a second inside the band is longer than any overshoot of a
    // spring stiff enough to be worth animating.
    if (t - settledSince > 0.1) return Math.ceil(settledSince * 1000);
  }

  return 10_000;
}

/**
 * The spring as a CSS `linear()` easing.
 *
 * The samples are evenly spaced, which is what `linear()` assumes, and the
 * ends are pinned to exactly 0 and 1: the easing has to start and finish on
 * its endpoints or the property jumps by whatever the sample rounded to.
 * Interior values above 1 are the overshoot, and are allowed.
 */
export function springEasing(spring: Spring, samples = 28): string {
  const duration = springDurationMs(spring) / 1000;
  const points: string[] = [];

  for (let i = 0; i <= samples; i++) {
    if (i === 0) {
      points.push("0");
    } else if (i === samples) {
      points.push("1");
    } else {
      const value = springPosition(spring, (i / samples) * duration);
      points.push(String(Math.round(value * 10000) / 10000));
    }
  }

  return `linear(${points.join(", ")})`;
}

/**
 * The largest amount the spring passes its target by, as a fraction of the
 * travel. Zero for anything critically damped or stiffer.
 *
 * Only here so a suite can state the layout rule that picked each spring
 * below, rather than leaving it in a comment.
 */
export function springOvershoot(spring: Spring): number {
  const duration = springDurationMs(spring) / 1000;
  let peak = 0;

  for (let i = 0; i <= 2000; i++) {
    peak = Math.max(peak, springPosition(spring, (i / 2000) * duration) - 1);
  }

  return Math.max(0, peak);
}
