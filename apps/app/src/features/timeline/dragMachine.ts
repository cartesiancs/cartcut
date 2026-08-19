/**
 * What a press on a clip turns into.
 *
 * Two gestures start identically — a press on a clip body — and have to be told
 * apart without a modifier key: sliding a clip along its track, and lifting it
 * onto a different one. Time separates them. Move early and it is a horizontal
 * slide, with vertical motion ignored so a shaky hand cannot fling a clip onto
 * the wrong row. Hold still for a moment and the clip comes free, after which
 * vertical movement means what it looks like.
 *
 * Keeping this as a reducer with an injected clock is what makes the boundaries
 * testable: 219ms versus 220ms, 4px versus 5px. None of that is observable
 * once it is tangled into mouse handlers.
 */

import type { Hit } from "./layout";

export const DRAG = {
  /** Hold this long without moving and the clip comes free of its track. */
  LONG_PRESS_MS: 220,
  /** Moving further than this before the hold completes means "slide". */
  MOVE_CANCEL_PX: 4,
  /** Vertical travel before a freed clip actually changes row. */
  VERTICAL_ENTER_PX: 12,
} as const;

export type DragConfig = typeof DRAG;

export type PointerEv =
  | {
      type: "down";
      x: number;
      y: number;
      t: number;
      hit: Hit;
      shift?: boolean;
      alt?: boolean;
    }
  | { type: "move"; x: number; y: number; t: number }
  | { type: "up"; t: number }
  /** A clock pulse, so the long press can complete without pointer motion. */
  | { type: "tick"; t: number }
  | { type: "cancel" };

export type DragPhase =
  | "idle"
  | "pressed"
  | "moveH"
  | "moveFree"
  | "trimStart"
  | "trimEnd";

export type DragState = {
  phase: DragPhase;
  origin: { x: number; y: number };
  downT: number;
  hit: Hit;
  dxPx: number;
  dyPx: number;
  /** True once the hold (or Alt) unlocked vertical movement. */
  free: boolean;
  shift: boolean;
};

export type DragEffect =
  | { type: "cursor"; value: string }
  /** The hold completed: a good moment for a nudge of feedback. */
  | { type: "armed" }
  /** Pointer went down and up without a drag — a plain click. */
  | { type: "select" }
  | { type: "clearSelection" }
  | { type: "checkpoint" }
  | { type: "commit" }
  | { type: "revert" };

export const idleDrag: DragState = {
  phase: "idle",
  origin: { x: 0, y: 0 },
  downT: 0,
  hit: { kind: "none" },
  dxPx: 0,
  dyPx: 0,
  free: false,
  shift: false,
};

function isMoving(phase: DragPhase): boolean {
  return (
    phase === "moveH" ||
    phase === "moveFree" ||
    phase === "trimStart" ||
    phase === "trimEnd"
  );
}

export function reduceDrag(
  state: DragState,
  ev: PointerEv,
  cfg: DragConfig = DRAG,
): { state: DragState; effects: DragEffect[] } {
  switch (ev.type) {
    case "down": {
      if (ev.hit.kind !== "clip") {
        return {
          state: idleDrag,
          effects: [{ type: "clearSelection" }],
        };
      }

      const base: DragState = {
        ...idleDrag,
        origin: { x: ev.x, y: ev.y },
        downT: ev.t,
        hit: ev.hit,
        shift: ev.shift === true,
      };

      if (ev.hit.zone === "trimStart" || ev.hit.zone === "trimEnd") {
        // Handles have no second meaning, so there is nothing to wait for.
        return {
          state: { ...base, phase: ev.hit.zone },
          effects: [{ type: "cursor", value: "ew-resize" }],
        };
      }

      if (ev.alt === true) {
        // An escape hatch for anyone who does not want to wait out the hold.
        return {
          state: { ...base, phase: "moveFree", free: true },
          effects: [{ type: "armed" }, { type: "cursor", value: "grabbing" }],
        };
      }

      return { state: { ...base, phase: "pressed" }, effects: [] };
    }

    case "move": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }

      const dxPx = ev.x - state.origin.x;
      const dyPx = ev.y - state.origin.y;

      if (state.phase === "pressed") {
        const moved = Math.hypot(dxPx, dyPx);
        if (moved > cfg.MOVE_CANCEL_PX) {
          // Committed to a slide. Vertical is locked from here: the gesture
          // has already been classified and must not change under the hand.
          return {
            state: { ...state, phase: "moveH", dxPx, dyPx: 0 },
            effects: [{ type: "cursor", value: "grabbing" }],
          };
        }
        return { state: { ...state, dxPx, dyPx }, effects: [] };
      }

      if (state.phase === "moveH") {
        return { state: { ...state, dxPx, dyPx: 0 }, effects: [] };
      }

      return { state: { ...state, dxPx, dyPx }, effects: [] };
    }

    case "tick": {
      // Only `pressed` is still undecided. Travel does not need re-checking
      // here: any move past the tolerance has already turned the gesture into
      // a slide, so a state that is still `pressed` has not moved far.
      if (state.phase !== "pressed") {
        return { state, effects: [] };
      }
      if (ev.t - state.downT < cfg.LONG_PRESS_MS) {
        return { state, effects: [] };
      }

      return {
        state: { ...state, phase: "moveFree", free: true },
        effects: [{ type: "armed" }, { type: "cursor", value: "grabbing" }],
      };
    }

    case "up": {
      if (isMoving(state.phase)) {
        return {
          state: idleDrag,
          effects: [
            { type: "checkpoint" },
            { type: "commit" },
            { type: "cursor", value: "default" },
          ],
        };
      }
      if (state.phase === "pressed") {
        // Down and up with no drag: a selection, and nothing to undo.
        return {
          state: idleDrag,
          effects: [{ type: "select" }, { type: "cursor", value: "default" }],
        };
      }
      return { state: idleDrag, effects: [] };
    }

    case "cancel": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }
      return {
        state: idleDrag,
        effects: [{ type: "revert" }, { type: "cursor", value: "default" }],
      };
    }
  }
}

/**
 * How many rows a freed clip has travelled.
 *
 * Zero until the pointer clears `VERTICAL_ENTER_PX`, so the row does not flip
 * the instant the hold completes — the hand is rarely perfectly still at that
 * moment.
 */
export function trackDeltaFor(
  dyPx: number,
  pitch: number,
  cfg: DragConfig = DRAG,
): number {
  if (Math.abs(dyPx) < cfg.VERTICAL_ENTER_PX || pitch <= 0) {
    return 0;
  }
  return Math.round(dyPx / pitch);
}
