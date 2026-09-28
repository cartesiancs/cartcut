/**
 * The count between "Start Recording" and the first frame.
 *
 * Without it the take began the instant the tray menu closed, so every
 * recording opened on the pointer travelling back from the menu bar and on a
 * person who had not yet drawn breath. The count gives both a known moment to
 * be ready by.
 *
 * Every step is scheduled against the moment the count began rather than
 * chained one timeout after another, so the lateness of one timer is not
 * carried into the next and the last step lands `from * stepMs` after the
 * click.
 *
 * Only the numbers are here. Clearing the numeral is the engine's job, and it
 * does it once the writers are running, so the number leaves the screen when
 * the recording has actually begun rather than a device-open before.
 *
 * Pure, DOM-free.
 */

export const COUNTDOWN_FROM = 3;
export const COUNTDOWN_STEP_MS = 1000;

export type Countdown = {
  /** `true` once the last step has run its length, `false` if cancelled first. */
  readonly done: Promise<boolean>;
  /** Stop the count. Safe to call more than once, and after it has finished. */
  cancel(): void;
};

export function startCountdown(options: {
  from: number;
  stepMs: number;
  /** Called with `from`, `from - 1`, ... `1`, the first of them synchronously. */
  onStep: (remaining: number) => void;
}): Countdown {
  const { from, stepMs, onStep } = options;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let settle: (completed: boolean) => void = () => {};
  let settled = false;

  const done = new Promise<boolean>((resolve) => {
    settle = (completed) => {
      if (settled) {
        return;
      }
      settled = true;
      timers.forEach((timer) => clearTimeout(timer));
      resolve(completed);
    };
  });

  const steps = Math.max(0, Math.floor(from));

  if (steps === 0) {
    settle(true);
    return { done, cancel: () => settle(false) };
  }

  onStep(steps);

  for (let index = 1; index < steps; index += 1) {
    timers.push(setTimeout(() => onStep(steps - index), index * stepMs));
  }
  timers.push(setTimeout(() => settle(true), steps * stepMs));

  return { done, cancel: () => settle(false) };
}
