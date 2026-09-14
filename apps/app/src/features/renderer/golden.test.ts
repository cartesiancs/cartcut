import { describe, it, expect, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type { Timeline, VisualTimelineElement } from "../../@types/timeline";
import {
  solid,
  points,
  imageElement,
  shapeElement,
  audioElement,
  inactiveAnimation,
} from "./testing";

const store = { getImage: () => solid(60, 60, "#ff4400") };
vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderTimelineAtTime } = await import("./timeline");
const { renderImage } = await import("./image");
const { renderShape } = await import("./shape");
const { normalizeShapeGeometry } = await import("../shape/shapeGeometry");
const { flattenOutline } = await import("../shape/shapeOutline");

/**
 * Golden frames — the regression net for the renderer.
 *
 * A fixed scene is composited at several timecodes and each frame's pixels are
 * reduced to a stable digest. A changed digest means the picture changed: fine
 * when that is the point of the commit (re-baseline in the same change, and say
 * why), a bug when it happens during a refactor that was supposed to preserve
 * output.
 *
 * Text is deliberately absent — its metrics come from whichever font the host
 * resolves, which would make the digest differ between machines. `text.test.ts`
 * covers it with font-independent assertions instead. The digest does depend on
 * the pinned `@napi-rs/canvas`, so a Skia bump is a legitimate re-baseline.
 */

const SIZE = 240;

const renderers = {
  image: renderImage,
  shape: renderShape,
  video: () => {},
  gif: () => {},
  text: () => {},
} as unknown as Parameters<typeof renderTimelineAtTime>[3];

function timeline(): Timeline {
  return {
    backdrop: imageElement({
      priority: 1,
      startTime: 0,
      duration: 4000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
    }),
    // drifts right and fades out across the clip
    flyer: imageElement({
      priority: 2,
      startTime: 0,
      duration: 4000,
      location: { x: 20, y: 20 },
      width: 60,
      height: 60,
      rotation: 15,
      animation: {
        ...inactiveAnimation(),
        opacity: {
          isActivate: true,
          x: [],
          ax: points([0, 100], [2000, 50], [4000, 0]),
        },
        position: {
          isActivate: true,
          x: [],
          y: [],
          ax: points([0, 20], [2000, 120], [4000, 20]),
          ay: points([0, 20], [4000, 20]),
        },
      },
    }),
    // grows about its centre
    badge: shapeElement({
      priority: 3,
      startTime: 0,
      duration: 4000,
      location: { x: 90, y: 90 },
      width: 60,
      height: 60,
      // Both axes, or `renderShape` scales y by the fixture's default
      // `oHeight: 100` and the triangle squashes. A shape drawn at its authored
      // size states both.
      oWidth: 60,
      oHeight: 60,
      rotation: 30,
      option: { fillColor: "#ffcc00" },
      shape: [
        [0, 0],
        [60, 0],
        [30, 60],
      ],
      animation: {
        opacity: { isActivate: true, x: [], ax: points([0, 100], [4000, 30]) },
      },
    }),
    // never visible in the sampled window; guards the visibility filter
    late: imageElement({
      priority: 4,
      startTime: 9000,
      duration: 1000,
      location: { x: 0, y: 0 },
      width: SIZE,
      height: SIZE,
    }),
    // audio must never reach the canvas
    music: audioElement({ priority: 5, startTime: 0, duration: 4000 }),
  };
}

/** FNV-1a over the RGBA buffer — stable across platforms, unlike a PNG blob. */
function digest(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * One composited frame's raw pixels.
 *
 * Split out of `frameDigest` for the cases that have to compare two frames
 * *quantitatively* rather than by digest: a digest says only same or different,
 * and antialiasing differences of a few channels need a measurement.
 */
function frameData(timeInMs: number, scene: Timeline = timeline()): Uint8ClampedArray {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  renderTimelineAtTime(
    ctx,
    scene,
    timeInMs,
    renderers,
    "#101020",
    SIZE,
    SIZE,
  );
  return canvas.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
}

function frameDigest(timeInMs: number, scene: Timeline = timeline()): string {
  return digest(frameData(timeInMs, scene));
}

/**
 * The same scene with a blend mode on each layer.
 *
 * A separate scene rather than blends added to `timeline()`, deliberately: the
 * digests above are the proof that introducing blend modes changed nothing for
 * a project that does not use them, and folding blends into that scene would
 * throw that proof away.
 */
function blendedTimeline(): Timeline {
  const base = timeline();
  return {
    ...base,
    flyer: { ...base.flyer, blend: "screen" },
    badge: { ...base.badge, blend: "multiply" },
  } as Timeline;
}

describe("golden frames", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [t, frameDigest(t)]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic — the same timecode digests identically", () => {
    expect(frameDigest(2000)).toBe(frameDigest(2000));
  });

  it("actually changes between timecodes, so the digest is not a constant", () => {
    expect(frameDigest(0)).not.toBe(frameDigest(2000));
  });

  it("draws exactly the elements that are on screen", () => {
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const drawn: string[] = [];

    renderTimelineAtTime(
      ctx,
      timeline(),
      2000,
      renderers,
      "#101020",
      SIZE,
      SIZE,
      undefined,
      (id: string, _el: VisualTimelineElement) => drawn.push(id),
    );

    expect(drawn).toEqual(["backdrop", "flyer", "badge"]);
  });
});

describe("golden frames — blended", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [
        t,
        frameDigest(t, blendedTimeline()),
      ]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic — the same timecode digests identically", () => {
    expect(frameDigest(2000, blendedTimeline())).toBe(
      frameDigest(2000, blendedTimeline()),
    );
  });

  // Without this the snapshot above could be pinning a scene in which the blend
  // fields were silently ignored, and would keep passing if they ever were.
  it("differs from the same scene composited normally", () => {
    for (const t of [0, 1000, 2000, 3000]) {
      expect(frameDigest(t, blendedTimeline())).not.toBe(frameDigest(t));
    }
  });
});

/**
 * The same scene with colour adjustments on two clips — tone on one, finish
 * and tone together on the other — kept apart from the plain scene for the
 * reason the blended one is: the plain digests are the proof that an
 * unadjusted project renders exactly as it did before the feature.
 *
 * Grain is left out: it is deterministic, but a digest over it would pin the
 * hash's every bit, and `adjustComposite.test.ts` covers it statistically.
 */
function adjustedTimeline(): Timeline {
  const base = timeline();
  return {
    ...base,
    flyer: { ...base.flyer, adjust: { exposure: 30, temperature: -40, contrast: 25 } },
    badge: { ...base.badge, adjust: { saturation: -60, fade: 35, vignette: 50, sharpen: 60 } },
  } as Timeline;
}

describe("golden frames — adjusted", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [
        t,
        frameDigest(t, adjustedTimeline()),
      ]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic — the same timecode digests identically", () => {
    expect(frameDigest(2000, adjustedTimeline())).toBe(
      frameDigest(2000, adjustedTimeline()),
    );
  });

  it("differs from the same scene composited without adjustments", () => {
    for (const t of [0, 1000, 2000, 3000]) {
      expect(frameDigest(t, adjustedTimeline())).not.toBe(frameDigest(t));
    }
  });
});

/**
 * The same scene with a static `scale` on two clips, kept apart from the plain
 * one for the reason the blended and adjusted scenes are: the plain digests are
 * the proof that a project nobody has scaled renders exactly as it did before
 * `Visual.scale` existed.
 *
 * What it pins that no unit test can: the field reaches the picture at all. It
 * does so through `localMatrixOf`, which is why it needed no change in any
 * renderer, and which is also why a mistake here would be invisible until
 * someone looked at a frame.
 */
function scaledTimeline(): Timeline {
  const base = timeline();
  return {
    ...base,
    flyer: { ...base.flyer, scale: 15 },
    badge: { ...base.badge, scale: 6 },
  } as Timeline;
}

describe("golden frames, scaled", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [
        t,
        frameDigest(t, scaledTimeline()),
      ]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic: the same timecode digests identically", () => {
    expect(frameDigest(2000, scaledTimeline())).toBe(
      frameDigest(2000, scaledTimeline()),
    );
  });

  it("differs from the same scene composited unscaled", () => {
    for (const t of [0, 1000, 2000, 3000]) {
      expect(frameDigest(t, scaledTimeline())).not.toBe(frameDigest(t));
    }
  });

  // Absent and 10 have to be the same picture as well as the same bytes on
  // disk, or `scaleOps` deleting the key at neutral would be a visible change.
  it("renders a neutral scale identically to no scale at all", () => {
    const base = timeline();
    const explicit = {
      ...base,
      flyer: { ...base.flyer, scale: 10 },
      badge: { ...base.badge, scale: 10 },
    } as Timeline;
    for (const t of [0, 1000, 2000, 3000]) {
      expect(frameDigest(t, explicit)).toBe(frameDigest(t));
    }
  });
});

/**
 * The same scene with a **shape recipe** on the badge.
 *
 * The badge is the fixture's shape, and it is a triangle drawn from a stored
 * point list, so this feature's blast radius already runs through the plain
 * digests above. Those digests not moving is the proof that a project nobody
 * has parameterised renders exactly as it did before recipes existed; this
 * block is the other half, and pins that a recipe reaches the picture at all.
 *
 * It reaches it through one branch in `renderShape` and through nothing else,
 * which is why a mistake here would be invisible until someone looked at a
 * frame.
 */
/** The points a default `polygon` recipe generates in the badge's own box. */
const DEFAULT_TRIANGLE = flattenOutline(normalizeShapeGeometry("polygon", {}), {
  width: 60,
  height: 60,
});

function shapedTimeline(
  shape?: number[][],
  geometry: Record<string, unknown> | null = { kind: "star", count: 6, radius: 4 },
): Timeline {
  const base = timeline();
  return {
    ...base,
    badge: {
      ...base.badge,
      ...(shape == null ? {} : { shape }),
      ...(geometry == null ? {} : { geometry }),
    },
  } as Timeline;
}

describe("golden frames, with a shape recipe", () => {
  it("composites a stable frame at each sampled timecode", () => {
    const frames = Object.fromEntries(
      [0, 1000, 2000, 3000, 3999].map((t) => [
        t,
        frameDigest(t, shapedTimeline()),
      ]),
    );
    expect(frames).toMatchSnapshot();
  });

  it("is deterministic: the same timecode digests identically", () => {
    expect(frameDigest(2000, shapedTimeline())).toBe(
      frameDigest(2000, shapedTimeline()),
    );
  });

  it("differs from the same scene composited from the stored points", () => {
    for (const t of [0, 1000, 2000, 3000]) {
      expect(frameDigest(t, shapedTimeline())).not.toBe(frameDigest(t));
    }
  });

  /**
   * The byte-identity claim, as a picture.
   *
   * `shapeOps` deletes the `geometry` key rather than storing a default, and
   * that is only invisible if a default recipe also *draws* what the shape drew
   * without one. So this scene's badge holds the very points a default polygon
   * generates, and the two are composited with the key and without it.
   *
   * It cannot be a digest match. Every edge in the recipe path is a cubic,
   * including a straight one, and Skia shades a degenerate cubic a fraction
   * differently from a line, which shows along the badge's three edges once it
   * is rotated 30 degrees. The bound that carries the claim is the first one:
   * **no channel moves by more than half.** Antialiasing along an edge cannot
   * do that; a shape drawn in the wrong place, at the wrong size or the wrong
   * way up can hardly avoid it. Measured against the fixture's own hand-drawn
   * triangle, which points the other way, that count is over three thousand.
   */
  it("renders a default recipe as the shape its own point list draws", () => {
    // `null`, not `undefined`: a default parameter fires on `undefined`, so
    // passing that here asks for no recipe and silently gets the star above.
    // The first draft did exactly that and compared a star with a triangle.
    const asPoints = shapedTimeline(DEFAULT_TRIANGLE, null);
    const asRecipe = shapedTimeline(DEFAULT_TRIANGLE, { kind: "polygon" });

    for (const t of [0, 1000, 2000, 3000]) {
      const a = frameData(t, asPoints);
      const b = frameData(t, asRecipe);
      let differing = 0;
      let worst = 0;
      let solid = 0;
      for (let i = 0; i < a.length; i++) {
        const delta = Math.abs(a[i] - b[i]);
        if (delta > 0) {
          differing++;
          worst = Math.max(worst, delta);
        }
        if (delta > 128) {
          solid++;
        }
      }
      expect(solid, `t=${t}: a channel moved by more than half`).toBe(0);
      expect(differing, `t=${t}`).toBeLessThan(1200);
      expect(worst, `t=${t}`).toBeLessThan(60);
    }
  });
});
