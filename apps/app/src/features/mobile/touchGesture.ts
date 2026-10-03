/**
 * Turns a phone's touches into the mouse gestures the editor already speaks.
 *
 * Every interactive surface in the editor (the timeline canvas, the preview,
 * the ruler, the playhead, the keyframe and speed graphs) listens for
 * `mousedown`/`mousemove`/`mouseup`. A touch browser synthesises those only for
 * a tap, never for a drag, so on a phone a clip could be selected and never
 * moved, trimmed or scrubbed. Rewriting each surface to pointer events would be
 * a rewrite of the desktop editor for the sake of the web demo; this machine
 * instead feeds those same handlers, so a finger takes exactly the code path a
 * mouse does.
 *
 * Pure and DOM-free: it takes touch points and timestamps and answers with a
 * list of commands. `touchBridge.ts` owns the listeners and the dispatch.
 *
 * A surface starts a gesture in one of two modes:
 *
 * - `mouse`: the finger is the mouse. The press is held back until the finger
 *   has moved `PRESS_SLOP_PX`, then sent where the finger first landed and
 *   followed by every move; up ends it. A press that never moved that far is
 *   replayed whole, down, up and click, when the finger lifts.
 * - `pan`: the finger scrolls the surface (empty timeline space, as in every
 *   phone editor). Moves become `pan` deltas; a press that never moved is
 *   replayed as a full click at the press point, so tapping empty space still
 *   clears the selection.
 *
 * - `axis`: undecided until the finger has moved `PRESS_SLOP_PX`, then `mouse`
 *   if it went sideways and `pan` if it went up or down. For a control that is
 *   dragged sideways (a number field's scrub) inside something that scrolls
 *   vertically (the sheet it sits in).
 *
 * Holding the press back is what lets a pinch start cleanly: the first finger
 * of a pinch lands a few milliseconds before the second, and a press sent at
 * once would select whatever was under it. Two fingers are therefore a pinch in
 * either mode, unless a mouse drag has already started moving something: a
 * second finger landing mid-drag is ignored rather than dropping a clip
 * somewhere the user did not choose.
 *
 * Holding still for `LONG_PRESS_MS` is a right click, which is how the
 * timeline's and the preview's context menus are reached without a mouse.
 */

export type TouchPoint = { id: number; x: number; y: number };

export type SurfaceMode = "mouse" | "pan" | "axis";

export type MouseCommandType =
  | "mousedown"
  | "mousemove"
  | "mouseup"
  | "click"
  | "dblclick"
  | "contextmenu";

export type GestureCommand =
  | {
      kind: "mouse";
      type: MouseCommandType;
      x: number;
      y: number;
      /** `MouseEvent.button`: 0 primary, 2 secondary. */
      button: 0 | 2;
    }
  /** Content follows the finger: `dx`/`dy` are the finger's own motion. */
  | { kind: "pan"; dx: number; dy: number; x: number; y: number }
  /** `scale` is relative to the previous pinch command, about (`x`, `y`). */
  | { kind: "pinch"; scale: number; x: number; y: number };

/** How far a finger may wander and still be a tap, in CSS px. */
export const TAP_SLOP_PX = 10;
/**
 * How far a finger moves before a mouse-mode press is sent. Smaller than the
 * tap slop so a short nudge of a clip is still possible.
 */
export const PRESS_SLOP_PX = 6;
/** How long a still finger takes to become a right click. */
export const LONG_PRESS_MS = 500;
/** Two taps closer than this in time are a double click. */
export const DOUBLE_TAP_MS = 300;
/** And this close in space. */
export const DOUBLE_TAP_SLOP_PX = 24;

type Phase =
  | { kind: "idle" }
  | {
      kind: "single";
      mode: SurfaceMode;
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      startT: number;
      moved: boolean;
      /** Mouse mode: whether the held-back press has been sent. */
      pressed: boolean;
    }
  | {
      kind: "pinch";
      a: number;
      b: number;
      distance: number;
      centerX: number;
      centerY: number;
    }
  /** The gesture has said all it will; wait for every finger to lift. */
  | { kind: "spent" };

const distance = (p: TouchPoint, q: TouchPoint) =>
  Math.hypot(p.x - q.x, p.y - q.y);

export class TouchGesture {
  private phase: Phase = { kind: "idle" };
  private lastTap: { x: number; y: number; t: number } | null = null;

  /** Whether a gesture is in flight. */
  get active(): boolean {
    return this.phase.kind !== "idle";
  }

  /**
   * When the pending press becomes a long press, or `null` when none is
   * pending. The bridge arms one timer for it and calls `tick`.
   */
  longPressDeadline(): number | null {
    const phase = this.phase;
    if (phase.kind !== "single" || phase.moved) {
      return null;
    }
    return phase.startT + LONG_PRESS_MS;
  }

  /**
   * Fingers went down. `touches` is every finger now on the surface, the new
   * ones included; `mode` is what the surface answered for the first one.
   */
  start(touches: TouchPoint[], t: number, mode: SurfaceMode): GestureCommand[] {
    const phase = this.phase;

    if (phase.kind === "idle") {
      if (touches.length >= 2) {
        return this.beginPinch(touches);
      }
      const p = touches[0];
      if (p == null) {
        return [];
      }
      this.phase = {
        kind: "single",
        mode,
        id: p.id,
        startX: p.x,
        startY: p.y,
        lastX: p.x,
        lastY: p.y,
        startT: t,
        moved: false,
        pressed: false,
      };
      return [];
    }

    if (phase.kind === "single" && touches.length >= 2) {
      if (phase.pressed) {
        // Something is being dragged. Carry on with the first finger.
        return [];
      }
      return this.beginPinch(touches);
    }

    return [];
  }

  move(touches: TouchPoint[]): GestureCommand[] {
    const phase = this.phase;

    if (phase.kind === "single") {
      const p = touches.find((touch) => touch.id === phase.id);
      if (p == null) {
        return [];
      }
      if (phase.mode === "axis") {
        const dx = p.x - phase.startX;
        const dy = p.y - phase.startY;
        if (Math.hypot(dx, dy) <= PRESS_SLOP_PX) {
          return [];
        }
        phase.mode = Math.abs(dx) >= Math.abs(dy) ? "mouse" : "pan";
        if (phase.mode === "pan") {
          // Decided, so the slop is already spent: the first delta carries
          // everything since the press.
          phase.moved = true;
        }
      }

      if (
        !phase.moved &&
        Math.hypot(p.x - phase.startX, p.y - phase.startY) > TAP_SLOP_PX
      ) {
        phase.moved = true;
      }

      if (phase.mode === "mouse") {
        phase.lastX = p.x;
        phase.lastY = p.y;
        const move: GestureCommand = {
          kind: "mouse",
          type: "mousemove",
          x: p.x,
          y: p.y,
          button: 0,
        };
        if (phase.pressed) {
          return [move];
        }
        if (Math.hypot(p.x - phase.startX, p.y - phase.startY) <= PRESS_SLOP_PX) {
          return [];
        }
        // The press goes where the finger landed, so the surface measures the
        // drag from there and the dragged thing catches up under the finger.
        phase.pressed = true;
        phase.moved = true;
        return [
          {
            kind: "mouse",
            type: "mousedown",
            x: phase.startX,
            y: phase.startY,
            button: 0,
          },
          move,
        ];
      }
      // A pan inside the slop is held back, so a tap does not nudge the view.
      // `last` stays at the press point until then, so the first delta carries
      // the motion that was held back and the content still lands under the
      // finger.
      if (!phase.moved) {
        return [];
      }
      const dx = p.x - phase.lastX;
      const dy = p.y - phase.lastY;
      phase.lastX = p.x;
      phase.lastY = p.y;
      return [{ kind: "pan", dx, dy, x: p.x, y: p.y }];
    }

    if (phase.kind === "pinch") {
      const a = touches.find((touch) => touch.id === phase.a);
      const b = touches.find((touch) => touch.id === phase.b);
      if (a == null || b == null) {
        return [];
      }
      const nextDistance = distance(a, b);
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const out: GestureCommand[] = [];

      if (phase.distance > 0 && nextDistance > 0) {
        const scale = nextDistance / phase.distance;
        if (scale !== 1) {
          out.push({ kind: "pinch", scale, x: centerX, y: centerY });
        }
      }
      const dx = centerX - phase.centerX;
      const dy = centerY - phase.centerY;
      if (dx !== 0 || dy !== 0) {
        out.push({ kind: "pan", dx, dy, x: centerX, y: centerY });
      }

      phase.distance = nextDistance;
      phase.centerX = centerX;
      phase.centerY = centerY;
      return out;
    }

    return [];
  }

  /**
   * Fingers lifted. `remaining` is every finger still down; the gesture ends
   * when it is empty.
   */
  end(remaining: TouchPoint[], t: number): GestureCommand[] {
    const phase = this.phase;

    if (phase.kind === "single") {
      if (remaining.some((touch) => touch.id === phase.id)) {
        return [];
      }
      this.phase = remaining.length === 0 ? { kind: "idle" } : { kind: "spent" };

      if (phase.pressed) {
        return [
          {
            kind: "mouse",
            type: "mouseup",
            x: phase.lastX,
            y: phase.lastY,
            button: 0,
          },
        ];
      }
      if (phase.moved) {
        return [];
      }
      // A tap, replayed where the finger landed.
      const x = phase.startX;
      const y = phase.startY;
      return [
        { kind: "mouse", type: "mousedown", x, y, button: 0 },
        { kind: "mouse", type: "mouseup", x, y, button: 0 },
        ...this.tap(x, y, t),
      ];
    }

    if (remaining.length === 0) {
      this.phase = { kind: "idle" };
    } else if (phase.kind === "pinch") {
      // One finger of the pair left. Lifting the other ends it; the one still
      // down never becomes a fresh drag halfway through somebody's pinch.
      this.phase = { kind: "spent" };
    }
    return [];
  }

  /** The press has been still long enough: make it a right click. */
  tick(t: number): GestureCommand[] {
    const phase = this.phase;
    const deadline = this.longPressDeadline();
    if (phase.kind !== "single" || deadline == null || t < deadline) {
      return [];
    }
    this.phase = { kind: "spent" };
    this.lastTap = null;
    const x = phase.lastX;
    const y = phase.lastY;

    return [
      { kind: "mouse", type: "mousedown", x, y, button: 2 },
      { kind: "mouse", type: "contextmenu", x, y, button: 2 },
      { kind: "mouse", type: "mouseup", x, y, button: 2 },
    ];
  }

  /**
   * The system took the touch away (a call, a notification shade). A mouse
   * press is released where it last was, so no drag is left armed with no
   * finger to finish it.
   */
  cancel(): GestureCommand[] {
    const phase = this.phase;
    this.phase = { kind: "idle" };
    if (phase.kind === "single" && phase.pressed) {
      return [
        {
          kind: "mouse",
          type: "mouseup",
          x: phase.lastX,
          y: phase.lastY,
          button: 0,
        },
      ];
    }
    return [];
  }

  private beginPinch(touches: TouchPoint[]): GestureCommand[] {
    const [a, b] = touches;
    this.phase = {
      kind: "pinch",
      a: a.id,
      b: b.id,
      distance: distance(a, b),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
    this.lastTap = null;
    return [];
  }

  private tap(x: number, y: number, t: number): GestureCommand[] {
    const out: GestureCommand[] = [
      { kind: "mouse", type: "click", x, y, button: 0 },
    ];
    const last = this.lastTap;
    if (
      last != null &&
      t - last.t <= DOUBLE_TAP_MS &&
      Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_SLOP_PX
    ) {
      out.push({ kind: "mouse", type: "dblclick", x, y, button: 0 });
      // A third tap starts a new pair rather than being a second double.
      this.lastTap = null;
    } else {
      this.lastTap = { x, y, t };
    }
    return out;
  }
}
