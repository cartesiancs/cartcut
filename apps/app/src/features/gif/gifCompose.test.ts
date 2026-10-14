import { describe, expect, it } from "vitest";

import {
  composeTo,
  emptyComposeState,
  type GifComposePort,
  type GifFrameInfo,
  type GifRect,
} from "./gifCompose";

const FULL: GifRect = { left: 0, top: 0, width: 4, height: 4 };
const CORNER: GifRect = { left: 2, top: 2, width: 2, height: 2 };

/** A port that writes down what it was asked to do. */
function recorder() {
  const calls: string[] = [];
  let snapshots = 0;
  const port: GifComposePort<string> = {
    clearAll: () => calls.push("clearAll"),
    clearRect: (r) => calls.push(`clear ${r.left},${r.top}`),
    drawFrame: (i) => calls.push(`draw ${i}`),
    save: (r) => {
      const name = `snap${snapshots++}`;
      calls.push(`save ${r.left},${r.top} as ${name}`);
      return name;
    },
    restore: (s, r) => calls.push(`restore ${s} at ${r.left},${r.top}`),
  };
  return { calls, port };
}

function frames(...disposals: number[]): GifFrameInfo[] {
  return disposals.map((disposal, i) => ({ rect: i === 0 ? FULL : CORNER, disposal }));
}

describe("composeTo", () => {
  it("builds forward from a cleared picture, one patch per frame", () => {
    const { calls, port } = recorder();
    const state = composeTo(emptyComposeState<string>(), frames(1, 1, 1), 2, port);
    expect(state.index).toBe(2);
    expect(calls).toEqual(["clearAll", "draw 0", "draw 1", "draw 2"]);
  });

  it("draws only the next patch when playback moves one frame on", () => {
    const list = frames(1, 1, 1);
    const first = recorder();
    const at1 = composeTo(emptyComposeState<string>(), list, 1, first.port);

    const second = recorder();
    composeTo(at1, list, 2, second.port);
    expect(second.calls).toEqual(["draw 2"]);
  });

  it("clears the shown frame's rectangle before the next for disposal 2", () => {
    const { calls, port } = recorder();
    composeTo(emptyComposeState<string>(), frames(1, 2, 1), 2, port);
    expect(calls).toEqual(["clearAll", "draw 0", "draw 1", "clear 2,2", "draw 2"]);
  });

  it("puts back what was under the frame for disposal 3", () => {
    const { calls, port } = recorder();
    composeTo(emptyComposeState<string>(), frames(1, 3, 1), 2, port);
    expect(calls).toEqual([
      "clearAll",
      "draw 0",
      "save 2,2 as snap0",
      "draw 1",
      "restore snap0 at 2,2",
      "draw 2",
    ]);
  });

  it("starts again from a cleared picture when asked for an earlier frame", () => {
    const list = frames(1, 2, 1);
    const at2 = composeTo(emptyComposeState<string>(), list, 2, recorder().port);

    const { calls, port } = recorder();
    const state = composeTo(at2, list, 0, port);
    expect(state.index).toBe(0);
    expect(calls).toEqual(["clearAll", "draw 0"]);
  });

  it("declines by identity for the frame it already shows or one that does not exist", () => {
    const list = frames(1, 1);
    const at1 = composeTo(emptyComposeState<string>(), list, 1, recorder().port);
    const { calls, port } = recorder();
    expect(composeTo(at1, list, 1, port)).toBe(at1);
    expect(composeTo(at1, list, 5, port)).toBe(at1);
    expect(composeTo(at1, list, -1, port)).toBe(at1);
    expect(calls).toEqual([]);
  });
});
