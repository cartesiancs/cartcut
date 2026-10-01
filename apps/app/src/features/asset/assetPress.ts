/**
 * What a press on an asset tile turns into: a click, or a drag.
 *
 * Two gestures start identically and have to be told apart. Clicking an asset
 * drops it at the playhead — the panel's original and most-used behaviour.
 * Dragging one onto the timeline says *where* and *on which track*, which is
 * the whole point of having tracks. Native HTML5 drag begins on the first few
 * pixels of movement, which is what decides the two for a mouse and what makes
 * a permanently `draggable` tile hostile to scrolling by touch.
 *
 * A mouse needs nothing more than the browser's own threshold. Chromium starts
 * a native drag only once the pointer has travelled more than 4px, the same
 * tolerance the hold below uses to tell a click from a move, so arming on the
 * press itself costs a click nothing: down and up on the spot is still "add
 * this", and a press that sets off is a drag at once. Making the hold a
 * requirement there was what made dragging an asset to the timeline feel
 * broken: a press that moved straight away was thrown out as a scroll.
 *
 * Except that the browser's 4px are *device* pixels: on a 2x display a native
 * drag starts after 2 CSS px, which a click that slips on a trackpad easily
 * covers. So a drag that ends with no drop, never having travelled further
 * than the hold's own tolerance, is the click it was meant to be (`dragend`).
 *
 * Every other pointer keeps the hold. A finger pressed on the panel and moved
 * is scrolling it, so time separates the two there, the same way
 * `timeline/dragMachine.ts` separates sliding a clip from lifting it and with
 * the same constants. Hold still and the tile arms, at which point `draggable`
 * goes on and the browser's own drag can start. Move first and the gesture is
 * neither: it is the panel being scrolled, and it must not leave a clip behind.
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
  | "armed"
  /**
   * A drag really did start.
   *
   * The distinction between this and `armed` is the whole reason the phase
   * exists. Arming used to be treated as "the user wants to drag", so releasing
   * from it added nothing — which broke clicking outright, because a relaxed
   * click is easily slower than the 220ms hold and there is nothing about
   * pressing and releasing on the spot that means anything but "add this".
   * Only a drag that actually began should suppress the add, and only the
   * browser can say when one did.
   */
  | "dragging";

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
  | {
      type: "down";
      x: number;
      y: number;
      t: number;
      /**
       * Arm on the press, without waiting out the hold. For a mouse, whose
       * press-and-move means "drag" and never "scroll". Absent means the hold
       * applies, so a `down` that predates this flag behaves as it always did.
       */
      immediate?: boolean;
    }
  | { type: "move"; x: number; y: number; t: number }
  /** A clock pulse, so the hold can complete without any pointer motion. */
  | { type: "tick"; t: number }
  | { type: "up"; t: number }
  /** The browser began a native drag. Only it knows when that happened. */
  | { type: "dragstart" }
  /**
   * The native drag finished.
   *
   * `dropped` is whether a target took it (`dropEffect` other than "none").
   * `travelPx` is the furthest the pointer got from the press, in CSS px.
   */
  | { type: "dragend"; dropped: boolean; travelPx: number }
  /** `pointercancel`. */
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
      const base = { origin: { x: ev.x, y: ev.y }, downT: ev.t };
      if (ev.immediate === true) {
        return {
          state: { ...base, phase: "armed" },
          effects: [{ type: "arm" }],
        };
      }
      return { state: { ...base, phase: "pressed" }, effects: [] };
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

    case "dragstart": {
      if (state.phase !== "armed") {
        // Refused. The caller turns this into `preventDefault`, which is what
        // actually stops a short press from dragging — `draggable` can still
        // be on for a frame after the attribute is written.
        return { state, effects: [] };
      }
      return { state: { ...state, phase: "dragging" }, effects: [] };
    }

    case "up": {
      if (state.phase === "pressed") {
        // Down and up without the hold: a click.
        return { state: idlePress, effects: [{ type: "open" }] };
      }
      if (state.phase === "armed") {
        // Held past the threshold, released on the spot, never dragged. Still
        // a click — the hold completing says the tile *could* be dragged, not
        // that it was. A native drag would have taken the pointer stream away
        // and ended in `dragend`, so reaching here means it never started.
        return { state: idlePress, effects: [{ type: "disarm" }, { type: "open" }] };
      }
      if (state.phase === "dragging") {
        return { state: idlePress, effects: [{ type: "disarm" }] };
      }
      return { state, effects: [] };
    }

    case "dragend": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }
      // Dropped somewhere, or carried off and let go: the drop target already
      // placed the asset where the user aimed, and a second copy at the
      // playhead would be wrong. Neither, and no further than a click may
      // shake, it was a click that the browser's threshold mistook for a drag.
      const click = !ev.dropped && ev.travelPx <= cfg.MOVE_CANCEL_PX;
      return {
        state: idlePress,
        effects: click
          ? [{ type: "disarm" }, { type: "open" }]
          : [{ type: "disarm" }],
      };
    }

    case "cancel": {
      // Chromium sends `pointercancel` the moment it starts a native drag, as
      // the spec says to. That is the drag taking the pointer over, not the
      // gesture ending, and `dragend` is what will end it.
      if (state.phase === "idle" || state.phase === "dragging") {
        return { state, effects: [] };
      }
      return { state: idlePress, effects: [{ type: "disarm" }] };
    }
  }
}
