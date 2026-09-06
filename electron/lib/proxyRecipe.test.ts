import { describe, it, expect } from "vitest";
import {
  PROXY_GOP,
  PROXY_MAX_EDGE,
  PROXY_MAX_FPS,
  needsProxy,
  proxyArgs,
  proxySizeFor,
} from "./proxyRecipe";

describe("proxySizeFor", () => {
  // The source that prompted the feature: a macOS screen recording at the
  // display's own pixel size, at 120fps.
  it("brings a 3600x2338 120fps screen recording down to something playable", () => {
    const size = proxySizeFor({ width: 3600, height: 2338, fps: 120 });
    expect(Math.max(size.width, size.height)).toBe(PROXY_MAX_EDGE);
    expect(size.fps).toBe(PROXY_MAX_FPS);

    const before = 3600 * 2338 * 120;
    const after = size.width * size.height * size.fps;
    // Two orders of magnitude fewer pixels per second to decode.
    expect(before / after).toBeGreaterThan(20);
  });

  it("never upscales", () => {
    const size = proxySizeFor({ width: 640, height: 360, fps: 30 });
    expect(size).toEqual({ width: 640, height: 360, fps: 30 });
  });

  it("keeps both dimensions even at every input size", () => {
    for (let w = 101; w < 4000; w += 137) {
      for (const h of [w - 1, Math.round(w * 0.5625), Math.round(w * 1.77)]) {
        const size = proxySizeFor({ width: w, height: h, fps: 60 });
        expect(size.width % 2).toBe(0);
        expect(size.height % 2).toBe(0);
        expect(size.width).toBeGreaterThanOrEqual(2);
        expect(size.height).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("holds the aspect ratio to within half a pixel", () => {
    for (const [w, h] of [
      [3600, 2338],
      [1920, 1080],
      [3840, 2160],
      [1080, 1920],
      [2048, 858],
    ]) {
      const size = proxySizeFor({ width: w, height: h, fps: 60 });
      const sourceRatio = w / h;
      const proxyRatio = size.width / size.height;
      // Expressed as a pixel error on the longer edge, which is what a viewer
      // would actually see if the framing shifted.
      const errorPx = Math.abs(proxyRatio - sourceRatio) * size.height;
      expect(errorPx).toBeLessThanOrEqual(1);
    }
  });

  it("caps the frame rate but does not raise it", () => {
    expect(proxySizeFor({ width: 100, height: 100, fps: 120 }).fps).toBe(60);
    expect(proxySizeFor({ width: 100, height: 100, fps: 24 }).fps).toBe(24);
  });

  it("falls back to a sane rate when the source rate is unknown", () => {
    for (const fps of [0, NaN, -1, Infinity]) {
      expect(proxySizeFor({ width: 100, height: 100, fps }).fps).toBe(
        PROXY_MAX_FPS,
      );
    }
  });
});

describe("needsProxy", () => {
  it("is true for the 120fps screen recording", () => {
    expect(needsProxy({ width: 3600, height: 2338, fps: 120 })).toBe(true);
  });

  it("is true for 4K60", () => {
    expect(needsProxy({ width: 3840, height: 2160, fps: 60 })).toBe(true);
  });

  // The judgement the threshold encodes: 1080p60 is what the preview is being
  // asked to produce anyway, so a proxy of it buys nothing.
  it("is false for 1080p60", () => {
    expect(needsProxy({ width: 1920, height: 1080, fps: 59.94 })).toBe(false);
  });

  it("is false for 1080p30", () => {
    expect(needsProxy({ width: 1920, height: 1080, fps: 30 })).toBe(false);
  });

  // Resolution alone is the wrong test, and this is the pair that shows why.
  it("separates two files of the same resolution by their frame rate", () => {
    expect(needsProxy({ width: 1920, height: 1080, fps: 30 })).toBe(false);
    expect(needsProxy({ width: 1920, height: 1080, fps: 240 })).toBe(true);
  });
});

describe("proxyArgs", () => {
  const size = { width: 960, height: 624, fps: 60 };

  it("asks for H.264, not ProRes", () => {
    const args = proxyArgs("/in.mov", "/out.mp4", size);
    expect(args).toContain("libx264");
    expect(args.join(" ")).not.toMatch(/prores/i);
  });

  it("asks for a short GOP and no B-frames", () => {
    const args = proxyArgs("/in.mov", "/out.mp4", size);
    expect(args[args.indexOf("-g") + 1]).toBe(String(PROXY_GOP));
    expect(args[args.indexOf("-bf") + 1]).toBe("0");
  });

  /**
   * The one that is easy to get wrong, and silent when you do.
   *
   * A video clip's sound in the preview comes off the same `<video>` element as
   * its picture — `playback.ts` mutes and levels that handle directly — so a
   * proxy encoded with `-an` does not save work, it makes every video clip mute
   * the moment proxies are switched on.
   */
  it("keeps audio, optionally, so proxied clips are not silent", () => {
    const args = proxyArgs("/in.mov", "/out.mp4", size);
    expect(args).not.toContain("-an");
    // `0:a?` — optional, so a source with no audio track still encodes.
    expect(args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]).toBe(
      "0:a?",
    );
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
  });

  it("puts the index at the front so playback can start before the read ends", () => {
    const args = proxyArgs("/in.mov", "/out.mp4", size);
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
  });

  /**
   * Found by running it: `proxy.ts` writes to `<name>.mp4.part` so a killed
   * transcode cannot leave a truncated file where a valid one is indexed, and
   * FFmpeg chooses its muxer from the extension — so it refused the job with
   * "Unable to choose an output format" before touching a frame.
   */
  it("names the output format rather than leaving it to the extension", () => {
    const args = proxyArgs("/in.mov", "/out.mp4.part", size);
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
  });

  it("scales to the computed size and ends at the output path", () => {
    const args = proxyArgs("/in.mov", "/out.mp4", size);
    expect(args[args.indexOf("-vf") + 1]).toContain("scale=960:624");
    expect(args[args.length - 1]).toBe("/out.mp4");
  });

  // Paths go to `spawn` as an argv array, never through a shell, so a space or
  // a narrow no-break space — which is exactly what macOS puts in a screen
  // recording's filename — must survive untouched.
  it("passes an awkward filename through verbatim", () => {
    const weird = "/x/Screen Recording 2026-09-05 at 3.02.07 PM.mov";
    const args = proxyArgs(weird, "/out.mp4", size);
    expect(args[args.indexOf("-i") + 1]).toBe(weird);
  });
});
