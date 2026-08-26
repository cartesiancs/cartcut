/**
 * The sample frames have a job, and these assert they can do it.
 *
 * Not "does it look nice" — that is not testable and not the point. The point
 * is that each feature a preset class keys off is actually present, because a
 * subject missing one makes a whole family of presets preview as a no-op. A
 * bloom over a subject with no blown highlight looks broken; a blur over a
 * subject with no fine detail looks like nothing happened.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  __clearSampleFrameCache,
  drawSampleFrame,
  sampleFrameCanvas,
} from "./sampleFrames";
import { scene } from "../renderer/testing";
import { createCanvas } from "@napi-rs/canvas";

const W = 192;
const H = 108;

function frame(kind: "a" | "b") {
  const { ctx, canvas } = scene(W, H);
  drawSampleFrame(ctx, kind, W, H);
  return canvas;
}

function pixels(canvas: any): Uint8ClampedArray {
  return canvas.getContext("2d").getImageData(0, 0, W, H).data;
}

function luma(d: Uint8ClampedArray, i: number): number {
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}

beforeEach(() => {
  __clearSampleFrameCache();
});

describe("the two frames are genuinely different", () => {
  it("differ over most of their area", () => {
    // A dissolve, a wipe and a slide all read as "A became B". If A and B were
    // close, none of those would be distinguishable from each other.
    const a = pixels(frame("a"));
    const b = pixels(frame("b"));

    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      if (dr + dg + db > 60) differing++;
    }
    expect(differing / (a.length / 4)).toBeGreaterThan(0.8);
  });

  it("differ in hue, not only in brightness", () => {
    // Warm versus cool. Two frames that differed only in luminance would make
    // every colour-grading preset preview identically.
    const a = pixels(frame("a"));
    const b = pixels(frame("b"));
    let aWarm = 0;
    let bCool = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] > a[i + 2]) aWarm++;
      if (b[i + 2] > b[i]) bCool++;
    }
    expect(aWarm / (a.length / 4)).toBeGreaterThan(0.7);
    expect(bCool / (b.length / 4)).toBeGreaterThan(0.7);
  });

  it("differ in silhouette, so they survive a black-and-white preset", () => {
    // A carries a circle and B a square, in the same region. Convert both to
    // luma and the shapes still tell them apart.
    const a = pixels(frame("a"));
    const b = pixels(frame("b"));
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(luma(a, i) - luma(b, i)) > 40) differing++;
    }
    expect(differing / (a.length / 4)).toBeGreaterThan(0.3);
  });
});

describe("each frame carries what the presets need", () => {
  for (const kind of ["a", "b"] as const) {
    describe("frame " + kind, () => {
      it("reaches near-white somewhere, for bloom and halation", () => {
        const d = pixels(frame(kind));
        let brightest = 0;
        for (let i = 0; i < d.length; i += 4) {
          brightest = Math.max(brightest, luma(d, i));
        }
        expect(brightest).toBeGreaterThan(235);
      });

      it("reaches near-black somewhere, for contrast and levels", () => {
        const d = pixels(frame(kind));
        let darkest = 255;
        for (let i = 0; i < d.length; i += 4) {
          darkest = Math.min(darkest, luma(d, i));
        }
        expect(darkest).toBeLessThan(45);
      });

      it("has fine detail, so blur and sharpen visibly do something", () => {
        // Count horizontally adjacent pairs that jump hard. A smooth subject
        // has almost none, and a blur over it looks like a no-op.
        const d = pixels(frame(kind));
        let jumps = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W - 1; x++) {
            const i = (y * W + x) * 4;
            if (Math.abs(luma(d, i) - luma(d, i + 4)) > 60) jumps++;
          }
        }
        expect(jumps).toBeGreaterThan(200);
      });

      it("has a smooth ramp, so posterize and banding are visible", () => {
        // Distinct luma buckets across the frame: a subject made only of flat
        // areas would posterize to itself.
        const d = pixels(frame(kind));
        const buckets = new Set<number>();
        for (let i = 0; i < d.length; i += 4) {
          buckets.add(Math.round(luma(d, i) / 8));
        }
        expect(buckets.size).toBeGreaterThan(14);
      });

      it("is fully opaque", () => {
        // The compositor uploads these as textures; a stray transparent pixel
        // would blend the clear colour into a preview and read as a bug in the
        // preset rather than in the subject.
        const d = pixels(frame(kind));
        for (let i = 3; i < d.length; i += 4) {
          expect(d[i]).toBe(255);
        }
      });
    });
  }
});

describe("sampleFrameCanvas", () => {
  /** A Skia canvas, standing in for the DOM one the app supplies. */
  const factory = () => createCanvas(1, 1) as unknown as HTMLCanvasElement;

  it("returns the same canvas for the same request", () => {
    // Redrawn for every tile otherwise, and they never change.
    const first = sampleFrameCanvas("a", W, H, factory);
    expect(first).not.toBeNull();
    expect(sampleFrameCanvas("a", W, H, factory)).toBe(first);
  });

  it("keys on size, so a different tile size gets its own", () => {
    const small = sampleFrameCanvas("a", W, H, factory);
    const large = sampleFrameCanvas("a", W * 2, H * 2, factory);
    expect(large).not.toBe(small);
    expect(large?.width).toBe(W * 2);
  });

  it("keys on kind", () => {
    expect(sampleFrameCanvas("a", W, H, factory)).not.toBe(
      sampleFrameCanvas("b", W, H, factory),
    );
  });

  it("returns null rather than throwing where there is no DOM", () => {
    // The headless render window and the node suites both hit this.
    expect(
      sampleFrameCanvas("a", W, H, () => {
        throw new Error("no document");
      }),
    ).toBeNull();
  });
});
