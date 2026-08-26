/**
 * The two pictures every preset preview is drawn on.
 *
 * Drawn rather than shipped. Nothing in `assets/` is a usable subject — the
 * only bitmaps are app screenshots and icons, and a wipe across a flat dark
 * screenshot of an editor UI is invisible. Generating them costs no bytes, no
 * loading and no licence, and it means the subject can be **designed for the
 * job** rather than found.
 *
 * The job is specific. A tile has to answer "what does this preset do?" at
 * 192×108, for seventy different presets, at a glance. So each frame carries
 * one feature per class of effect, and none of them is decoration:
 *
 * | feature | what it makes visible |
 * |---|---|
 * | two unmistakably different frames | dissolve, wipe, slide — the whole point is A becoming B |
 * | a smooth gradient | posterize, threshold, banding, colour grading |
 * | a fine checker patch | blur, sharpen, pixelate — anything that trades detail |
 * | a blown highlight | bloom, halation, vignette, exposure |
 * | a hard diagonal | edge detect, chromatic aberration, lens distortion |
 * | saturated primaries | saturation, duotone, channel mixing, invert |
 *
 * A is warm and left-weighted, B is cool and right-weighted, so a wipe or a
 * slide reads as direction and not merely as change.
 *
 * Pure: hand it a context and a size and it draws. That is what lets the pixel
 * assertions in `sampleFrames.test.ts` run on a Skia canvas under
 * `environment: "node"`.
 */

/** Which of the two sample pictures to draw. */
export type SampleFrameKind = "a" | "b";

type Palette = {
  /** Background gradient, corner to corner. */
  from: string;
  to: string;
  /** The saturated shape. */
  shape: string;
  /** The blown highlight. */
  highlight: string;
  /** The hard diagonal band. */
  band: string;
};

const PALETTES: Record<SampleFrameKind, Palette> = {
  // Warm, weighted to the left.
  a: {
    from: "#2b1608",
    to: "#e2622a",
    shape: "#ffc02e",
    highlight: "#fff6e2",
    band: "#7d1f12",
  },
  // Cool, weighted to the right. Deliberately far from A in hue *and* in
  // layout — a dissolve between two frames that differ only in tint reads as
  // a colour shift rather than as a dissolve.
  b: {
    from: "#04202c",
    to: "#2ea6c8",
    shape: "#5de0b0",
    highlight: "#eafcff",
    band: "#0b3a5e",
  },
};

/**
 * Draw one sample frame, filling the context.
 *
 * Every coordinate is a fraction of the size, so the same picture composes at
 * a 192×108 tile and at whatever else asks for it.
 */
export function drawSampleFrame(
  ctx: CanvasRenderingContext2D,
  kind: SampleFrameKind,
  width: number,
  height: number,
): void {
  const p = PALETTES[kind];
  const mirrored = kind === "b";
  /** x as a fraction, mirrored for B so the two frames are not the same shape. */
  const fx = (t: number) => (mirrored ? 1 - t : t) * width;
  const fy = (t: number) => t * height;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 1. The gradient. Corner to corner rather than vertical, so a linear wipe in
  //    any direction crosses a changing value and cannot hide in a flat area.
  const gradient = ctx.createLinearGradient(
    fx(0),
    0,
    fx(1),
    height,
  );
  gradient.addColorStop(0, p.from);
  gradient.addColorStop(1, p.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // 2. The hard diagonal. An edge with no anti-aliased ramp on either side,
  //    which is what edge detection and chromatic aberration key off.
  ctx.fillStyle = p.band;
  ctx.beginPath();
  ctx.moveTo(fx(0.0), fy(1.0));
  ctx.lineTo(fx(0.55), fy(0.0));
  ctx.lineTo(fx(0.78), fy(0.0));
  ctx.lineTo(fx(0.23), fy(1.0));
  ctx.closePath();
  ctx.fill();

  // 3. The saturated shape. A circle for A and a square for B: at a glance the
  //    silhouette says which frame you are looking at, even in greyscale, which
  //    matters once a black-and-white preset is applied to it.
  ctx.fillStyle = p.shape;
  if (kind === "a") {
    ctx.beginPath();
    ctx.arc(fx(0.34), fy(0.52), Math.min(width, height) * 0.22, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const s = Math.min(width, height) * 0.38;
    ctx.fillRect(fx(0.34) - s / 2, fy(0.52) - s / 2, s, s);
  }

  // 4. The checker patch. Cells sized off the height so they stay a few pixels
  //    at tile scale — fine enough that a blur visibly destroys them and a
  //    sharpen visibly bites, which is the only way those two read at 192×108.
  const cell = Math.max(2, Math.round(height / 18));
  const patchW = cell * 6;
  const px = fx(mirrored ? 0.86 : 0.72) - patchW / 2;
  const py = fy(0.74);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      if ((row + col) % 2 === 1) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(px + col * cell, py + row * cell, cell, cell);
    }
  }

  // 5. The blown highlight, last so nothing covers it. A soft radial core that
  //    actually reaches white — bloom and halation threshold on luminance, and
  //    a subject whose brightest pixel is 70% grey makes them look broken.
  const hx = fx(0.7);
  const hy = fy(0.26);
  const radius = Math.min(width, height) * 0.3;
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
  glow.addColorStop(0, p.highlight);
  glow.addColorStop(0.35, p.highlight);
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(hx, hy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Both frames as canvases, made once and kept.
 *
 * Cached because a preview provider redraws them for every tile it renders and
 * they never change. Keyed by size so a request at a different tile size does
 * not silently get the wrong one.
 */
const cache = new Map<string, HTMLCanvasElement>();

/**
 * How a canvas is obtained.
 *
 * A parameter so the cache can be tested. `document.createElement` is not
 * available under `environment: "node"`, and without this the size- and
 * kind-keying — a wrong-sized frame is a real bug — could only be checked by
 * running the app.
 */
export type CanvasFactory = () => HTMLCanvasElement;

const domCanvas: CanvasFactory = () => document.createElement("canvas");

export function sampleFrameCanvas(
  kind: SampleFrameKind,
  width: number,
  height: number,
  createCanvas: CanvasFactory = domCanvas,
): HTMLCanvasElement | null {
  const key = kind + "|" + width + "|" + height;
  const cached = cache.get(key);
  if (cached != null) {
    return cached;
  }

  let canvas: HTMLCanvasElement;
  try {
    canvas = createCanvas();
  } catch {
    // No DOM — a headless render window, a unit test. The caller draws nothing
    // rather than taking the paint loop down.
    return null;
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx == null) {
    return null;
  }
  drawSampleFrame(ctx, kind, width, height);
  cache.set(key, canvas);
  return canvas;
}

/** For tests, and for a render window tearing itself down. */
export function __clearSampleFrameCache(): void {
  cache.clear();
}
