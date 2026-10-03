import { describe, expect, it } from "vitest";
import {
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  PRESS_SLOP_PX,
  TouchGesture,
  type GestureCommand,
} from "./touchGesture";

const p = (id: number, x: number, y: number) => ({ id, x, y });
const types = (out: GestureCommand[]) =>
  out.map((c) => (c.kind === "mouse" ? `${c.type}:${c.button}` : c.kind));

describe("TouchGesture, mouse mode", () => {
  it("holds the press back, then sends it where the finger landed", () => {
    const g = new TouchGesture();
    expect(g.start([p(1, 10, 10)], 0, "mouse")).toEqual([]);
    expect(g.move([p(1, 10 + PRESS_SLOP_PX, 10)])).toEqual([]);
    expect(g.move([p(1, 20, 10)])).toEqual([
      { kind: "mouse", type: "mousedown", x: 10, y: 10, button: 0 },
      { kind: "mouse", type: "mousemove", x: 20, y: 10, button: 0 },
    ]);
    expect(g.move([p(1, 60, 12)])).toEqual([
      { kind: "mouse", type: "mousemove", x: 60, y: 12, button: 0 },
    ]);
    expect(g.end([], 100)).toEqual([
      { kind: "mouse", type: "mouseup", x: 60, y: 12, button: 0 },
    ]);
    expect(g.active).toBe(false);
  });

  it("replays a still press whole, at the landing point", () => {
    const g = new TouchGesture();
    g.start([p(1, 10, 10)], 0, "mouse");
    g.move([p(1, 13, 10)]);
    expect(g.end([], 50)).toEqual([
      { kind: "mouse", type: "mousedown", x: 10, y: 10, button: 0 },
      { kind: "mouse", type: "mouseup", x: 10, y: 10, button: 0 },
      { kind: "mouse", type: "click", x: 10, y: 10, button: 0 },
    ]);
  });

  it("turns two quick taps in one place into a double click, once", () => {
    const g = new TouchGesture();
    g.start([p(1, 10, 10)], 0, "mouse");
    g.end([], 40);
    g.start([p(2, 14, 12)], 120, "mouse");
    expect(types(g.end([], 160))).toEqual([
      "mousedown:0",
      "mouseup:0",
      "click:0",
      "dblclick:0",
    ]);
    g.start([p(3, 14, 12)], 200, "mouse");
    expect(types(g.end([], 240))).toEqual(["mousedown:0", "mouseup:0", "click:0"]);
  });

  it("does not pair taps too far apart in time or space", () => {
    const g = new TouchGesture();
    g.start([p(1, 10, 10)], 0, "mouse");
    g.end([], 10);
    g.start([p(2, 10, 10)], 10 + DOUBLE_TAP_MS + 1, "mouse");
    expect(types(g.end([], 20 + DOUBLE_TAP_MS))).not.toContain("dblclick:0");

    const h = new TouchGesture();
    h.start([p(1, 10, 10)], 0, "mouse");
    h.end([], 10);
    h.start([p(2, 200, 10)], 50, "mouse");
    expect(types(h.end([], 60))).not.toContain("dblclick:0");
  });

  it("makes a long still press a right click and then ignores the finger", () => {
    const g = new TouchGesture();
    g.start([p(1, 30, 40)], 1000, "mouse");
    expect(g.longPressDeadline()).toBe(1000 + LONG_PRESS_MS);
    expect(g.tick(1000 + LONG_PRESS_MS - 1)).toEqual([]);
    expect(types(g.tick(1000 + LONG_PRESS_MS))).toEqual([
      "mousedown:2",
      "contextmenu:2",
      "mouseup:2",
    ]);
    expect(g.move([p(1, 300, 40)])).toEqual([]);
    expect(g.end([], 2000)).toEqual([]);
    expect(g.active).toBe(false);
  });

  it("never long-presses a finger that has started a drag", () => {
    const g = new TouchGesture();
    g.start([p(1, 0, 0)], 0, "mouse");
    g.move([p(1, 50, 0)]);
    expect(g.longPressDeadline()).toBeNull();
    expect(g.tick(LONG_PRESS_MS * 4)).toEqual([]);
  });

  it("ignores a second finger once something is being dragged", () => {
    const g = new TouchGesture();
    g.start([p(1, 0, 0)], 0, "mouse");
    g.move([p(1, 40, 0)]);
    expect(g.start([p(1, 40, 0), p(2, 100, 100)], 10, "mouse")).toEqual([]);
    expect(types(g.move([p(1, 50, 0), p(2, 120, 100)]))).toEqual(["mousemove:0"]);
  });

  it("pinches without ever pressing when a second finger lands first", () => {
    const g = new TouchGesture();
    g.start([p(1, 0, 0)], 0, "mouse");
    expect(g.start([p(1, 0, 0), p(2, 100, 0)], 10, "mouse")).toEqual([]);
    const out = g.move([p(1, 0, 0), p(2, 200, 0)]);
    expect(out[0]).toEqual({ kind: "pinch", scale: 2, x: 100, y: 0 });
    expect(out.some((c) => c.kind === "mouse")).toBe(false);
    expect(g.end([], 30)).toEqual([]);
  });

  it("releases a sent press when the system cancels the touch", () => {
    const g = new TouchGesture();
    g.start([p(1, 5, 6)], 0, "mouse");
    g.move([p(1, 50, 6)]);
    expect(g.cancel()).toEqual([
      { kind: "mouse", type: "mouseup", x: 50, y: 6, button: 0 },
    ]);
    expect(g.active).toBe(false);

    const h = new TouchGesture();
    h.start([p(1, 5, 6)], 0, "mouse");
    expect(h.cancel()).toEqual([]);
  });
});

describe("TouchGesture, pan mode", () => {
  it("holds back motion inside the slop, then delivers all of it", () => {
    const g = new TouchGesture();
    expect(g.start([p(1, 100, 100)], 0, "pan")).toEqual([]);
    expect(g.move([p(1, 105, 100)])).toEqual([]);
    expect(g.move([p(1, 100 - 20, 100)])).toEqual([
      { kind: "pan", dx: -20, dy: 0, x: 80, y: 100 },
    ]);
    expect(g.move([p(1, 70, 95)])).toEqual([
      { kind: "pan", dx: -10, dy: -5, x: 70, y: 95 },
    ]);
    expect(g.end([], 100)).toEqual([]);
  });

  it("replays a tap as a full click at the press point", () => {
    const g = new TouchGesture();
    g.start([p(1, 7, 8)], 0, "pan");
    expect(types(g.end([], 30))).toEqual(["mousedown:0", "mouseup:0", "click:0"]);
  });

  it("long-presses into a right click without a primary press first", () => {
    const g = new TouchGesture();
    g.start([p(1, 7, 8)], 0, "pan");
    expect(types(g.tick(LONG_PRESS_MS))).toEqual([
      "mousedown:2",
      "contextmenu:2",
      "mouseup:2",
    ]);
  });

  it("pinches with two fingers and pans their centre", () => {
    const g = new TouchGesture();
    g.start([p(1, 0, 0)], 0, "pan");
    g.move([p(1, 30, 0)]);
    g.start([p(1, 30, 0), p(2, 130, 0)], 5, "pan");
    expect(g.move([p(1, 30, 0), p(2, 80, 0)])).toEqual([
      { kind: "pinch", scale: 0.5, x: 55, y: 0 },
      { kind: "pan", dx: -25, dy: 0, x: 55, y: 0 },
    ]);
    // One finger up: the other never becomes a fresh drag.
    expect(g.end([p(1, 30, 0)], 10)).toEqual([]);
    expect(g.move([p(1, 90, 0)])).toEqual([]);
    expect(g.end([], 20)).toEqual([]);
    expect(g.active).toBe(false);
  });

  it("starts a pinch directly when two fingers land together", () => {
    const g = new TouchGesture();
    expect(g.start([p(1, 0, 0), p(2, 10, 0)], 0, "mouse")).toEqual([]);
    expect(types(g.move([p(1, 0, 0), p(2, 30, 0)]))).toEqual(["pinch", "pan"]);
  });
});

describe("TouchGesture, axis mode", () => {
  it("becomes a mouse drag when the finger goes sideways", () => {
    const g = new TouchGesture();
    g.start([p(1, 100, 100)], 0, "axis");
    expect(g.move([p(1, 103, 101)])).toEqual([]);
    expect(types(g.move([p(1, 120, 104)]))).toEqual(["mousedown:0", "mousemove:0"]);
    expect(types(g.move([p(1, 150, 110)]))).toEqual(["mousemove:0"]);
    expect(types(g.end([], 50))).toEqual(["mouseup:0"]);
  });

  it("becomes a pan when the finger goes up or down", () => {
    const g = new TouchGesture();
    g.start([p(1, 100, 100)], 0, "axis");
    expect(g.move([p(1, 102, 92)])).toEqual([
      { kind: "pan", dx: 2, dy: -8, x: 102, y: 92 },
    ]);
    expect(g.move([p(1, 102, 80)])).toEqual([
      { kind: "pan", dx: 0, dy: -12, x: 102, y: 80 },
    ]);
    expect(g.end([], 50)).toEqual([]);
  });

  it("is still a tap when the finger never left the slop", () => {
    const g = new TouchGesture();
    g.start([p(1, 100, 100)], 0, "axis");
    g.move([p(1, 103, 102)]);
    expect(types(g.end([], 50))).toEqual(["mousedown:0", "mouseup:0", "click:0"]);
  });
});
