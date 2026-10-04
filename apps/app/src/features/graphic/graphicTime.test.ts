import { describe, expect, it } from "vitest";
import { graphicTimeOf, withClockShift } from "./graphicTime";

const FPS = 30;

describe("graphicTimeOf", () => {
  it("is element-local and snapped to the frame grid", () => {
    const at = graphicTimeOf({ startTime: 1000, duration: 4000 }, 1050, FPS);
    // 1050 snaps to frame 31 at 30 fps, 1033.33..ms.
    expect(at.localMs).toBeCloseTo(33.333, 2);
    expect(at.tMs).toBeCloseTo(33.333, 2);
    expect(at.durMs).toBe(4000);
  });

  it("adds the head to the time and both ends to the length", () => {
    const at = graphicTimeOf(
      { startTime: 0, duration: 2000, clockHead: 1000, clockTail: 500 },
      1000,
      FPS,
    );
    expect(at.tMs).toBe(2000);
    expect(at.durMs).toBe(3500);
    expect(at.progress).toBeCloseTo(2000 / 3500, 6);
  });

  it("holds the first and last frames outside the clip", () => {
    const element = { startTime: 1000, duration: 1000 };
    expect(graphicTimeOf(element, 0, FPS).localMs).toBe(0);
    expect(graphicTimeOf(element, 5000, FPS).localMs).toBe(1000);
  });

  it("allows a negative program time after a front extend", () => {
    const at = graphicTimeOf({ startTime: 0, duration: 1000, clockHead: -300 }, 0, FPS);
    expect(at.tMs).toBe(-300);
    expect(at.progress).toBe(0);
  });

  it("calls a zero-length program finished", () => {
    expect(graphicTimeOf({ startTime: 0, duration: 0 }, 0, FPS).progress).toBe(1);
  });

  it("gives a split's two halves the frames of the whole", () => {
    // A 4s program cut at 1.5s: left keeps the head, gains 2.5s of tail; right
    // gains 1.5s of head. Every instant must read the same program time and
    // length as the uncut clip.
    const whole = { startTime: 0, duration: 4000 };
    const left = withClockShift({ startTime: 0, duration: 1500 }, 0, 2500);
    const right = withClockShift({ startTime: 1500, duration: 2500 }, 1500, 0);
    for (const t of [0, 700, 1499, 1500, 3000, 3999]) {
      const piece = t < 1500 ? left : right;
      const a = graphicTimeOf(whole, t, FPS);
      const b = graphicTimeOf(piece, t, FPS);
      expect(b.tMs).toBeCloseTo(a.tMs, 9);
      expect(b.durMs).toBe(a.durMs);
      expect(b.progress).toBeCloseTo(a.progress, 9);
    }
  });
});

describe("withClockShift", () => {
  it("deletes a key that returns to zero", () => {
    const shifted = withClockShift({ startTime: 0, duration: 1, clockHead: 200 }, -200, 0);
    expect("clockHead" in shifted).toBe(false);
    expect("clockTail" in shifted).toBe(false);
  });

  it("never lets the tail go negative", () => {
    expect(withClockShift({ startTime: 0, duration: 1, clockTail: 100 }, 0, -500)).toEqual({
      startTime: 0,
      duration: 1,
    });
  });

  it("adds no keys to an element that had none and moves nothing", () => {
    const element = { startTime: 0, duration: 1 };
    expect(withClockShift(element, 0, 0)).toEqual(element);
  });
});
