/**
 * Placing a video handle and waiting for it to land, with an end in sight.
 *
 * A `seeked` that never came used to hold its caller forever. The case that
 * found it: a contact sheet seeking the shared handles while an edit removed
 * one of those clips. `releaseHandle` empties the element, no `seeked` ever
 * fires, so the sheet never answered, and its hold on the graphics queue kept
 * the preview from preparing a single graphic for the rest of the session.
 * Agents issue tool calls in parallel, so a sheet racing an edit is ordinary.
 * The sheet has decoders of its own now; the shared handles still serve the
 * template thumbnail, and the preview's decoder window drops them on its own.
 *
 * So the wait also ends when the element is emptied, aborted or errors, and at
 * a deadline, and says which: a caller can tell a frame it can trust from one
 * it cannot. DOM-free, so the rule is tested against a fake element.
 */

export type SeekOutcome = "seeked" | "already" | "released" | "timeout";

export type SeekTarget = {
  currentTime: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Long enough for a large file's slowest seek, short enough that nothing waits on a dead handle. */
export const SEEK_DEADLINE_MS = 5000;

const ENDS: Array<[string, SeekOutcome]> = [
  ["seeked", "seeked"],
  ["emptied", "released"],
  ["abort", "released"],
  ["error", "released"],
];

export function seekAndWait(
  target: SeekTarget,
  want: number,
  {
    deadlineMs = SEEK_DEADLINE_MS,
    setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown,
    clearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }: {
    deadlineMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Promise<SeekOutcome> {
  // Assigning the position it already holds fires no `seeked`.
  if (Math.abs(target.currentTime - want) < 1e-3) {
    return Promise.resolve("already");
  }
  return new Promise((resolve) => {
    let done = false;
    const listeners: Array<[string, () => void]> = [];
    let timer: unknown = null;
    const finish = (outcome: SeekOutcome) => {
      if (done) {
        return;
      }
      done = true;
      if (timer != null) {
        clearTimer(timer);
      }
      for (const [type, listener] of listeners) {
        target.removeEventListener(type, listener);
      }
      resolve(outcome);
    };
    for (const [type, outcome] of ENDS) {
      const listener = () => finish(outcome);
      listeners.push([type, listener]);
      target.addEventListener(type, listener);
    }
    timer = setTimer(() => finish("timeout"), deadlineMs);
    try {
      target.currentTime = want;
    } catch {
      finish("released");
    }
  });
}
