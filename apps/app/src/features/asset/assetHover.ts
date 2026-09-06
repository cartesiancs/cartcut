/**
 * What hovering an asset tile turns into: nothing, or a preview.
 *
 * Dwelling on a tile opens a large preview that follows the cursor, and leaving
 * the tile closes it. That is one sentence and four states, because the hover
 * shares its pointer stream with `assetPress.ts` — the same tile, the same
 * events — and the two must not fight. Pressing to add a clip, or holding to
 * drag one onto the timeline, has to suppress the preview outright: the pointer
 * sits still on the tile for both of those, which is exactly the gesture the
 * dwell is watching for.
 *
 * As a reducer with an injected clock the boundaries are testable — 799ms
 * versus 800ms, a press that lands at 700ms — and none of that is observable
 * once it is tangled into pointer handlers. There is no DOM test environment in
 * this repo (`vitest.config.ts` is `environment: "node"`, and nothing installs
 * jsdom), so logic left inside the Lit component is logic that cannot be tested
 * at all. `mask/penSession.ts` states the same reasoning at greater length.
 */

export const HOVER = {
  /**
   * Rest on a tile this long and the preview opens.
   *
   * Deliberately not one of `DRAG`'s constants, and it has to stay well clear
   * of them: `LONG_PRESS_MS` is 220, and a dwell anywhere near that would open
   * a preview under every hold that was about to become a drag.
   */
  DWELL_MS: 800,
} as const;

export type HoverConfig = typeof HOVER;

export type HoverPhase =
  | "idle"
  /** On the tile, and the dwell has not completed. */
  | "dwelling"
  /** The preview is up and tracking the cursor. */
  | "open"
  /**
   * Pressed — a click, or the start of a drag. The preview is closed and stays
   * closed while the pointer remains on the tile.
   *
   * Without this phase, clicking a tile adds the asset at the playhead and
   * leaves the cursor exactly where it was, so the preview opens by itself two
   * seconds later over an edit the user has already moved on from.
   */
  | "suppressed";

export type HoverState = {
  phase: HoverPhase;
  /**
   * The last cursor position seen.
   *
   * `tick` carries no coordinates — it is a bare clock pulse — so the dwell
   * completing with the pointer perfectly still has to open the preview
   * somewhere, and this is that somewhere.
   */
  cursor: { x: number; y: number };
  enterT: number;
};

export const idleHover: HoverState = {
  phase: "idle",
  cursor: { x: 0, y: 0 },
  enterT: 0,
};

export type HoverEv =
  | { type: "enter"; x: number; y: number; t: number }
  | { type: "move"; x: number; y: number; t: number }
  /** A clock pulse, so the dwell can complete without any pointer motion. */
  | { type: "tick"; t: number }
  | { type: "leave" }
  /** `pointerdown`. Either gesture in `assetPress.ts` starts with one. */
  | { type: "press" }
  /** A wheel, a native drag starting, the window blurring, the tile going away. */
  | { type: "cancel" };

export type HoverEffect =
  | { type: "open"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "close" };

/** Close, but only if something is actually open. */
function closing(state: HoverState, next: HoverState) {
  return {
    state: next,
    effects: state.phase === "open" ? [{ type: "close" } as HoverEffect] : [],
  };
}

export function reduceHover(
  state: HoverState,
  ev: HoverEv,
  cfg: HoverConfig = HOVER,
): { state: HoverState; effects: HoverEffect[] } {
  switch (ev.type) {
    case "enter": {
      // Defensive: `pointerenter` cannot fire twice without a `pointerleave`
      // between them, and treating a second one as a fresh dwell would let the
      // clock open an already-open preview a second time. The overlay is a
      // singleton, so that would leak the first one's teardown.
      if (state.phase === "open") {
        return { state, effects: [] };
      }

      return {
        state: { phase: "dwelling", cursor: { x: ev.x, y: ev.y }, enterT: ev.t },
        effects: [],
      };
    }

    case "move": {
      if (state.phase === "open") {
        return {
          state: { ...state, cursor: { x: ev.x, y: ev.y } },
          effects: [{ type: "move", x: ev.x, y: ev.y }],
        };
      }

      if (state.phase === "suppressed") {
        return { state, effects: [] };
      }

      if (state.phase === "idle") {
        // A move starts a dwell exactly as `enter` would, because `enter` does
        // not always arrive. The window regaining focus with the pointer
        // already parked on a tile fires no boundary event at all — and this
        // module's own `blur` cancel is what puts it in `idle` to begin with,
        // so without this the feature is dead until the pointer physically
        // leaves the tile and comes back.
        //
        // This is also what makes `suppressed` load-bearing rather than
        // decorative: a press that dropped straight to `idle` would re-arm on
        // the first twitch after the click that added the asset.
        return {
          state: { phase: "dwelling", cursor: { x: ev.x, y: ev.y }, enterT: ev.t },
          effects: [],
        };
      }

      // The dwell is measured from `enter` and motion inside the tile does not
      // restart it. A cursor on a trackpad never sits perfectly still, so a
      // clock that resets on movement is a clock that never fires. Sweeping
      // across the panel is already handled: each tile is left long before two
      // seconds are up.
      if (ev.t - state.enterT >= cfg.DWELL_MS) {
        return {
          state: { ...state, phase: "open", cursor: { x: ev.x, y: ev.y } },
          effects: [{ type: "open", x: ev.x, y: ev.y }],
        };
      }

      return { state: { ...state, cursor: { x: ev.x, y: ev.y } }, effects: [] };
    }

    case "tick": {
      // Only `dwelling` is still waiting. Every other phase either has the
      // preview already or has decided against it, so a late timer is inert.
      if (state.phase !== "dwelling") {
        return { state, effects: [] };
      }
      if (ev.t - state.enterT < cfg.DWELL_MS) {
        return { state, effects: [] };
      }

      return {
        state: { ...state, phase: "open" },
        effects: [{ type: "open", x: state.cursor.x, y: state.cursor.y }],
      };
    }

    case "leave": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }
      return closing(state, idleHover);
    }

    case "press": {
      if (state.phase === "idle") {
        // Nothing to close and nothing to suppress: with no `enter` on record
        // the dwell cannot start, so this would only invent a phase to leave.
        return { state, effects: [] };
      }
      return closing(state, { ...state, phase: "suppressed" });
    }

    case "cancel": {
      if (state.phase === "idle") {
        return { state, effects: [] };
      }
      return closing(state, idleHover);
    }
  }
}
