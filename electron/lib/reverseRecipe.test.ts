import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_SEC,
  MIN_CHUNK_SEC,
  chunkSecondsFor,
  concatList,
  joinArgs,
  outputFps,
  overallFraction,
  splitArgs,
  stageWeights,
} from "./reverseRecipe";

describe("chunkSecondsFor", () => {
  it("keeps the user's heavy screen recordings to about a third of a second", () => {
    // 3600x2338 yuv420p is 12.6MB a frame; at 120fps that is 1.5GB a second.
    const seconds = chunkSecondsFor(3600, 2338, 120);
    expect(seconds).toBeGreaterThan(0.3);
    expect(seconds).toBeLessThan(0.4);
  });

  it("gives ordinary 1080p30 a few seconds", () => {
    const seconds = chunkSecondsFor(1920, 1080, 30);
    expect(seconds).toBeGreaterThan(5);
    expect(seconds).toBeLessThan(6);
  });

  it("clamps at both ends", () => {
    expect(chunkSecondsFor(8192, 8192, 240)).toBe(MIN_CHUNK_SEC);
    expect(chunkSecondsFor(16, 16, 1)).toBe(MAX_CHUNK_SEC);
  });

  it("survives a probe that found nothing", () => {
    expect(Number.isFinite(chunkSecondsFor(0, 0, 0))).toBe(true);
  });
});

describe("outputFps", () => {
  it("takes the nominal rate when it is usable", () => {
    expect(outputFps("120/1", "119/1")).toBe(120);
    expect(outputFps("30000/1001", undefined)).toBeCloseTo(29.97, 2);
  });

  it("falls through a nonsense nominal rate to the average", () => {
    expect(outputFps("1000/1", "60/1")).toBe(60);
  });

  it("falls back to 30 when neither is usable", () => {
    expect(outputFps("0/0", "N/A")).toBe(30);
    expect(outputFps(undefined, undefined)).toBe(30);
  });
});

describe("splitArgs", () => {
  const args = splitArgs({
    source: "/in.mp4",
    fromSec: 2,
    lenSec: 3,
    fps: 60,
    chunkSec: 0.5,
    pattern: "/tmp/seg_%05d.mp4",
  });

  it("seeks on the input so the cut is one decode", () => {
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("2.000");
    expect(args[args.indexOf("-t") + 1]).toBe("3.000");
  });

  it("forces a keyframe exactly where each chunk begins", () => {
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe(
      "expr:gte(t,n_forced*0.5)",
    );
    expect(args[args.indexOf("-segment_time") + 1]).toBe("0.5");
  });

  it("clocks the output at a constant rate", () => {
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("cfr");
    expect(args[args.indexOf("-r") + 1]).toBe("60");
  });
});

describe("joinArgs", () => {
  it("maps the sound only when there is some", () => {
    expect(joinArgs("/l.txt", null, "/o").join(" ")).not.toContain("1:a:0");
    expect(joinArgs("/l.txt", "/a.m4a", "/o").join(" ")).toContain("1:a:0");
  });

  it("names the container, because the output is a .part", () => {
    const args = joinArgs("/l.txt", null, "/o.mp4.part");
    expect(args[args.indexOf("-f", 2) + 1]).toBe("mp4");
  });
});

describe("concatList", () => {
  it("escapes an apostrophe the way the concat demuxer reads it", () => {
    expect(concatList(["/a/it's.mp4"])).toBe("file '/a/it'\\''s.mp4'\n");
  });
});

describe("overallFraction", () => {
  it("runs from 0 to 1 across the stages in order", () => {
    const weights = stageWeights(true);
    expect(overallFraction(weights, "split", 0)).toBe(0);
    expect(overallFraction(weights, "split", 1)).toBeCloseTo(0.45);
    expect(overallFraction(weights, "reverse", 0.5)).toBeCloseTo(0.675);
    expect(overallFraction(weights, "join", 1)).toBeCloseTo(1);
  });

  it("gives the sound's share to the big stages when there is none", () => {
    const weights = stageWeights(false);
    expect(weights.audio).toBe(0);
    expect(overallFraction(weights, "join", 1)).toBeCloseTo(1);
  });

  it("clamps a stage fraction that overshoots", () => {
    const weights = stageWeights(true);
    expect(overallFraction(weights, "join", 7)).toBeCloseTo(1);
    expect(overallFraction(weights, "split", -1)).toBe(0);
  });
});
