/**
 * Resizing a timeline row by dragging the bottom edge of its header, the way a
 * window edge is dragged.
 *
 * A reducer over pointer events with the DOM behind a port, because there is no
 * DOM test environment here and every rule below is one a mouse handler would
 * keep silently: which presses start a gesture, when a press becomes a resize,
 * what ends one, and which of those keep the new height.
 *
 * The rules, each with the failure it prevents:
 *
 * - **A dead zone before anything moves.** A click on the edge with a pixel of
 *   hand jitter would otherwise resize the row by a pixel and dirty the project.
 * - **Absolute mapping from the press**, so the edge stays under the pointer:
 *   past the minimum or maximum the row stops, and the edge picks the pointer up
 *   again only when it comes back to where the clamp began, as a window does.
 * - **Content space, not screen space.** The header column scrolls with the
 *   canvas, so a wheel mid-drag moves the edge on screen; adding the scroll's
 *   change to the pointer's keeps the edge where the hand is.
 * - **Release keeps, Escape reverts.** Losing the window (⌘Tab) keeps the last
 *   height drawn, because that is what the user saw when they left; a
 *   `pointercancel`, which the platform sends when it takes the pointer away,
 *   reverts. A row that disappears mid-drag (undo, the agent, a project load)
 *   ends the gesture and keeps nothing.
 * - **A double-click resets, unless the gesture that preceded it moved.**
 *   Chromium fires `dblclick` after a second press that dragged, and resetting
 *   on that release would throw away the drag the user just made.
 */

export const TRACK_RESIZE = {
  /** Travel, in px, before a press on the edge becomes a resize. */
  DEAD_ZONE_PX: 3,
} as const;

export type TrackResizeConfig = typeof TRACK_RESIZE;

/** Clamps a height into range. `trackHeights.ts#coerceTrackHeight` in the app. */
export type HeightClamp = (px: number) => number;

type Gesture = {
  trackId: string;
  pointerId: number;
  originY: number;
  originScroll: number;
  /** The row's height when the press landed. */
  startPx: number;
  clientY: number;
  scroll: number;
  /** The height last previewed, once resizing. */
  px: number;
};

export type TrackResizeState =
  | { phase: "idle"; lastMoved: boolean }
  | ({ phase: "pressed" } & Gesture)
  | ({ phase: "resizing" } & Gesture);

export const IDLE_RESIZE: TrackResizeState = { phase: "idle", lastMoved: false };

export type TrackResizeEvent =
  | {
      type: "down";
      trackId: string;
      pointerId: number;
      clientY: number;
      /** The shared vertical scroll at the press. */
      scroll: number;
      startPx: number;
      button: number;
      isPrimary: boolean;
      /** On macOS a Ctrl-click is the context menu, not a press. */
      ctrlKey: boolean;
    }
  | { type: "move"; pointerId: number; clientY: number; buttons: number }
  | { type: "scroll"; v: number }
  | { type: "up"; pointerId: number }
  | { type: "pointercancel"; pointerId: number }
  | { type: "escape" }
  | { type: "blur" }
  | { type: "tracks"; ids: readonly string[] }
  | { type: "dblclick"; trackId: string };

export type TrackResizeEffect =
  /** Start or stop listening on the window for the rest of the gesture. */
  | { type: "listen"; on: boolean }
  /** The press has become a resize, or the resize is over. */
  | { type: "active"; trackId: string; on: boolean }
  | { type: "preview"; trackId: string; px: number }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "reset"; trackId: string };

export type TrackResizeResult = {
  state: TrackResizeState;
  effects: TrackResizeEffect[];
  /**
   * Whether the event belonged to the gesture. The caller uses it to capture
   * the pointer on an accepted press and to swallow an Escape that cancelled a
   * resize, so the same key does not also clear the clip selection.
   */
  consumed: boolean;
};

function unchanged(state: TrackResizeState): TrackResizeResult {
  return { state, effects: [], consumed: false };
}

/**
 * End whatever gesture is in progress. `keep` decides whether a resize's last
 * preview is kept or dropped; a press that never became a resize has nothing
 * to keep either way.
 */
function finish(
  state: TrackResizeState,
  keep: boolean,
  consumed = true,
): TrackResizeResult {
  if (state.phase === "idle") {
    return unchanged(state);
  }
  if (state.phase === "pressed") {
    return {
      state: { phase: "idle", lastMoved: false },
      effects: [{ type: "listen", on: false }],
      consumed,
    };
  }
  return {
    state: { phase: "idle", lastMoved: true },
    effects: [
      keep ? { type: "commit" } : { type: "cancel" },
      { type: "active", trackId: state.trackId, on: false },
      { type: "listen", on: false },
    ],
    consumed,
  };
}

/** Re-evaluate the height after the pointer or the scroll moved. */
function track(
  state: Extract<TrackResizeState, { phase: "pressed" | "resizing" }>,
  clamp: HeightClamp,
  cfg: TrackResizeConfig,
): TrackResizeResult {
  const travel = state.clientY - state.originY + (state.scroll - state.originScroll);

  if (state.phase === "pressed") {
    if (Math.abs(travel) <= cfg.DEAD_ZONE_PX) {
      return { state, effects: [], consumed: true };
    }
    const px = clamp(state.startPx + travel);
    return {
      state: { ...state, phase: "resizing", px },
      effects: [
        { type: "active", trackId: state.trackId, on: true },
        { type: "preview", trackId: state.trackId, px },
      ],
      consumed: true,
    };
  }

  const px = clamp(state.startPx + travel);
  if (px === state.px) {
    return { state, effects: [], consumed: true };
  }
  return {
    state: { ...state, px },
    effects: [{ type: "preview", trackId: state.trackId, px }],
    consumed: true,
  };
}

export function reduceTrackResize(
  state: TrackResizeState,
  event: TrackResizeEvent,
  clamp: HeightClamp,
  cfg: TrackResizeConfig = TRACK_RESIZE,
): TrackResizeResult {
  switch (event.type) {
    case "down": {
      // One gesture at a time: a second finger or pen while one is going on is
      // not a second resize.
      if (state.phase !== "idle") {
        return unchanged(state);
      }
      if (event.button !== 0 || !event.isPrimary || event.ctrlKey) {
        return unchanged(state);
      }
      return {
        state: {
          phase: "pressed",
          trackId: event.trackId,
          pointerId: event.pointerId,
          originY: event.clientY,
          originScroll: event.scroll,
          startPx: event.startPx,
          clientY: event.clientY,
          scroll: event.scroll,
          px: event.startPx,
        },
        effects: [{ type: "listen", on: true }],
        consumed: true,
      };
    }

    case "move": {
      if (state.phase === "idle" || event.pointerId !== state.pointerId) {
        return unchanged(state);
      }
      // The release happened somewhere that never told us (outside the window,
      // under a native menu). The button is already up, so this is the release.
      if ((event.buttons & 1) === 0) {
        return finish(state, true);
      }
      return track({ ...state, clientY: event.clientY }, clamp, cfg);
    }

    case "scroll": {
      if (state.phase === "idle" || event.v === state.scroll) {
        return unchanged(state);
      }
      return track({ ...state, scroll: event.v }, clamp, cfg);
    }

    case "up":
      if (state.phase === "idle" || event.pointerId !== state.pointerId) {
        return unchanged(state);
      }
      return finish(state, true);

    case "pointercancel":
      if (state.phase === "idle" || event.pointerId !== state.pointerId) {
        return unchanged(state);
      }
      return finish(state, false);

    case "escape":
      // Swallowed only when it undid something. A press that has not moved has
      // drawn nothing, so Escape ends it and still does its ordinary job.
      if (state.phase === "idle") {
        return unchanged(state);
      }
      return finish(state, false, state.phase === "resizing");

    case "blur":
      return finish(state, true);

    case "tracks":
      if (state.phase === "idle" || event.ids.includes(state.trackId)) {
        return unchanged(state);
      }
      return finish(state, false);

    case "dblclick":
      if (state.phase !== "idle" || state.lastMoved) {
        return unchanged(state);
      }
      return {
        state,
        effects: [{ type: "reset", trackId: event.trackId }],
        consumed: true,
      };
  }
}

/** What a resize does to the world. The header column supplies it. */
export type TrackResizePort = {
  preview(trackId: string, px: number): void;
  commit(): void;
  cancel(): void;
  reset(trackId: string): void;
  /** Body cursor, the dragging style on the edge. */
  setActive(trackId: string, on: boolean): void;
  /** The window listeners for the rest of the gesture. */
  listen(on: boolean): void;
};

export type TrackResizeController = {
  /** Feed an event; true when it belonged to the gesture. */
  dispatch(event: TrackResizeEvent): boolean;
  state(): TrackResizeState;
};

export function createTrackResizeController(
  port: TrackResizePort,
  clamp: HeightClamp,
  cfg: TrackResizeConfig = TRACK_RESIZE,
): TrackResizeController {
  let current: TrackResizeState = IDLE_RESIZE;
  return {
    dispatch(event) {
      const result = reduceTrackResize(current, event, clamp, cfg);
      current = result.state;
      for (const effect of result.effects) {
        switch (effect.type) {
          case "listen":
            port.listen(effect.on);
            break;
          case "active":
            port.setActive(effect.trackId, effect.on);
            break;
          case "preview":
            port.preview(effect.trackId, effect.px);
            break;
          case "commit":
            port.commit();
            break;
          case "cancel":
            port.cancel();
            break;
          case "reset":
            port.reset(effect.trackId);
            break;
        }
      }
      return result.consumed;
    },
    state: () => current,
  };
}
