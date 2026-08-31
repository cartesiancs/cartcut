import { describe, it, expect, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderElement } from "./element";
import { resetLayers, setSurfaceFactory, type Surface } from "./surface";
import { imageElement, pixel, points, scene, inactiveAnimation } from "./testing";
import type { BlendMode, ImageElementType } from "../../@types/timeline";

/**
 * What a blend mode actually does to pixels, through `renderElement`.
 *
 * The arithmetic is asserted rather than snapshotted: every separable mode has
 * a closed form, and a fully saturated source over a fully saturated backdrop
 * lands on an exact byte. That makes a wrong mode — or a mode silently ignored
 * because the string was mistyped — a failure with a number in it, instead of a
 * changed digest that has to be eyeballed.
 *
 * `testing.ts` installs the Skia surface factory on import, so these run
 * through the same isolation path the app takes.
 */

const skiaFactory = (width: number, height: number): Surface => {
  const canvas = createCanvas(width, height);
  return {
    canvas: canvas as unknown as Surface["canvas"],
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
};

afterEach(() => {
  setSurfaceFactory(skiaFactory);
  resetLayers();
});

/** A renderer that fills the element's local box with one colour. */
const fillBox =
  (color: string) =>
  (
    ctx: CanvasRenderingContext2D,
    _id: string,
    element: ImageElementType,
  ): void => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

/**
 * A renderer whose two draws overlap — the shape of every real multi-primitive
 * renderer, and what isolation exists to get right. `renderText` paints a
 * background box, a glow, a shadow, an outline stroke and a fill this way.
 */
const fillBoxTwice =
  (color: string) =>
  (
    ctx: CanvasRenderingContext2D,
    _id: string,
    element: ImageElementType,
  ): void => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
    ctx.fillRect(0, 0, element.width, element.height);
  };

/** Draw one full-canvas element with `blend` over a solid backdrop. */
function composite(
  blend: BlendMode | undefined,
  source: string,
  backdrop: string,
  render = fillBox(source),
  size = 40,
) {
  const { canvas, ctx } = scene(size, size, backdrop);
  const element = imageElement({
    location: { x: 0, y: 0 },
    width: size,
    height: size,
    ...(blend == null ? {} : { blend }),
  });
  renderElement(ctx, "el", element, 0, false, render);
  return { canvas, ctx };
}

/** The composited colour at the centre. */
function centre(blend: BlendMode | undefined, source: string, backdrop: string) {
  const { canvas } = composite(blend, source, backdrop);
  return pixel(canvas, 20, 20);
}

describe("separable blend modes — exact arithmetic", () => {
  it("multiply: source × backdrop", () => {
    // The CapCut effect the feature was asked for: white lets the source
    // through, black holds it out. That is what puts a video inside white
    // lettering on a black card.
    expect(centre("multiply", "#ff0000", "#ffffff")).toMatchObject({
      r: 255,
      g: 0,
      b: 0,
    });
    expect(centre("multiply", "#ff0000", "#000000")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
    // 255 × 128 / 255 = 128
    expect(centre("multiply", "#ff0000", "#808080")).toMatchObject({
      r: 128,
      g: 0,
      b: 0,
    });
  });

  it("screen: the inverse of multiplying the complements", () => {
    expect(centre("screen", "#ff0000", "#000000")).toMatchObject({
      r: 255,
      g: 0,
      b: 0,
    });
    expect(centre("screen", "#ff0000", "#ffffff")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    // 255 - (255-255)(255-128)/255 = 255 on red; 255 - (255-0)(255-128)/255 = 128
    expect(centre("screen", "#ff0000", "#808080")).toMatchObject({
      r: 255,
      g: 128,
      b: 128,
    });
  });

  it("darken: the lower of the two, per channel", () => {
    expect(centre("darken", "#ff8000", "#00ff80")).toMatchObject({
      r: 0,
      g: 128,
      b: 0,
    });
  });

  it("lighten: the higher of the two, per channel", () => {
    expect(centre("lighten", "#ff8000", "#00ff80")).toMatchObject({
      r: 255,
      g: 255,
      b: 128,
    });
  });

  it("difference: the absolute difference, per channel", () => {
    expect(centre("difference", "#ff0000", "#ffffff")).toMatchObject({
      r: 0,
      g: 255,
      b: 255,
    });
    expect(centre("difference", "#ffffff", "#ffffff")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
  });

  it("exclusion: a softer difference that leaves mid grey alone", () => {
    expect(centre("exclusion", "#ffffff", "#ffffff")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
    // s + b - 2sb with s = 1, b = 0 → 1
    expect(centre("exclusion", "#ffffff", "#000000")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("overlay: multiply under mid grey, screen above it", () => {
    // Backdrop black is in the multiply half → black; white is in the screen
    // half → white. Overlay keeps the backdrop's extremes whatever the source.
    expect(centre("overlay", "#808080", "#000000")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
    expect(centre("overlay", "#808080", "#ffffff")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("hard-light: overlay with the roles swapped", () => {
    // Now it is the *source* that decides which half, so a black source drives
    // the result to black regardless of the backdrop.
    expect(centre("hard-light", "#000000", "#808080")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
    expect(centre("hard-light", "#ffffff", "#808080")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("color-dodge: white brightens to full, black leaves the backdrop", () => {
    expect(centre("color-dodge", "#ffffff", "#404040")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(centre("color-dodge", "#000000", "#404040")).toMatchObject({
      r: 64,
      g: 64,
      b: 64,
    });
  });

  it("color-burn: black burns to zero, white leaves the backdrop", () => {
    expect(centre("color-burn", "#000000", "#404040")).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
    expect(centre("color-burn", "#ffffff", "#404040")).toMatchObject({
      r: 64,
      g: 64,
      b: 64,
    });
  });

  it("lighter: the two added and clamped", () => {
    expect(centre("lighter", "#804000", "#004080")).toMatchObject({
      r: 128,
      g: 128,
      b: 128,
    });
    expect(centre("lighter", "#ff0000", "#ff0000")).toMatchObject({
      r: 255,
      g: 0,
      b: 0,
    });
  });
});

describe("soft-light and the component modes", () => {
  // These have no byte-exact closed form worth restating in a test — the point
  // is that the mode is genuinely applied and is not the source or the
  // backdrop passed through.
  it("soft-light moves the backdrop toward the source without clipping it", () => {
    const p = centre("soft-light", "#ffffff", "#404040");
    expect(p.r).toBeGreaterThan(64); // brightened
    expect(p.r).toBeLessThan(255); // but nowhere near dodge
  });

  it("luminosity takes the source's brightness and the backdrop's colour", () => {
    // A white source over a saturated red backdrop keeps the hue, raises the
    // lightness — it must not come out plain white.
    const p = centre("luminosity", "#ffffff", "#ff0000");
    expect(p.r).toBeGreaterThan(200);
    expect(p.r - p.g).toBeLessThan(80); // washed toward the source's luminance
  });

  it("color takes the source's hue and the backdrop's brightness", () => {
    const p = centre("color", "#0000ff", "#808080");
    expect(p.b).toBeGreaterThan(p.r);
    expect(p.b).toBeGreaterThan(p.g);
  });

  it("saturation drains a colourful backdrop toward grey when the source is grey", () => {
    // A grey source carries no saturation, so the backdrop keeps its hue and
    // luminosity and loses its colourfulness — the channels converge.
    const p = centre("saturation", "#808080", "#ff8040");
    expect(Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)).toBeLessThan(8);
  });

  it("hue swings the backdrop to the source's hue, keeping its own strength", () => {
    // Blue over a warm orange: blue must now lead, and the result must be
    // neither input verbatim.
    const p = centre("hue", "#0000ff", "#ff8040");
    expect(p.b).toBeGreaterThan(p.r);
    expect(p).not.toMatchObject({ r: 0, g: 0, b: 255 });
    expect(p).not.toMatchObject({ r: 255, g: 128, b: 64 });
  });
});

describe("the default path", () => {
  it("an absent blend stacks plainly, as it always has", () => {
    expect(centre(undefined, "#ff0000", "#ffffff")).toMatchObject({
      r: 255,
      g: 0,
      b: 0,
    });
  });

  it("an explicit source-over is indistinguishable from an absent one", () => {
    const absent = composite(undefined, "#3366cc", "#cc9933").canvas;
    const explicit = composite("source-over", "#3366cc", "#cc9933").canvas;
    expect(
      Buffer.from(explicit.getContext("2d").getImageData(0, 0, 40, 40).data),
    ).toEqual(
      Buffer.from(absent.getContext("2d").getImageData(0, 0, 40, 40).data),
    );
  });

  it("allocates no layer when nothing is blended", () => {
    let allocations = 0;
    setSurfaceFactory((w, h) => {
      allocations += 1;
      return skiaFactory(w, h);
    });
    resetLayers();

    composite(undefined, "#ff0000", "#ffffff");
    composite("source-over", "#ff0000", "#ffffff");
    expect(allocations).toBe(0);

    composite("multiply", "#ff0000", "#ffffff");
    expect(allocations).toBe(1);
  });
});

/**
 * The reason the layer exists.
 *
 * Without isolation, a renderer's second draw blends against its own first one.
 * Under `multiply` a text clip's outline stroke would darken the fill beneath
 * it; under `screen` a drop shadow would double. The test states it in the
 * simplest form that fails: the same box drawn twice must land where one box
 * lands.
 */
describe("isolation", () => {
  it("blends a multi-primitive element once, not once per draw", () => {
    const one = composite("multiply", "#808080", "#ffffff").canvas;
    const two = composite(
      "multiply",
      "#808080",
      "#ffffff",
      fillBoxTwice("#808080"),
    ).canvas;

    expect(pixel(two, 20, 20)).toMatchObject(pixel(one, 20, 20));
    // And specifically: 128, not 128×128/255 = 64.
    expect(pixel(two, 20, 20)).toMatchObject({ r: 128, g: 128, b: 128 });
  });

  it("degrades to a direct composite when no surface can be made", () => {
    setSurfaceFactory(() => null);
    resetLayers();

    // Still correct for a single-draw element, which is every type but text.
    expect(centre("multiply", "#ff0000", "#808080")).toMatchObject({
      r: 128,
      g: 0,
      b: 0,
    });
  });

  it("reuses one layer across elements rather than allocating per draw", () => {
    let allocations = 0;
    setSurfaceFactory((w, h) => {
      allocations += 1;
      return skiaFactory(w, h);
    });
    resetLayers();

    const { ctx } = scene(40, 40, "#ffffff");
    for (let i = 0; i < 5; i++) {
      renderElement(
        ctx,
        `el${i}`,
        imageElement({
          location: { x: 0, y: 0 },
          width: 40,
          height: 40,
          blend: "multiply",
        }),
        0,
        false,
        fillBox("#ff0000"),
      );
    }
    expect(allocations).toBe(1);
  });

  it("clears the layer between elements, so one clip cannot leak into the next", () => {
    const { canvas, ctx } = scene(60, 60, "#ffffff");

    // A big red box, blended, then a small green one somewhere else. If the
    // layer were not cleared the red would still be in it and would multiply a
    // second time.
    renderElement(
      ctx,
      "big",
      imageElement({ location: { x: 0, y: 0 }, width: 60, height: 60, blend: "multiply" }),
      0,
      false,
      fillBox("#ffffff"),
    );
    renderElement(
      ctx,
      "small",
      imageElement({ location: { x: 0, y: 0 }, width: 10, height: 10, blend: "multiply" }),
      0,
      false,
      fillBox("#00ff00"),
    );

    // Outside the small box, the backdrop is untouched white.
    expect(pixel(canvas, 40, 40)).toMatchObject({ r: 255, g: 255, b: 255 });
    // Inside it, white × green = green.
    expect(pixel(canvas, 5, 5)).toMatchObject({ r: 0, g: 255, b: 0 });
  });
});

describe("blend composes with the rest of the element's state", () => {
  it("respects the element's transform", () => {
    const { canvas, ctx } = scene(60, 60, "#ffffff");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 20, y: 20 },
        width: 20,
        height: 20,
        blend: "multiply",
      }),
      0,
      false,
      fillBox("#ff0000"),
    );

    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
    // Outside the box the backdrop must be untouched — a layer blitted without
    // its transform would put the box at the origin instead.
    expect(pixel(canvas, 5, 5)).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("bakes opacity into the layer before blending", () => {
    // Red at 50% multiplied into white: the layer holds half-alpha red, and the
    // composite is halfway between the backdrop and full multiply.
    const { canvas, ctx } = scene(40, 40, "#ffffff");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        opacity: 50,
        blend: "multiply",
      }),
      0,
      false,
      fillBox("#ff0000"),
    );

    const p = pixel(canvas, 20, 20);
    expect(p.r).toBe(255);
    expect(p.g).toBeGreaterThan(100);
    expect(p.g).toBeLessThan(160);
  });

  it("follows the opacity track", () => {
    const { canvas, ctx } = scene(40, 40, "#ffffff");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        blend: "multiply",
        animation: {
          ...inactiveAnimation(),
          opacity: { isActivate: true, x: [], ax: points([0, 100], [1000, 0]) },
        },
      }),
      1000,
      false,
      fillBox("#ff0000"),
    );

    // Faded out completely: the backdrop survives untouched.
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("inherits a globalAlpha the caller already set", () => {
    const { canvas, ctx } = scene(40, 40, "#ffffff");
    ctx.globalAlpha = 0.5;
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        blend: "multiply",
      }),
      0,
      false,
      fillBox("#ff0000"),
    );

    const p = pixel(canvas, 20, 20);
    expect(p.g).toBeGreaterThan(100);
    expect(p.g).toBeLessThan(160);
  });
});

describe("context hygiene", () => {
  it("leaves the composite operation, alpha and transform as it found them", () => {
    const { ctx } = scene(40, 40, "#ffffff");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        blend: "difference",
      }),
      0,
      false,
      fillBox("#ff0000"),
    );

    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.globalAlpha).toBe(1);
    const m = ctx.getTransform();
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("does not disturb the element drawn after it", () => {
    const { canvas, ctx } = scene(60, 60, "#ffffff");
    renderElement(
      ctx,
      "blended",
      imageElement({ location: { x: 0, y: 0 }, width: 20, height: 20, blend: "difference" }),
      0,
      false,
      fillBox("#ff0000"),
    );
    renderElement(
      ctx,
      "plain",
      imageElement({ location: { x: 30, y: 30 }, width: 20, height: 20 }),
      0,
      false,
      fillBox("#0000ff"),
    );

    // The second clip stacks plainly: exactly its own colour.
    expect(pixel(canvas, 40, 40)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("draws the selection outline unblended", () => {
    // Under `difference` a blended outline would come back as its own inverse
    // against the clip it marks, and vanish on a mid-grey one.
    const { canvas, ctx } = scene(60, 60, "#808080");
    renderElement(
      ctx,
      "el",
      imageElement({ location: { x: 10, y: 10 }, width: 40, height: 40, blend: "difference" }),
      0,
      true,
      fillBox("#808080"),
    );

    // The interior is the difference: |128-128| = 0.
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 0, g: 0, b: 0 });
    // The outline sits on the element's border and is not black — it was drawn
    // after the blend, in the caller's own state.
    const border = pixel(canvas, 10, 30);
    expect(border.r + border.g + border.b).toBeGreaterThan(0);
  });
});

/**
 * Blend inside a transition.
 *
 * `fx/compositor.ts#renderClip` draws each half of a transition into its own
 * *cleared, transparent* canvas, then mixes the two in GL. There is nothing
 * beneath a clip in that buffer, so a blend mode there has nothing to blend
 * with — `multiply` against transparent black would erase the clip and the
 * dissolve would play into a hole.
 *
 * So `renderTimelineAtTime` hands the compositor a context marked `isolated`,
 * and blend is suspended for the length of the transition. That follows from
 * what a transition is: an operation on a *pair* of clips rather than a
 * property of one of them, which is how every NLE treats it.
 */
describe("blend inside a transition", () => {
  it("is suspended when drawing into a clip's own buffer", () => {
    const { canvas, ctx } = scene(40, 40, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 0, y: 0 },
        width: 40,
        height: 40,
        blend: "multiply",
      }),
      0,
      false,
      fillBox("#ff0000"),
      { elements: {}, isolated: true },
    );

    // Multiplied against the black backdrop this would be (0,0,0) and the clip
    // would have vanished. Suspended, it is the clip itself.
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("still applies the clip's transform, opacity and parenting", () => {
    // Only blend is suspended. Everything else about the clip is what makes a
    // dissolve show the clip as it is actually edited.
    const { canvas, ctx } = scene(60, 60, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({
        location: { x: 20, y: 20 },
        width: 20,
        height: 20,
        opacity: 50,
        blend: "multiply",
      }),
      0,
      false,
      fillBox("#ff0000"),
      { elements: {}, isolated: true },
    );

    const p = pixel(canvas, 30, 30);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
    expect(pixel(canvas, 5, 5)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("allocates no layer for a suspended blend", () => {
    let allocations = 0;
    setSurfaceFactory((w, h) => {
      allocations += 1;
      return skiaFactory(w, h);
    });
    resetLayers();

    const { ctx } = scene(40, 40, "#000000");
    renderElement(
      ctx,
      "el",
      imageElement({ location: { x: 0, y: 0 }, width: 40, height: 40, blend: "multiply" }),
      0,
      false,
      fillBox("#ff0000"),
      { elements: {}, isolated: true },
    );
    expect(allocations).toBe(0);
  });
});
