/**
 * Drag-to-scrub for an ordinary `<input type="number">`.
 *
 * The adapter between `scrubSession.ts` and a plain Bootstrap field — the
 * settings panel's, as opposed to `<number-input>`, which owns its own value.
 * Here the element is the value: the drag writes `input.value` and the panel's
 * existing handler reads it back.
 *
 * **Every field commits on release, none of them live.** That is not caution,
 * it is three separate hazards:
 *
 *   - `projectFps` runs `setProjectFps`, which re-clamps the zoom, re-snaps the
 *     playhead and rebakes every animation lane through `withCheckpoint`. A
 *     drag from 30 to 120 is ninety distinct values, so ninety rebakes and
 *     ninety history entries — against a fifty-deep stack.
 *   - The duration boxes are bound to `duration % 60` and `duration / 60`, so a
 *     seconds field driven past 59 would be rewritten to 0 under the pointer
 *     and oscillate. Committing once lets the carry happen correctly.
 *   - The resolution handlers mutate `previewSize` in place and every write
 *     reaches the preview's canvas fit.
 *
 * So the number in the box moves as you drag — which is the feedback that
 * matters — and exactly one `change` event leaves at the end.
 */

import type { ScrubOptions } from "./numberScrub";
import { isScrubStart, startScrub, windowScrubHost } from "./scrubSession";

export function beginInputScrub(event: MouseEvent, spec: ScrubOptions): void {
  const input = event.currentTarget as HTMLInputElement | null;
  if (input == null || !isScrubStart(event)) {
    return;
  }

  const parsed = Number.parseFloat(input.value);
  const startValue = Number.isFinite(parsed) ? parsed : 0;

  startScrub(
    startValue,
    spec,
    {
      onDragStart: () => {
        // The press has already focused the field the ordinary way — that is
        // deliberate, so a plain click still places a caret — and in the few
        // pixels before the lock engages it may also have started a selection.
        input.blur();
        window.getSelection?.()?.removeAllRanges();
      },
      onValue: (value) => {
        input.value = String(value);
      },
      onEnd: ({ dragged, cancelled }) => {
        if (!dragged) {
          // A click. The caret landed where the press put it; all this does is
          // make sure the field really did take focus, since the pointer lock
          // was held for the length of the press.
          if (document.activeElement !== input) {
            input.focus();
          }
          return;
        }
        if (cancelled) {
          input.value = String(startValue);
          return;
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
    },
    windowScrubHost(),
  );
}
