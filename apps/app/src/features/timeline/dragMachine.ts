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
      /**
       * The primary mouse button. Defaults to true when the caller says
       * nothing, so a `down` that predates this flag behaves as it always did.
       *
       * A right press has to reach the reducer rather than being dropped by the
       * component, because it still *settles the selection* — the context menu
       * that follows acts on whatever this leaves behind. What it must not do
       * is arm a gesture: the menu opens over the canvas, so tracking the
       * pointer would sweep a band underneath it as the hand moves to the menu.
       */
      primary?: boolean;
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
  /**
   * A rubber-band sweeping empty space, selecting whatever it touches.
   *
   * Deliberately absent from `isMoving` below: every other moving phase ends in
   * a checkpoint and a commit, and a band edits no document. What it does
   * change — the selection — has already been applied, live, on every move.
   */
  | "marquee"
  | "trimStart"
  | "trimEnd"
  /**
   * Dragging one end of a transition badge to change its length.
   *
   * Two phases rather than one because the two ends grow it in opposite
   * directions, exactly as `trimStart` and `trimEnd` do. It never moves the
   * badge: a transition is anchored to its cut, and the cut only moves when a
   * clip does.
   */
  | "transitionStart"
  | "transitionEnd";

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
  /**
   * Put the selection back to what it was when the press began.
   *
   * `revert` throws away a *document* a drag was previewing; a cancelled band
   * has no document to throw away and a selection that does need putting back.
   * Two effects rather than one name with two meanings, so the choice sits in
   * the reducer where a test can reach it instead of in a phase check the
   * component would have to make for itself.
   */
  | { type: "restoreSelection" }
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
    phase === "trimEnd" ||
    phase === "transitionStart" ||
    phase === "transitionEnd"
  );
}

/**
 * Effects that describe what a press did to the *selection*, as opposed to what
 * it started. A non-primary press keeps the first kind and drops the second.
 */
function isSelectionEffect(effect: DragEffect): boolean {
  return effect.type === "clearSelection" || effect.type === "restoreSelection";
}

export function reduceDrag(
  state: DragState,
  ev: PointerEv,
  cfg: DragConfig = DRAG,
): { state: DragState; effects: DragEffect[] } {
  switch (ev.type) {
    case "down": {
      const base: DragState = {
        ...idleDrag,
        origin: { x: ev.x, y: ev.y },
        downT: ev.t,
        hit: ev.hit,
        shift: ev.shift === true,
      };

      // A non-primary press still settles the selection below — the context
      // menu about to open acts on what it leaves — but it arms nothing. Stated
      // once, here, rather than at each `return`: every gesture this reducer
      // can start is one a right press must not.
      const arm = (next: DragState, effects: DragEffect[] = []) =>
        ev.primary === false
          ? { state: idleDrag, effects: effects.filter(isSelectionEffect) }
          : { state: next, effects };

      if (ev.hit.kind === "transition") {
        if (ev.hit.zone === "resizeStart") {
          return arm({ ...base, phase: "transitionStart" }, [
            { type: "cursor", value: "ew-resize" },
          ]);
        }
        if (ev.hit.zone === "resizeEnd") {
          return arm({ ...base, phase: "transitionEnd" }, [
            { type: "cursor", value: "ew-resize" },
          ]);
        }
        // The body selects it, so the option panel opens. There is nothing to
        // drag: a transition cannot be moved off its cut.
        return arm({ ...base, phase: "pressed" });
      }

      // A bare cut is a click target, not a drag: pressing it adds a
      // transition. `pressed` lets `up` distinguish that from a press that
      // turned into something else.
      if (ev.hit.kind === "cut") {
        return arm({ ...base, phase: "pressed" });
      }

      if (ev.hit.kind !== "clip") {
        // Empty space, or the bare part of a track row. Either can become a
        // rubber-band, so the press stays undecided rather than ending here —
        // but what it does to the *selection* is exactly what it always did,
        // on the way down, which is what keeps a plain click on nothing
        // clearing it and keeps `targetIdDuringRightClick` reading the same.
        //
        // Shift is the exception, and the first time this reducer reads the
        // flag it has always carried: shift means "add to what is selected",
        // and clearing first would leave nothing to add to.
        return arm(
          { ...base, phase: "pressed" },
          base.shift ? [] : [{ type: "clearSelection" }],
        );
      }

      if (ev.hit.zone === "trimStart" || ev.hit.zone === "trimEnd") {
        // Handles have no second meaning, so there is nothing to wait for.
        return arm({ ...base, phase: ev.hit.zone }, [
          { type: "cursor", value: "ew-resize" },
        ]);
      }

      if (ev.alt === true) {
        // An escape hatch for anyone who does not want to wait out the hold.
        return arm({ ...base, phase: "moveFree", free: true }, [
          { type: "armed" },
          { type: "cursor", value: "grabbing" },
        ]);
      }

      return arm({ ...base, phase: "pressed" });
    }

    case "move": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }

      const dxPx = ev.x - state.origin.x;
      const dyPx = ev.y - state.origin.y;

      if (state.phase === "pressed") {
        // A press on nothing escalates into a rubber-band. The same constant
        // and the same strict comparison a slide uses: "did the pointer move"
        // is one fact, so it gets one boundary and one test.
        if (state.hit.kind === "none" || state.hit.kind === "track") {
          if (Math.hypot(dxPx, dyPx) > cfg.MOVE_CANCEL_PX) {
            return {
              state: { ...state, phase: "marquee", dxPx, dyPx },
              effects: [{ type: "cursor", value: "crosshair" }],
            };
          }
          return { state: { ...state, dxPx, dyPx }, effects: [] };
        }

        // Only a clip escalates into a slide. A transition is anchored to its
        // cut and a bare cut is not an object at all, so both stay `pressed`
        // until the pointer comes up — which is what makes them clicks.
        if (state.hit.kind !== "clip") {
          return { state: { ...state, dxPx, dyPx }, effects: [] };
        }

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

      // `marquee` falls through to here on purpose, and gets both axes: unlike
      // the slide above it, a band is dragged in whatever direction the hand
      // goes and its height is half of what it means.
      return { state: { ...state, dxPx, dyPx }, effects: [] };
    }

    case "tick": {
      // Only `pressed` is still undecided. Travel does not need re-checking
      // here: any move past the tolerance has already turned the gesture into
      // a slide, so a state that is still `pressed` has not moved far.
      if (state.phase !== "pressed") {
        return { state, effects: [] };
      }
      // Only a clip can come free of its track. Holding on a transition, a
      // bare cut, or the empty space a band starts from has no second meaning
      // to unlock — which is why the component can arm its long-press timer on
      // every press without knowing which gestures can be freed.
      if (state.hit.kind !== "clip") {
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
      if (state.phase === "marquee") {
        // Nothing to commit and nothing to undo. The selection was applied as
        // the band swept, and a selection is not a document edit — which is
        // also why `marquee` is not in `isMoving`.
        return {
          state: idleDrag,
          effects: [{ type: "cursor", value: "default" }],
        };
      }
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
      if (state.phase === "marquee") {
        // Escape has to take back the sweep as well as the band. Removing the
        // band and leaving the clips it selected behind would be worse than
        // not handling Escape at all.
        return {
          state: idleDrag,
          effects: [
            { type: "restoreSelection" },
            { type: "cursor", value: "default" },
          ],
        };
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
