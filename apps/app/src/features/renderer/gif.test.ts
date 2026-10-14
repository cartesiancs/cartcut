import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GifFrameInfo } from "../gif/gifCompose";
import { decodeGif, type LoadedGif } from "../gif/gifDecode";
import { gifTiming } from "../gif/gifTiming";
import { gifElement, pixel, scene } from "./testing";

const store = {
  getGif: vi.fn<[string], LoadedGif | null>(),
};

vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderGif } = await import("./gif");

type Rgb = [number, number, number];

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];

type FrameSpec = {
  color: Rgb;
  delay: number;
  /** Defaults to the whole picture. */
  rect?: GifFrameInfo["rect"];
  disposal?: number;
};

/** A decoded GIF built by hand, in the shape `decodeGif` hands the store. */
function loaded(specs: FrameSpec[], width = 8, height = 8): LoadedGif {
  const frames = specs.map((spec) => ({
    rect: spec.rect ?? { left: 0, top: 0, width, height },
    disposal: spec.disposal ?? 1,
  }));
  const patches = specs.map((spec, i) => {
    const { width: w, height: h } = frames[i].rect;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${spec.color.join(",")})`;
    ctx.fillRect(0, 0, w, h);
    return canvas as unknown as LoadedGif["patches"][number];
  });
  return {
    width,
    height,
    frames,
    patches,
    timing: gifTiming(specs.map((spec) => spec.delay)),
  };
}

function threeFrames(delay = 100) {
  return loaded([
    { color: RED, delay },
    { color: GREEN, delay },
    { color: BLUE, delay },
  ]);
}

beforeEach(() => {
  store.getGif.mockReset();
});

describe("renderGif", () => {
  it("stretches the picture over the element's local box", () => {
    store.getGif.mockReturnValue(threeFrames());
    const el = gifElement({ width: 80, height: 60 });

    const { canvas, ctx } = scene(100, 100, "#000000");
    renderGif(ctx, "g", el, 0);

    expect(pixel(canvas, 1, 1)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 78, 58)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 82, 58)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("holds each frame for its own delay, not the first frame's", () => {
    store.getGif.mockReturnValue(
      loaded([
        { color: RED, delay: 100 },
        { color: GREEN, delay: 300 },
        { color: BLUE, delay: 50 },
      ]),
    );
    const el = gifElement({ startTime: 0, width: 50, height: 50 });

    const at = (cursor: number) => {
      const { canvas, ctx } = scene(60, 60, "#000000");
      renderGif(ctx, "g", el, cursor);
      return pixel(canvas, 25, 25);
    };

    expect(at(0)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(at(99)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(at(100)).toMatchObject({ r: 0, g: 255, b: 0 });
    // With one delay for all three, 250 would already be blue.
    expect(at(250)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(at(399)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(at(400)).toMatchObject({ r: 0, g: 0, b: 255 });
    // The loop is 450ms long.
    expect(at(450)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("draws a frame near the end of the loop before the clip starts", () => {
    // A transition draws its incoming clip early. That used to be a negative
    // index and a throw out of the paint.
    store.getGif.mockReturnValue(threeFrames(100));
    const el = gifElement({ startTime: 1000, width: 50, height: 50 });

    const { canvas, ctx } = scene(60, 60, "#000000");
    expect(() => renderGif(ctx, "g", el, 990)).not.toThrow();
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("starts from the first frame wherever the clip sits on the timeline", () => {
    store.getGif.mockReturnValue(threeFrames(100));
    const late = gifElement({ startTime: 5000, width: 50, height: 50 });

    const { canvas, ctx } = scene(60, 60, "#000000");
    renderGif(ctx, "g", late, 5000);
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });

    const next = scene(60, 60, "#000000");
    renderGif(next.ctx, "g", late, 5100);
    expect(pixel(next.canvas, 25, 25)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("looks the GIF up by its path", () => {
    store.getGif.mockReturnValue(threeFrames());
    const { ctx } = scene(60, 60);
    renderGif(ctx, "g", gifElement({ localpath: "/assets/loop.gif" }), 0);
    expect(store.getGif).toHaveBeenCalledWith("/assets/loop.gif");
  });

  it("draws nothing while the GIF is still decoding", () => {
    store.getGif.mockReturnValue(null);
    const { canvas, ctx } = scene(60, 60, "#000000");
    expect(() => renderGif(ctx, "g", gifElement(), 0)).not.toThrow();
    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("lays a partial frame at its offset, over the frame before it", () => {
    // An optimised GIF stores only what changed. Stretching that patch over
    // the whole box is what made a GIF jump and squash.
    store.getGif.mockReturnValue(
      loaded([
        { color: RED, delay: 100 },
        { color: GREEN, delay: 100, rect: { left: 4, top: 4, width: 4, height: 4 } },
      ]),
    );
    const el = gifElement({ startTime: 0, width: 80, height: 80 });

    const { canvas, ctx } = scene(100, 100, "#000000");
    renderGif(ctx, "g", el, 100);
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 60, 60)).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("keeps two GIFs on screen apart, even at different frame indices", () => {
    const slow = loaded([
      { color: RED, delay: 100 },
      { color: GREEN, delay: 100 },
    ], 16, 16);
    const fast = loaded([
      { color: BLUE, delay: 50 },
      { color: GREEN, delay: 50 },
    ], 4, 4);
    store.getGif.mockImplementation((p: string) => (p === "/slow.gif" ? slow : fast));

    const a = gifElement({ localpath: "/slow.gif", width: 50, height: 50 });
    const b = gifElement({ localpath: "/fast.gif", width: 50, height: 50 });

    const first = scene(60, 60, "#000000");
    renderGif(first.ctx, "a", a, 0);
    expect(pixel(first.canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });

    const second = scene(60, 60, "#000000");
    renderGif(second.ctx, "b", b, 0);
    expect(pixel(second.canvas, 25, 25)).toMatchObject({ r: 0, g: 0, b: 255 });

    const third = scene(60, 60, "#000000");
    renderGif(third.ctx, "a", a, 0);
    expect(pixel(third.canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
  });
});

// ------------------------------------------------------------------ parity

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** The bundled binary for this machine, by the rule `electron/lib/ffmpeg.ts` uses. */
function ffmpegPath(): string | null {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join(
    REPO_ROOT,
    "bin",
    dir,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(binary) ? binary : null;
}

const FFMPEG = ffmpegPath();

/**
 * Two GIFs ffmpeg's own encoder writes, each built to exercise one half of
 * the compositing rule:
 *
 * - `transparent`: a square moving over nothing. Every frame is a patch, and
 *   every disposal is 2, so the square leaves no trail only if the previous
 *   frame's rectangle is cleared.
 * - `opaque`: ffmpeg's test pattern. After the first frame each one is a
 *   small patch with transparent pixels where nothing changed (disposal 1),
 *   so it is right only if the patch is drawn over what is there.
 */
const FIXTURES = {
  transparent:
    "color=c=black@0.0:s=64x48:r=10:d=1,format=rgba[bg];" +
    "color=c=red:s=12x12:r=10:d=1,format=rgba[sq];" +
    "[bg][sq]overlay=x='t*40':y='5+t*20':format=auto,split[a][b];" +
    "[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
  opaque: "testsrc2=s=64x48:r=10:d=1",
} as const;

describe.skipIf(FFMPEG == null)("renderGif against ffmpeg's own decoder", () => {
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartcut-gif-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(name: keyof typeof FIXTURES): { file: string; decoded: LoadedGif } {
    const file = path.join(dir, `${name}.gif`);
    execFileSync(FFMPEG as string, [
      "-v", "error", "-y", "-f", "lavfi", "-i", FIXTURES[name], "-loop", "0", file,
    ]);
    const bytes = fs.readFileSync(file);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { file, decoded: decodeGif(buffer as ArrayBuffer) };
  }

  /** ffmpeg's picture for every frame, as RGBA, one output frame per GIF frame. */
  function ffmpegFrames(file: string, width: number, height: number): Uint8Array[] {
    const raw = execFileSync(
      FFMPEG as string,
      ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const size = width * height * 4;
    const frames: Uint8Array[] = [];
    for (let at = 0; at + size <= raw.length; at += size) {
      frames.push(new Uint8Array(raw.buffer, raw.byteOffset + at, size));
    }
    return frames;
  }

  /** How many pixels differ: alpha always, colour only where both are opaque. */
  function differences(ours: Uint8ClampedArray, theirs: Uint8Array): number {
    let count = 0;
    for (let i = 0; i < ours.length; i += 4) {
      if (ours[i + 3] !== theirs[i + 3]) {
        count++;
      } else if (
        ours[i + 3] === 255 &&
        (ours[i] !== theirs[i] || ours[i + 1] !== theirs[i + 1] || ours[i + 2] !== theirs[i + 2])
      ) {
        count++;
      }
    }
    return count;
  }

  function ourFrame(decoded: LoadedGif, index: number): Uint8ClampedArray {
    store.getGif.mockReturnValue(decoded);
    const { width, height } = decoded;
    const { ctx } = scene(width, height);
    renderGif(ctx, "parity", gifElement({ startTime: 0, width, height }), decoded.timing.starts[index]);
    return ctx.getImageData(0, 0, width, height).data;
  }

  /** What the renderer used to do: each patch stretched over the whole picture. */
  function stretchedFrame(decoded: LoadedGif, index: number): Uint8ClampedArray {
    const { width, height } = decoded;
    const { ctx } = scene(width, height);
    const patch = decoded.patches[index];
    if (patch != null) {
      ctx.drawImage(patch, 0, 0, width, height);
    }
    return ctx.getImageData(0, 0, width, height).data;
  }

  for (const name of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
    it(`matches ffmpeg on every frame of the ${name} fixture`, () => {
      const { file, decoded } = make(name);
      const theirs = ffmpegFrames(file, decoded.width, decoded.height);

      // The fixture has to be the kind of GIF the old renderer got wrong, or
      // agreeing with ffmpeg proves nothing.
      expect(theirs.length).toBe(decoded.frames.length);
      const partial = decoded.frames.filter(
        (frame) => frame.rect.width !== decoded.width || frame.rect.height !== decoded.height,
      );
      expect(partial.length).toBeGreaterThan(decoded.frames.length / 2);
      const stretchedWrong = theirs.some(
        (frame, index) => differences(stretchedFrame(decoded, index), frame) > 0,
      );
      expect(stretchedWrong).toBe(true);

      // Forward, as playback and an export walk it.
      for (let index = 0; index < theirs.length; index++) {
        expect({ index, differ: differences(ourFrame(decoded, index), theirs[index]) }).toEqual({
          index,
          differ: 0,
        });
      }
      // And backward, as a scrub does, which rebuilds from the first frame.
      for (let index = theirs.length - 1; index >= 0; index--) {
        expect({ index, differ: differences(ourFrame(decoded, index), theirs[index]) }).toEqual({
          index,
          differ: 0,
        });
      }
    });
  }
});
