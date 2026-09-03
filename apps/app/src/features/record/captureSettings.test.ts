import { describe, expect, it } from "vitest";

import {
  avcCodec,
  avcCodecCandidates,
  avcLevelIdc,
  bitrateFor,
  captureSizeFor,
  encoderPlan,
  evenDown,
  keyFrameIntervalFrames,
  captureSizeLadder,
  macroblocksFor,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  nativeCaptureSize,
} from "./captureSettings";

/** A 14" MacBook Pro panel: 1512×982 points behind 3024×1964 real pixels. */
const RETINA = { width: 1512, height: 982, scaleFactor: 2 };

describe("evenDown", () => {
  // H.264 is 4:2:0; an odd dimension has no chroma representation and encoders
  // pad it into a visible edge column.
  it("never returns an odd number", () => {
    for (let value = 0; value < 200; value += 1) {
      expect(evenDown(value, 2) % 2).toBe(0);
    }
  });

  it("rounds down, never up", () => {
    expect(evenDown(101, 2)).toBe(100);
    expect(evenDown(100, 2)).toBe(100);
  });

  it("answers the floor for anything unreadable", () => {
    expect(evenDown(Number.NaN, 8)).toBe(8);
    expect(evenDown(-5, 8)).toBe(8);
  });
});

describe("nativeCaptureSize", () => {
  // The whole point of the module: the in-panel recorder pins 1920×1080 here
  // and throws away 64% of this display's pixels before the encoder sees them.
  it("multiplies logical points by the scale factor", () => {
    expect(nativeCaptureSize(RETINA)).toEqual({ width: 3024, height: 1964 });
  });

  it("leaves a 1× display alone", () => {
    expect(
      nativeCaptureSize({ width: 1920, height: 1080, scaleFactor: 1 }),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it("handles a fractional Windows scale factor", () => {
    const size = nativeCaptureSize({
      width: 1707,
      height: 960,
      scaleFactor: 1.5,
    });
    expect(size).toEqual({ width: 2560, height: 1440 });
  });

  // Clamping each axis on its own would stretch the picture.
  it("clamps oversized displays without changing their aspect", () => {
    const size = nativeCaptureSize({
      width: 6016,
      height: 3384,
      scaleFactor: 1,
    });

    expect(size.width).toBeLessThanOrEqual(MAX_CAPTURE_WIDTH);
    expect(size.height).toBeLessThanOrEqual(MAX_CAPTURE_HEIGHT);
    expect(size.width / size.height).toBeCloseTo(6016 / 3384, 2);
  });

  it("degrades rather than returning a zero-sized frame", () => {
    const size = nativeCaptureSize({ width: 0, height: 0, scaleFactor: 2 });
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("captureSizeFor", () => {
  it("gives the display's own pixels for native", () => {
    expect(captureSizeFor(RETINA, "native")).toEqual({
      width: 3024,
      height: 1964,
    });
  });

  it("scales down to the named height, keeping the aspect", () => {
    const size = captureSizeFor(RETINA, "1080p");
    expect(size.height).toBe(1080);
    expect(size.width % 2).toBe(0);
    expect(size.width / size.height).toBeCloseTo(3024 / 1964, 2);
  });

  // Upscaling spends bitrate on pixels that carry no information.
  it("never enlarges a display smaller than the preset", () => {
    const small = { width: 1280, height: 800, scaleFactor: 1 };
    expect(captureSizeFor(small, "1080p")).toEqual({
      width: 1280,
      height: 800,
    });
  });
});

describe("captureSizeLadder", () => {
  // A hardware encoder's real limits are not the codec's: VideoToolbox refuses
  // a 16" MacBook's own 3600×2338 whatever the level tables say. Guessing the
  // limit would be wrong on the next machine, so the recorder walks this.
  it("starts at the size asked for", () => {
    const native = { width: 3600, height: 2338 };
    expect(captureSizeLadder(native)[0]).toEqual(native);
  });

  it("descends, strictly, so the walk terminates", () => {
    const ladder = captureSizeLadder({ width: 3600, height: 2338 });

    expect(ladder.length).toBeGreaterThan(1);
    for (let index = 1; index < ladder.length; index += 1) {
      expect(ladder[index].width).toBeLessThan(ladder[index - 1].width);
      expect(ladder[index].height).toBeLessThan(ladder[index - 1].height);
    }
  });

  it("keeps the aspect ratio at every rung, on even dimensions", () => {
    const native = { width: 3600, height: 2338 };
    const aspect = native.width / native.height;

    for (const rung of captureSizeLadder(native)) {
      expect(rung.width / rung.height).toBeCloseTo(aspect, 2);
      expect(rung.width % 2).toBe(0);
      expect(rung.height % 2).toBe(0);
    }
  });

  it("never upscales: a small display has nowhere to descend to", () => {
    expect(captureSizeLadder({ width: 1280, height: 720 })).toEqual([
      { width: 1280, height: 720 },
    ]);
  });

  it("skips rungs at or above the size asked for", () => {
    const ladder = captureSizeLadder({ width: 1920, height: 1080 });

    expect(ladder[0]).toEqual({ width: 1920, height: 1080 });
    expect(ladder.map((rung) => rung.height)).not.toContain(2160);
    expect(ladder.map((rung) => rung.height)).toContain(720);
  });
});

describe("bitrateFor", () => {
  it("scales with pixels and rate", () => {
    const at30 = bitrateFor("screen", { width: 1920, height: 1080 }, 30);
    const at60 = bitrateFor("screen", { width: 1920, height: 1080 }, 60);
    expect(at60).toBeGreaterThan(at30);
    expect(at60 / at30).toBeCloseTo(2, 1);
  });

  // Screen content is mostly flat and then it is one-pixel text edges, which is
  // the hardest thing H.264 does.
  it("gives screen content more than camera content of the same size", () => {
    const size = { width: 1280, height: 720 };
    expect(bitrateFor("screen", size, 30)).toBeGreaterThan(
      bitrateFor("camera", size, 30),
    );
  });

  it("gives the composite pass headroom over the screen capture", () => {
    const size = { width: 1920, height: 1080 };
    expect(bitrateFor("composite", size, 30)).toBeGreaterThan(
      bitrateFor("screen", size, 30),
    );
  });

  it("clamps at both ends", () => {
    expect(bitrateFor("screen", { width: 160, height: 120 }, 15)).toBe(
      6_000_000,
    );
    expect(bitrateFor("screen", { width: 5120, height: 2880 }, 60)).toBe(
      40_000_000,
    );
  });

  it("answers the floor rather than NaN for a degenerate frame", () => {
    expect(bitrateFor("screen", { width: 0, height: 0 }, 30)).toBe(6_000_000);
  });
});

describe("avcLevelIdc", () => {
  it("counts macroblocks with a partial row rounded up", () => {
    // 1080 / 16 is 67.5, and the encoder codes 68 rows.
    expect(macroblocksFor({ width: 1920, height: 1080 })).toBe(120 * 68);
  });

  // `avc1.640028` is High at level 4.0, which tops out here. Hardcoding it is
  // what breaks a 4K capture.
  it("picks level 4.0 for 1080p30", () => {
    expect(avcLevelIdc({ width: 1920, height: 1080 }, 30)).toBe(0x28);
  });

  it("moves up to 4.2 for 1080p60", () => {
    expect(avcLevelIdc({ width: 1920, height: 1080 }, 60)).toBe(0x2a);
  });

  it("moves up again for a native Retina capture", () => {
    expect(avcLevelIdc({ width: 3024, height: 1964 }, 30)).toBe(0x33);
  });

  // Lowest that fits, not highest available: a level is a promise to the
  // decoder, and overstating it locks out hardware that would have played it.
  it("picks the lowest level that admits the picture", () => {
    expect(avcLevelIdc({ width: 1280, height: 720 }, 30)).toBe(0x1f);
  });
});

describe("avcCodec", () => {
  it("spells the familiar 1080p30 High-profile string", () => {
    expect(avcCodec("high", { width: 1920, height: 1080 }, 30)).toBe(
      "avc1.640028",
    );
  });

  it("carries the profile bytes for main and baseline", () => {
    const size = { width: 1920, height: 1080 };
    expect(avcCodec("main", size, 30)).toBe("avc1.4D4028");
    expect(avcCodec("baseline", size, 30)).toBe("avc1.42E028");
  });

  it("offers three candidates, best first", () => {
    const candidates = avcCodecCandidates({ width: 1920, height: 1080 }, 30);
    expect(candidates).toEqual([
      "avc1.640028",
      "avc1.4D4028",
      "avc1.42E028",
    ]);
  });
});

describe("keyFrameIntervalFrames", () => {
  // Two seconds. A GOP is the granularity anything can seek at, and the editor
  // seeks constantly.
  it("is two seconds' worth of frames", () => {
    expect(keyFrameIntervalFrames(30)).toBe(60);
    expect(keyFrameIntervalFrames(60)).toBe(120);
  });

  it("never returns zero", () => {
    expect(keyFrameIntervalFrames(0)).toBe(60);
    expect(keyFrameIntervalFrames(Number.NaN)).toBe(60);
  });
});

describe("encoderPlan", () => {
  it("assembles a configuration whose level matches its own size", () => {
    const plan = encoderPlan("screen", { width: 3024, height: 1964 }, 30);

    expect(plan.width).toBe(3024);
    expect(plan.height).toBe(1964);
    expect(plan.framerate).toBe(30);
    expect(plan.keyFrameInterval).toBe(60);
    expect(plan.codecCandidates[0]).toBe("avc1.640033");
    expect(plan.bitrate).toBe(
      bitrateFor("screen", { width: 3024, height: 1964 }, 30),
    );
  });
});
