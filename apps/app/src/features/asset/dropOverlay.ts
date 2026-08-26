/**
 * Whether the "Drop File" curtain is up.
 *
 * The curtain covers the whole window at `z-index: 10000`, which makes every
 * mistake about it expensive:
 *
 *  - It used to rise on any `dragenter` at all, so dragging an asset from the
 *    panel to the timeline raised it over the canvas and swallowed the drop.
 *  - `dragenter`/`dragover` were bound to `document` but `dragleave`/`drop` to
 *    the curtain itself, so a drag that left the window without dropping left
 *    the curtain up over a dead UI with no way to dismiss it.
 *  - `dragleave` fires every time the pointer crosses into a child element, so
 *    a naive show/hide flickers the whole way across the window.
 *
 * A counter fixes the third, and making `drop` and `end` unconditional resets
 * fixes the second: there is no event sequence that leaves `visible` true with
 * no drag in progress.
 */

import type { DropIntent } from "./dropIntent";

export type OverlayState = {
  /**
   * How many nested elements the drag is currently inside.
   *
   * `dragenter`/`dragleave` come in pairs as the pointer crosses element
   * boundaries, so the curtain belongs up while this is above zero rather than
   * on the most recent event.
   */
  depth: number;
  visible: boolean;
};

export const idleOverlay: OverlayState = { depth: 0, visible: false };

export type OverlayEv =
  | { type: "enter"; intent: DropIntent }
  | { type: "leave" }
  | { type: "drop" }
  /** `dragend`, a window blur, Escape — any way a drag stops being a drag. */
  | { type: "end" };

/**
 * Fold one drag event into the curtain's state.
 *
 * Returns its input by identity when nothing changed, so a caller can skip the
 * re-render — and so a test can pin "an asset drag does not touch the curtain"
 * with `toBe` rather than by comparing fields.
 */
export function reduceOverlay(
  state: OverlayState,
  ev: OverlayEv,
): OverlayState {
  switch (ev.type) {
    case "enter": {
      // Only files from outside get a curtain. An asset drag has a target of
      // its own — the timeline canvas — and must reach it.
      if (ev.intent !== "os-files") {
        return state;
      }
      return { depth: state.depth + 1, visible: true };
    }

    case "leave": {
      if (state.depth === 0) {
        return state;
      }
      const depth = state.depth - 1;
      return { depth, visible: depth > 0 };
    }

    case "drop":
    case "end": {
      if (state.depth === 0 && !state.visible) {
        return state;
      }
      return idleOverlay;
    }
  }
}
