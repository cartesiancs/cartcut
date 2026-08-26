/**
 * What a press on an asset tile turns into: a click, or a drag.
 *
 * Two gestures start identically and have to be told apart. Clicking an asset
 * drops it at the playhead — the panel's original and most-used behaviour.
 * Dragging one onto the timeline says *where* and *on which track*, which is
 * the whole point of having tracks. Native HTML5 drag begins on the first few
 * pixels of movement, so wiring `draggable="true"` unconditionally makes the
 * panel hostile to scroll and turns every imprecise click into a drag.
 *
 * Time separates them, the same way `timeline/dragMachine.ts` separates sliding
 * a clip from lifting it — and with the same constants, deliberately: holding
 * to pick something up should feel identical in both halves of the editor.
 * Hold still and the tile arms, at which point `draggable` goes on and the
 * browser's own drag can start. Move first and the gesture is neither: it is
 * the panel being scrolled, and it must not leave a clip behind.
 *
 * As a reducer with an injected clock, the boundaries are testable — 219ms
 * versus 220ms, 4px versus 5px. None of that is observable once it is tangled
 * into pointer handlers.
 */

import { DRAG, type DragConfig } from "../timeline/dragMachine";

export type PressPhase =
  | "idle"
  /** Down, and still undecided. */
  | "pressed"
  /** The hold completed: `draggable` is on and a drag may start. */
  | "armed";

export type PressState = {
  phase: PressPhase;
  origin: { x: number; y: number };
  downT: number;
};

export const idlePress: PressState = {
  phase: "idle",
  origin: { x: 0, y: 0 },
  downT: 0,
};

export type PressEv =
  | { type: "down"; x: number; y: number; t: number }
  | { type: "move"; x: number; y: number; t: number }
  /** A clock pulse, so the hold can complete without any pointer motion. */
  | { type: "tick"; t: number }
  | { type: "up"; t: number }
  /** `dragend`, `pointercancel`, the element going away. */
  | { type: "cancel" };

export type PressEffect =
  /** Turn `draggable` on. Until this, `dragstart` must be refused. */
  | { type: "arm" }
  /** Turn `draggable` back off. */
  | { type: "disarm" }
  /** A plain click: add the asset at the playhead. */
  | { type: "open" };

export function reducePress(
  state: PressState,
  ev: PressEv,
  cfg: DragConfig = DRAG,
): { state: PressState; effects: PressEffect[] } {
  switch (ev.type) {
    case "down": {
      return {
        state: { phase: "pressed", origin: { x: ev.x, y: ev.y }, downT: ev.t },
        effects: [],
      };
    }

    case "move": {
      if (state.phase !== "pressed") {
        return { state, effects: [] };
      }

      // Elapsed time is checked before travel. A `move` can arrive after the
      // hold has already completed — the pointer sat still, then set off — and
      // that is an armed drag, not a cancelled one.
      if (ev.t - state.downT >= cfg.LONG_PRESS_MS) {
        return { state: { ...state, phase: "armed" }, effects: [{ type: "arm" }] };
      }

      const moved = Math.hypot(ev.x - state.origin.x, ev.y - state.origin.y);
      if (moved > cfg.MOVE_CANCEL_PX) {
        // Moving before the hold completes is the panel being scrolled. Not a
        // drag, and — the part that matters — not a click either: a flick that
        // added a clip at the playhead would be a surprise every time.
        return { state: idlePress, effects: [{ type: "disarm" }] };
      }

      return { state, effects: [] };
    }

    case "tick": {
      // Only `pressed` is still undecided, and a state that is still `pressed`
      // has not travelled — any move past the tolerance already ended it.
      if (state.phase !== "pressed") {
        return { state, effects: [] };
      }
      if (ev.t - state.downT < cfg.LONG_PRESS_MS) {
        return { state, effects: [] };
      }

      return { state: { ...state, phase: "armed" }, effects: [{ type: "arm" }] };
    }

    case "up": {
      if (state.phase === "pressed") {
        // Down and up without the hold: a click.
        return { state: idlePress, effects: [{ type: "open" }] };
      }
      if (state.phase === "armed") {
        // Held, then released without dragging anywhere. The user changed
        // their mind; adding at the playhead here would be the opposite of
        // what holding still asked for.
        return { state: idlePress, effects: [{ type: "disarm" }] };
      }
      return { state, effects: [] };
    }

    case "cancel": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }
      return { state: idlePress, effects: [{ type: "disarm" }] };
    }
  }
}
