import { describe, it, expect } from "vitest";
import {
  DRAG,
  idleDrag,
  reduceDrag,
  trackDeltaFor,
  type DragEffect,
  type DragState,
  type PointerEv,
} from "./dragMachine";
import type { Hit } from "./layout";

const bodyHit: Hit = {
  kind: "clip",
  elementId: "a",
  trackId: "v1",
  zone: "body",
};
const startHandle: Hit = { ...bodyHit, zone: "trimStart" } as Hit;
const endHandle: Hit = { ...bodyHit, zone: "trimEnd" } as Hit;

/** Feed a sequence of events, returning the final state and all effects. */
function run(...events: PointerEv[]): {
  state: DragState;
  effects: DragEffect[];
} {
  let state = idleDrag;
  const effects: DragEffect[] = [];
  for (const ev of events) {
    const result = reduceDrag(state, ev);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const down = (over: Partial<Extract<PointerEv, { type: "down" }>> = {}) =>
  ({ type: "down", x: 100, y: 50, t: 0, hit: bodyHit, ...over }) as PointerEv;

const kinds = (effects: DragEffect[]) => effects.map((e) => e.type);

describe("pressing a clip", () => {
  it("waits before deciding what the gesture is", () => {
    const { state, effects } = run(down());
    expect(state.phase).toBe("pressed");
    expect(effects).toEqual([]);
  });

  it("clears the selection when the press lands on nothing, then waits to see if a band is coming", () => {
    // The effects are exactly what they always were — the press does the same
    // thing to the selection, on the way down. Only the phase moved: the press
    // no longer *ends* the gesture, because a rubber-band may be about to
    // start.
    const { state, effects } = run(down({ hit: { kind: "none" } }));
    expect(state.phase).toBe("pressed");
    expect(kinds(effects)).toEqual(["clearSelection"]);
  });

  it("leaves the selection alone when the empty press is a shift-press", () => {
    // Shift means "add to what is selected", and clearing first would leave
    // nothing to add to.
    const { state, effects } = run(down({ hit: { kind: "none" }, shift: true }));
    expect(state.phase).toBe("pressed");
    expect(effects).toEqual([]);
  });

  it("remembers a shift-press, so the caller can extend the selection", () => {
    expect(run(down({ shift: true })).state.shift).toBe(true);
  });
});

describe("sliding along the track", () => {
  it("becomes a slide once the pointer clearly moves", () => {
    const { state } = run(down(), { type: "move", x: 120, y: 50, t: 50 });
    expect(state.phase).toBe("moveH");
    expect(state.dxPx).toBe(20);
  });

  it("does not react to a twitch", () => {
    // 3px is inside the tolerance, so the hold is still running.
    const { state } = run(down(), { type: "move", x: 103, y: 50, t: 30 });
    expect(state.phase).toBe("pressed");
  });

  it("takes the boundary exactly: 4px waits, 5px slides", () => {
    expect(
      run(down(), { type: "move", x: 104, y: 50, t: 30 }).state.phase,
    ).toBe("pressed");
    expect(
      run(down(), { type: "move", x: 105, y: 50, t: 30 }).state.phase,
    ).toBe("moveH");
  });

  it("locks vertical motion out of a slide", () => {
    // The gesture is already classified; a shaky hand must not relocate the
    // clip to another row halfway through.
    const { state } = run(
      down(),
      { type: "move", x: 140, y: 50, t: 50 },
      { type: "move", x: 160, y: 200, t: 80 },
    );
    expect(state.phase).toBe("moveH");
    expect(state.dyPx).toBe(0);
    expect(state.dxPx).toBe(60);
  });

  it("never frees a clip that already started sliding", () => {
    const { state } = run(
      down(),
      { type: "move", x: 140, y: 50, t: 50 },
      { type: "tick", t: 5000 },
    );
    expect(state.phase).toBe("moveH");
    expect(state.free).toBe(false);
  });
});

describe("holding to lift the clip", () => {
  it("frees the clip once the hold completes", () => {
    const { state, effects } = run(down(), {
      type: "tick",
      t: DRAG.LONG_PRESS_MS,
    });
    expect(state.phase).toBe("moveFree");
    expect(state.free).toBe(true);
    expect(kinds(effects)).toContain("armed");
  });

  it("takes the boundary exactly: 219ms waits, 220ms frees", () => {
    expect(run(down(), { type: "tick", t: 219 }).state.phase).toBe("pressed");
    expect(run(down(), { type: "tick", t: 220 }).state.phase).toBe("moveFree");
  });

  it("still completes the hold through a small wobble", () => {
    // Under the tolerance the gesture is undecided, so holding wins. Anything
    // past it has already become a slide before the tick ever arrives.
    const { state } = run(
      down(),
      { type: "move", x: 102, y: 52, t: 100 },
      { type: "tick", t: 400 },
    );
    expect(state.phase).toBe("moveFree");
  });

  it("cannot be freed once a slide has begun, however long the press lasts", () => {
    const { state } = run(
      down(),
      { type: "move", x: 130, y: 50, t: 40 },
      { type: "tick", t: 9000 },
    );
    expect(state.phase).toBe("moveH");
  });

  it("tracks both axes once free", () => {
    const { state } = run(
      down(),
      { type: "tick", t: 220 },
      { type: "move", x: 130, y: 110, t: 260 },
    );
    expect(state.dxPx).toBe(30);
    expect(state.dyPx).toBe(60);
  });

  it("still slides horizontally while free", () => {
    const { state } = run(
      down(),
      { type: "tick", t: 220 },
      { type: "move", x: 200, y: 50, t: 260 },
    );
    expect(state.dxPx).toBe(100);
    expect(state.dyPx).toBe(0);
  });

  it("frees immediately when Alt is held, for anyone who will not wait", () => {
    const { state, effects } = run(down({ alt: true }));
    expect(state.phase).toBe("moveFree");
    expect(kinds(effects)).toContain("armed");
  });

  it("ignores a tick when nothing is pressed", () => {
    expect(reduceDrag(idleDrag, { type: "tick", t: 9999 }).state).toBe(
      idleDrag,
    );
  });
});

describe("trim handles", () => {
  it("starts trimming at once, with no hold", () => {
    const { state, effects } = run(down({ hit: startHandle }));
    expect(state.phase).toBe("trimStart");
    expect(kinds(effects)).toContain("cursor");
  });

  it("never turns a handle drag into a track move", () => {
    // Resting on an edge is common; it must not lift the clip.
    const { state } = run(down({ hit: endHandle }), { type: "tick", t: 5000 });
    expect(state.phase).toBe("trimEnd");
    expect(state.free).toBe(false);
  });

  it("tracks horizontal travel only", () => {
    const { state } = run(down({ hit: endHandle }), {
      type: "move",
      x: 150,
      y: 300,
      t: 60,
    });
    expect(state.dxPx).toBe(50);
  });
});

describe("finishing", () => {
  it("commits a slide, recording one undo step", () => {
    const { state, effects } = run(
      down(),
      { type: "move", x: 160, y: 50, t: 60 },
      { type: "up", t: 200 },
    );
    expect(state.phase).toBe("idle");
    expect(kinds(effects)).toContain("checkpoint");
    expect(kinds(effects)).toContain("commit");
  });

  it("commits a trim", () => {
    const { effects } = run(
      down({ hit: startHandle }),
      { type: "move", x: 120, y: 50, t: 60 },
      { type: "up", t: 200 },
    );
    expect(kinds(effects)).toContain("commit");
  });

  it("treats press-and-release as a selection, not an edit", () => {
    // Clicking a clip should not consume an undo step.
    const { effects } = run(down(), { type: "up", t: 80 });
    expect(kinds(effects)).toContain("select");
    expect(kinds(effects)).not.toContain("checkpoint");
    expect(kinds(effects)).not.toContain("commit");
  });

  it("reverts on cancel", () => {
    // Window blur or Escape mid-drag.
    const { state, effects } = run(
      down(),
      { type: "move", x: 200, y: 50, t: 60 },
      { type: "cancel" },
    );
    expect(state.phase).toBe("idle");
    expect(kinds(effects)).toContain("revert");
    expect(kinds(effects)).not.toContain("commit");
  });

  it("does nothing when cancelled while idle", () => {
    expect(reduceDrag(idleDrag, { type: "cancel" }).effects).toEqual([]);
  });

  it("forgets everything after finishing", () => {
    const { state } = run(
      down(),
      { type: "move", x: 300, y: 90, t: 60 },
      { type: "up", t: 200 },
    );
    expect(state).toEqual(idleDrag);
  });
});

describe("trackDeltaFor", () => {
  const pitch = 44;

  it("stays on the same row until the pointer clearly leaves it", () => {
    // The hand is rarely still at the moment the hold completes.
    expect(trackDeltaFor(0, pitch)).toBe(0);
    expect(trackDeltaFor(DRAG.VERTICAL_ENTER_PX - 1, pitch)).toBe(0);
  });

  it("moves one row per row of travel", () => {
    expect(trackDeltaFor(pitch, pitch)).toBe(1);
    expect(trackDeltaFor(pitch * 2, pitch)).toBe(2);
  });

  it("moves upward for negative travel", () => {
    expect(trackDeltaFor(-pitch, pitch)).toBe(-1);
  });

  it("rounds to the nearest row", () => {
    expect(trackDeltaFor(pitch * 0.6, pitch)).toBe(1);
    expect(trackDeltaFor(pitch * 1.4, pitch)).toBe(1);
  });

  it("is safe with a degenerate pitch", () => {
    expect(trackDeltaFor(100, 0)).toBe(0);
  });
});

describe("rubber-band selection", () => {
  const emptyHit: Hit = { kind: "none" };
  const trackHit: Hit = { kind: "track", trackId: "v1" };
  const badgeHit: Hit = {
    kind: "transition",
    transitionId: "t1",
    trackId: "v1",
    zone: "body",
  };
  const cutHit: Hit = {
    kind: "cut",
    trackId: "v1",
    fromId: "a",
    toId: "b",
    atMs: 4000,
  };

  it("starts a band once the pointer clearly leaves the press point", () => {
    const { state } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
    );
    expect(state.phase).toBe("marquee");
  });

  it("takes the same boundary as a slide: 4px waits, 5px bands", () => {
    const waits = run(
      down({ hit: emptyHit }),
      { type: "move", x: 104, y: 50, t: 10 },
    );
    expect(waits.state.phase).toBe("pressed");

    const bands = run(
      down({ hit: emptyHit }),
      { type: "move", x: 105, y: 50, t: 10 },
    );
    expect(bands.state.phase).toBe("marquee");
  });

  it("starts a band from the empty part of a track, not only from below the rows", () => {
    const { state } = run(
      down({ hit: trackHit }),
      { type: "move", x: 140, y: 90, t: 30 },
    );
    expect(state.phase).toBe("marquee");
  });

  it("never starts a band from a clip", () => {
    const { state } = run(down(), { type: "move", x: 140, y: 90, t: 30 });
    expect(state.phase).toBe("moveH");
  });

  it("never starts a band from a transition badge or a bare cut", () => {
    for (const hit of [badgeHit, cutHit]) {
      const { state } = run(
        down({ hit }),
        { type: "move", x: 140, y: 90, t: 30 },
      );
      expect(state.phase).toBe("pressed");
    }
  });

  it("tracks both axes, so the band can be dragged in any direction", () => {
    // Unlike a slide, which locks vertical the moment it is classified.
    const { state } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 40, y: 10, t: 30 },
    );
    expect(state.phase).toBe("marquee");
    expect(state.dxPx).toBe(-60);
    expect(state.dyPx).toBe(-40);
  });

  it("carries the shift through, so the band knows to extend rather than replace", () => {
    const { state } = run(
      down({ hit: emptyHit, shift: true }),
      { type: "move", x: 140, y: 90, t: 30 },
    );
    expect(state.phase).toBe("marquee");
    expect(state.shift).toBe(true);
  });

  it("frees nothing when the press is held on empty space", () => {
    // The component arms its long-press timer on every press; the tick has to
    // decline for anything that is not a clip.
    const { state, effects } = run(
      down({ hit: emptyHit }),
      { type: "tick", t: DRAG.LONG_PRESS_MS },
    );
    expect(state.phase).toBe("pressed");
    expect(state.free).toBe(false);
    expect(kinds(effects)).toEqual(["clearSelection"]);
  });

  it("ignores a tick once the band is out", () => {
    const { state } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
      { type: "tick", t: DRAG.LONG_PRESS_MS },
    );
    expect(state.phase).toBe("marquee");
    expect(state.free).toBe(false);
  });

  it("asks for the crosshair when the band starts, and gives the cursor back on release", () => {
    const { effects } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
      { type: "up", t: 60 },
    );
    const cursors = effects
      .filter((e) => e.type === "cursor")
      .map((e) => (e as { value: string }).value);
    expect(cursors).toEqual(["crosshair", "default"]);
  });

  it("commits nothing on release, because a band edits no document", () => {
    const { effects } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
      { type: "up", t: 60 },
    );
    expect(kinds(effects)).not.toContain("checkpoint");
    expect(kinds(effects)).not.toContain("commit");
  });

  it("forgets everything after the band is released", () => {
    const { state } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
      { type: "up", t: 60 },
    );
    expect(state).toEqual(idleDrag);
  });

  it("puts the selection back when the band is cancelled", () => {
    const { state, effects } = run(
      down({ hit: emptyHit }),
      { type: "move", x: 140, y: 90, t: 30 },
      { type: "cancel" },
    );
    expect(state).toEqual(idleDrag);
    expect(kinds(effects)).toContain("restoreSelection");
    // A band has no document to throw away, so `revert` would be a lie.
    expect(kinds(effects)).not.toContain("revert");
  });

  it("still reverts the document when an ordinary drag is cancelled", () => {
    // The guard that splitting `cancel` by phase did not swallow `revert`.
    const { effects } = run(
      down(),
      { type: "move", x: 140, y: 50, t: 30 },
      { type: "cancel" },
    );
    expect(kinds(effects)).toContain("revert");
    expect(kinds(effects)).not.toContain("restoreSelection");
  });
});

describe("a non-primary press", () => {
  const emptyHit: Hit = { kind: "none" };

  it("still clears the selection, because the context menu acts on what it leaves", () => {
    const { effects } = run(down({ hit: emptyHit, primary: false }));
    expect(kinds(effects)).toEqual(["clearSelection"]);
  });

  it("arms nothing, so no band can be swept under the open menu", () => {
    const { state } = run(
      down({ hit: emptyHit, primary: false }),
      { type: "move", x: 300, y: 200, t: 40 },
    );
    expect(state).toEqual(idleDrag);
  });

  it("cannot start a slide, a lift or a trim on a clip either", () => {
    for (const hit of [bodyHit, startHandle, endHandle]) {
      const { state } = run(down({ hit, primary: false }));
      expect(state).toEqual(idleDrag);
    }
    // Not even with Alt, which is otherwise an immediate lift.
    expect(run(down({ alt: true, primary: false })).state).toEqual(idleDrag);
  });

  it("leaves the cursor alone, having started nothing to show", () => {
    const { effects } = run(down({ hit: startHandle, primary: false }));
    expect(effects).toEqual([]);
  });

  it("still behaves as a primary press when the flag is not given", () => {
    // Every existing caller predates the flag and must be unaffected.
    expect(run(down()).state.phase).toBe("pressed");
    expect(run(down({ primary: true })).state.phase).toBe("pressed");
  });
});
