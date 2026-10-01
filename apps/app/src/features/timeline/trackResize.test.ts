import { describe, expect, it } from "vitest";
import {
  IDLE_RESIZE,
  TRACK_RESIZE,
  createTrackResizeController,
  reduceTrackResize,
  type TrackResizeEffect,
  type TrackResizeEvent,
  type TrackResizePort,
  type TrackResizeState,
} from "./trackResize";
import {
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  coerceTrackHeight,
} from "./trackHeights";

const { DEAD_ZONE_PX } = TRACK_RESIZE;

function down(over: Partial<Extract<TrackResizeEvent, { type: "down" }>> = {}) {
  return {
    type: "down",
    trackId: "v1",
    pointerId: 1,
    clientY: 100,
    scroll: 0,
    startPx: 40,
    button: 0,
    isPrimary: true,
    ctrlKey: false,
    ...over,
  } as const satisfies TrackResizeEvent;
}

const move = (clientY: number, over: { pointerId?: number; buttons?: number } = {}) =>
  ({
    type: "move",
    pointerId: over.pointerId ?? 1,
    clientY,
    buttons: over.buttons ?? 1,
  }) as const satisfies TrackResizeEvent;

/** Run events from idle; collect every effect and the final state. */
function run(...events: TrackResizeEvent[]) {
  let state: TrackResizeState = IDLE_RESIZE;
  const effects: TrackResizeEffect[] = [];
  const consumed: boolean[] = [];
  for (const event of events) {
    const result = reduceTrackResize(state, event, coerceTrackHeight);
    state = result.state;
    effects.push(...result.effects);
    consumed.push(result.consumed);
  }
  return { state, effects, consumed };
}

const previews = (effects: TrackResizeEffect[]) =>
  effects.flatMap((e) => (e.type === "preview" ? [e.px] : []));
const has = (effects: TrackResizeEffect[], type: TrackResizeEffect["type"]) =>
  effects.some((e) => e.type === type);

describe("starting a resize", () => {
  it("accepts a plain primary press and starts listening", () => {
    const { state, effects, consumed } = run(down());
    expect(state.phase).toBe("pressed");
    expect(effects).toEqual([{ type: "listen", on: true }]);
    expect(consumed).toEqual([true]);
  });

  it("declines any other button, a second pointer, and a Ctrl-click", () => {
    for (const over of [
      { button: 1 },
      { button: 2 },
      { isPrimary: false },
      { ctrlKey: true },
    ]) {
      const { state, effects, consumed } = run(down(over));
      expect(state).toEqual(IDLE_RESIZE);
      expect(effects).toEqual([]);
      expect(consumed).toEqual([false]);
    }
  });

  it("ignores a second press while one gesture is going on", () => {
    const { state, effects } = run(down(), down({ pointerId: 2, trackId: "v2" }));
    expect(state).toMatchObject({ phase: "pressed", trackId: "v1", pointerId: 1 });
    expect(effects).toEqual([{ type: "listen", on: true }]);
  });
});

describe("the dead zone", () => {
  it("draws nothing until the pointer has travelled past it", () => {
    const { state, effects } = run(down(), move(100 + DEAD_ZONE_PX), move(100 - DEAD_ZONE_PX));
    expect(state.phase).toBe("pressed");
    expect(previews(effects)).toEqual([]);
  });

  it("keeps nothing for a click with a little jitter", () => {
    const { state, effects } = run(down(), move(102), { type: "up", pointerId: 1 });
    expect(state).toEqual({ phase: "idle", lastMoved: false });
    expect(has(effects, "commit")).toBe(false);
    expect(has(effects, "preview")).toBe(false);
    expect(effects.at(-1)).toEqual({ type: "listen", on: false });
  });

  it("catches up with the pointer once crossed, rather than starting from the edge of the zone", () => {
    const { state, effects } = run(down(), move(100 + DEAD_ZONE_PX + 1));
    expect(state.phase).toBe("resizing");
    expect(effects).toContainEqual({ type: "active", trackId: "v1", on: true });
    expect(previews(effects)).toEqual([40 + DEAD_ZONE_PX + 1]);
  });
});

describe("resizing", () => {
  it("follows the pointer from where the press landed", () => {
    // The last move asks for 30, under the minimum.
    const { effects } = run(down(), move(130), move(160), move(90));
    expect(previews(effects)).toEqual([70, 100, MIN_TRACK_HEIGHT]);
  });

  it("stops at either limit and picks the pointer up where the limit began", () => {
    const { effects } = run(
      down({ startPx: 40 }),
      move(100 - 50), // would be -10
      move(100 - 20), // would be 20, still clamped: no new preview
      move(100 - 5), // 35
      move(100 + 500), // past the top
      move(100 + 400), // still past it: no new preview
      move(100 + 150), // 190
    );
    expect(previews(effects)).toEqual([
      MIN_TRACK_HEIGHT,
      35,
      MAX_TRACK_HEIGHT,
      190,
    ]);
  });

  it("previews a height only when it changes", () => {
    const { effects } = run(down(), move(120), move(120.2), move(120.4), move(121));
    expect(previews(effects)).toEqual([60, 61]);
  });

  it("measures in content space, so a wheel keeps the edge under the pointer", () => {
    const { effects } = run(
      down({ scroll: 0 }),
      move(120), // 60
      { type: "scroll", v: 30 }, // the rows moved up 30 under a still pointer
    );
    expect(previews(effects)).toEqual([60, 90]);
  });

  it("lets a wheel alone start a resize from a press", () => {
    const { state, effects } = run(down({ scroll: 100 }), { type: "scroll", v: 110 });
    expect(state.phase).toBe("resizing");
    expect(previews(effects)).toEqual([50]);
  });

  it("ignores a scroll that has not changed, and one with no gesture", () => {
    expect(run({ type: "scroll", v: 50 }).effects).toEqual([]);
    expect(run(down(), { type: "scroll", v: 0 }).effects).toEqual([
      { type: "listen", on: true },
    ]);
  });

  it("ignores another pointer's moves", () => {
    const { effects } = run(down(), move(200, { pointerId: 7 }));
    expect(previews(effects)).toEqual([]);
  });
});

describe("ending a resize", () => {
  function resizing() {
    return [down(), move(150)] as TrackResizeEvent[];
  }

  it("keeps the height on release", () => {
    const { state, effects } = run(...resizing(), { type: "up", pointerId: 1 });
    expect(state).toEqual({ phase: "idle", lastMoved: true });
    expect(effects.slice(-3)).toEqual([
      { type: "commit" },
      { type: "active", trackId: "v1", on: false },
      { type: "listen", on: false },
    ]);
  });

  it("ignores another pointer's release", () => {
    const { state } = run(...resizing(), { type: "up", pointerId: 9 });
    expect(state.phase).toBe("resizing");
  });

  it("keeps the height when a move arrives with the button already up", () => {
    const { state, effects } = run(...resizing(), move(160, { buttons: 0 }));
    expect(state.phase).toBe("idle");
    expect(has(effects, "commit")).toBe(true);
    // The stray move itself does not resize.
    expect(previews(effects)).toEqual([90]);
  });

  it("keeps the height when the window loses focus", () => {
    const { effects } = run(...resizing(), { type: "blur" });
    expect(has(effects, "commit")).toBe(true);
    expect(has(effects, "cancel")).toBe(false);
  });

  it("reverts on Escape, and says it used the key", () => {
    const { state, effects, consumed } = run(...resizing(), { type: "escape" });
    expect(state.phase).toBe("idle");
    expect(has(effects, "cancel")).toBe(true);
    expect(has(effects, "commit")).toBe(false);
    expect(consumed.at(-1)).toBe(true);
  });

  it("ends a press on Escape without taking the key from anyone else", () => {
    const { state, effects, consumed } = run(down(), { type: "escape" });
    expect(state.phase).toBe("idle");
    expect(effects.at(-1)).toEqual({ type: "listen", on: false });
    expect(consumed.at(-1)).toBe(false);
  });

  it("leaves Escape alone when nothing is going on", () => {
    expect(run({ type: "escape" }).consumed).toEqual([false]);
  });

  it("reverts when the platform cancels the pointer", () => {
    const { effects } = run(...resizing(), { type: "pointercancel", pointerId: 1 });
    expect(has(effects, "cancel")).toBe(true);
  });

  it("reverts when the row is no longer on the timeline", () => {
    const { state, effects } = run(...resizing(), { type: "tracks", ids: ["v2"] });
    expect(state.phase).toBe("idle");
    expect(has(effects, "cancel")).toBe(true);
    expect(effects.at(-1)).toEqual({ type: "listen", on: false });
  });

  it("carries on when other rows come and go", () => {
    const { state } = run(...resizing(), { type: "tracks", ids: ["v0", "v1"] });
    expect(state.phase).toBe("resizing");
  });
});

describe("double-click", () => {
  it("resets the row after two clicks that did not move", () => {
    const { effects, consumed } = run(
      down(),
      { type: "up", pointerId: 1 },
      down(),
      { type: "up", pointerId: 1 },
      { type: "dblclick", trackId: "v1" },
    );
    expect(effects.at(-1)).toEqual({ type: "reset", trackId: "v1" });
    expect(consumed.at(-1)).toBe(true);
  });

  it("is ignored after a second press that dragged", () => {
    // Chromium still fires dblclick here. Resetting would throw away the drag.
    const { effects } = run(
      down(),
      { type: "up", pointerId: 1 },
      down(),
      move(160),
      { type: "up", pointerId: 1 },
      { type: "dblclick", trackId: "v1" },
    );
    expect(has(effects, "reset")).toBe(false);
    expect(has(effects, "commit")).toBe(true);
  });

  it("is ignored in the middle of a gesture", () => {
    const { effects } = run(down(), { type: "dblclick", trackId: "v1" });
    expect(has(effects, "reset")).toBe(false);
  });
});

describe("createTrackResizeController", () => {
  function fakePort() {
    const calls: string[] = [];
    const port: TrackResizePort = {
      preview: (id, px) => calls.push(`preview ${id} ${px}`),
      commit: () => calls.push("commit"),
      cancel: () => calls.push("cancel"),
      reset: (id) => calls.push(`reset ${id}`),
      setActive: (id, on) => calls.push(`active ${id} ${on}`),
      listen: (on) => calls.push(`listen ${on}`),
    };
    return { port, calls };
  }

  it("applies the effects to the port in order", () => {
    const { port, calls } = fakePort();
    const controller = createTrackResizeController(port, coerceTrackHeight);
    expect(controller.dispatch(down())).toBe(true);
    controller.dispatch(move(140));
    controller.dispatch({ type: "up", pointerId: 1 });
    expect(calls).toEqual([
      "listen true",
      "active v1 true",
      "preview v1 80",
      "commit",
      "active v1 false",
      "listen false",
    ]);
    expect(controller.state()).toEqual({ phase: "idle", lastMoved: true });
  });

  it("answers false for an event that was not its own", () => {
    const { port, calls } = fakePort();
    const controller = createTrackResizeController(port, coerceTrackHeight);
    expect(controller.dispatch(down({ button: 2 }))).toBe(false);
    expect(controller.dispatch({ type: "escape" })).toBe(false);
    expect(calls).toEqual([]);
  });
});
