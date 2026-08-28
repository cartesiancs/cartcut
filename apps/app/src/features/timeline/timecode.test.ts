/**
 * The playhead readout has to name a frame, and name it the same way every
 * other consumer of the cursor does.
 *
 * Two claims, and the second is the one that would bite: the frame field counts
 * the frame *containing* the instant (so it agrees with `frameStartMs`, the
 * effect clock and the exporter), and it never reaches `fps` — a `00:00:00:60`
 * at 60fps would be a second that lasted sixty-one frames.
 */

import { describe, expect, it } from "vitest";
import { formatTimecode } from "./timecode";
import { DEFAULT_FPS, frameToMs, msToFrameFloor } from "./frames";
import { mulberry32 } from "../renderer/testing";

const RATES = [24, 25, 30, 50, 60, 120];

describe("formatTimecode", () => {
  it("counts frames from zero within the second", () => {
    for (const fps of RATES) {
      for (let frame = 0; frame < fps; frame++) {
        const text = formatTimecode(frameToMs(frame, fps), fps);
        expect(text.startsWith("00:00:00:")).toBe(true);
        expect(Number(text.slice(9))).toBe(frame);
      }
    }
  });

  it("rolls over to the next second on that second's first frame", () => {
    for (const fps of RATES) {
      const last = formatTimecode(frameToMs(fps - 1, fps), fps);
      const first = formatTimecode(frameToMs(fps, fps), fps);
      expect(last.slice(0, 8)).toBe("00:00:00");
      expect(first.slice(0, 8)).toBe("00:00:01");
      expect(Number(first.slice(9))).toBe(0);
    }
  });

  it("names the frame that contains the instant, not the nearest one", () => {
    // The whole reason this is not `Math.round`. Two thirds of the way through
    // a frame, the picture still shows that frame.
    for (const fps of RATES) {
      const step = 1000 / fps;
      for (let frame = 0; frame < 200; frame++) {
        const start = frameToMs(frame, fps);
        for (const offset of [0, 0.01, 0.5, 0.75, 0.99]) {
          const text = formatTimecode(start + step * offset, fps);
          expect(Number(text.slice(9))).toBe(frame % fps);
        }
      }
    }
  });

  it("agrees with msToFrameFloor at any instant at all", () => {
    const random = mulberry32(31);
    for (const fps of RATES) {
      for (let i = 0; i < 400; i++) {
        const ms = random() * 4 * 3_600_000;
        const total = msToFrameFloor(ms, fps);
        const text = formatTimecode(ms, fps);
        const [h, m, s, f] = text.split(":").map(Number);
        expect(((h * 60 + m) * 60 + s) * fps + f).toBe(total);
      }
    }
  });

  it("never prints a frame number the rate cannot reach", () => {
    const random = mulberry32(99);
    for (const fps of RATES) {
      for (let i = 0; i < 400; i++) {
        const frames = Number(
          formatTimecode(random() * 7_200_000, fps).slice(9),
        );
        expect(frames).toBeGreaterThanOrEqual(0);
        expect(frames).toBeLessThan(fps);
      }
    }
  });

  it("carries minutes and hours", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(61_000, 30)).toBe("00:01:01:00");
    expect(formatTimecode(3_600_000, 30)).toBe("01:00:00:00");
    expect(formatTimecode(3_661_000 + 100, 30)).toBe("01:01:01:03");
  });

  it("holds its width, so the readout does not jitter during playback", () => {
    for (const fps of RATES) {
      const widths = new Set<number>();
      for (let frame = 0; frame < fps * 3; frame++) {
        widths.add(formatTimecode(frameToMs(frame, fps), fps).length);
      }
      expect(widths.size).toBe(1);
    }
  });

  it("widens the frame field only where the rate needs it", () => {
    // Two digits up to 99fps, three from 100 — the same rule an NLE uses.
    expect(formatTimecode(0, 60)).toBe("00:00:00:00");
    expect(formatTimecode(0, 120)).toBe("00:00:00:000");
    expect(formatTimecode(frameToMs(119, 120), 120)).toBe("00:00:00:119");
  });

  it("clamps below zero rather than printing a negative frame", () => {
    for (const fps of RATES) {
      expect(formatTimecode(-1, fps)).toBe(formatTimecode(0, fps));
      expect(formatTimecode(-100_000, fps)).toBe(formatTimecode(0, fps));
    }
  });

  it("falls back for an unusable rate", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(formatTimecode(1000, bad)).toBe(formatTimecode(1000, DEFAULT_FPS));
    }
  });

  it("keeps the frame field inside the second for a fractional rate", () => {
    // Nothing upstream can produce one — `coerceFps` guarantees an integer —
    // but a rate arriving from somewhere unexpected must degrade to a slightly
    // wrong label, not to a frame field that counts past its own second.
    for (const fps of [29.97, 23.976, 59.94]) {
      const rounded = Math.round(fps);
      for (let i = 0; i < 200; i++) {
        const frames = Number(formatTimecode(i * 37.5, fps).slice(9));
        expect(frames).toBeLessThan(rounded);
      }
    }
  });
});
