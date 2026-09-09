import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportStore } from "./exportStore";

const initial = exportStore.getInitialState();
const reset = () =>
  exportStore.setState({
    phase: initial.phase,
    percent: initial.percent,
    remainingMs: initial.remainingMs,
    destination: initial.destination,
  });

const state = () => exportStore.getState();

beforeEach(reset);

describe("exportStore.begin", () => {
  it("runs, zeroes the numbers and records the destination", () => {
    state().report(40, 9000);
    state().begin("/tmp/out.mp4");

    expect(state().phase).toBe("running");
    expect(state().percent).toBe(0);
    expect(state().remainingMs).toBeNull();
    expect(state().destination).toBe("/tmp/out.mp4");
  });

  it("clears the previous run's numbers rather than leaving them on screen", () => {
    state().begin("/tmp/a.mp4");
    state().report(80, 3000);
    state().dispatch("settled");

    state().begin("/tmp/b.mp4");
    expect(state().percent).toBe(0);
    expect(state().remainingMs).toBeNull();
  });
});

describe("exportStore.dispatch", () => {
  it("follows the phase table", () => {
    state().begin("/tmp/out.mp4");
    state().dispatch("frameLoopDone");
    expect(state().phase).toBe("finalizing");
    state().dispatch("settled");
    expect(state().phase).toBe("idle");
  });

  it("does not notify when the transition declines", () => {
    // The whole point of the identity decline in `nextPhase`. A duplicate
    // `settled` — the click handler's `finally` racing `render:v2:cancelled` —
    // must repaint nothing.
    const listener = vi.fn();
    const unsubscribe = exportStore.subscribe(listener);

    state().dispatch("settled");
    state().dispatch("frameLoopDone");
    state().dispatch("cancelRequested");

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies once for a transition that does move", () => {
    const listener = vi.fn();
    const unsubscribe = exportStore.subscribe(listener);

    state().dispatch("start");

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("exportStore.report", () => {
  it("declines when neither the whole percent nor the whole second moved", () => {
    state().begin("/tmp/out.mp4");
    state().report(41.2, 9400);

    const listener = vi.fn();
    const unsubscribe = exportStore.subscribe(listener);
    state().report(41.4, 9100); // same rounded percent, same ceil'd second
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(state().percent).toBe(41.2);
  });

  it("accepts when the whole percent moves", () => {
    state().begin("/tmp/out.mp4");
    state().report(41.2, 9400);
    state().report(42.0, 9400);
    expect(state().percent).toBe(42);
  });

  it("accepts when only the whole second moves", () => {
    state().begin("/tmp/out.mp4");
    state().report(41.2, 9400);
    state().report(41.2, 8000);
    expect(state().remainingMs).toBe(8000);
  });

  it("treats null and a number as different paints", () => {
    state().begin("/tmp/out.mp4");
    state().report(50, null);
    state().report(50, 4000);
    expect(state().remainingMs).toBe(4000);
    state().report(50, null);
    expect(state().remainingMs).toBeNull();
  });

  it("clamps rather than storing a percentage nothing can draw", () => {
    state().report(-10, null);
    expect(state().percent).toBe(0);
    state().report(140, null);
    expect(state().percent).toBe(100);
  });
});

describe("exportStore.destination", () => {
  it("survives the export it belongs to", () => {
    // "Open Saved Folder" is pressed from a dialog shown after `settled`.
    state().begin("/tmp/out.mp4");
    state().dispatch("frameLoopDone");
    state().dispatch("settled");
    expect(state().destination).toBe("/tmp/out.mp4");
  });

  it("takes main's answer, which is authoritative about the file written", () => {
    state().begin("/tmp/guess.mp4");
    state().setDestination("/tmp/real.mp4");
    expect(state().destination).toBe("/tmp/real.mp4");
  });

  it("declines an empty or unchanged path", () => {
    state().begin("/tmp/out.mp4");
    const listener = vi.fn();
    const unsubscribe = exportStore.subscribe(listener);
    state().setDestination("");
    state().setDestination("/tmp/out.mp4");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(state().destination).toBe("/tmp/out.mp4");
  });
});
