import { describe, it, expect, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderElement } from "./element";
import { renderShape } from "./shape";
import { resetLayers, setSurfaceFactory, type Surface } from "./surface";
import { pixel, scene, shapeElement } from "./testing";
import type { BackdropFxPort } from "./backdrop";
import { defaultMask } from "../mask/maskShape";
import type { MaskType, ShapeElementType } from "../../@types/timeline";

/**
 * A shape's backdrop preset through `renderElement`, against a fake port.
 *
 * The real port runs a preset in WebGL, which the node suites do not have, so
 * this one mirrors the frame left to right. That picture is chosen to prove
 * three things at once, because each is a way the feature could fail without
 * anything looking broken in isolation:
 *
 *  - **it read the frame beneath**, not the transparent layer a masked or
 *    blended clip is drawn onto (a layer would mirror into nothing);
 *  - **it landed in register**: a mirror of a red/blue step puts blue where red
 *    was, and only at the right columns if the picture was drawn 1:1;
 *  - **it stayed inside the outline**: every pixel outside the shape is the
 *    untouched step.
 *
 * The backdrop is red left of x = 100 and blue right of it. The shape covers
 * [50, 150) on both axes, so mirrored about the frame's centre its left half
 * shows blue and its right half red: the step reversed, inside the shape only.
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

const SIZE = 200;
const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
const GREEN = { r: 0, g: 255, b: 0 };

/** A shape over the middle of the frame, mosaicking it, with its fill switched off. */
function mosaic(over: Partial<ShapeElementType> = {}): ShapeElementType {
  return shapeElement({
    location: { x: 50, y: 50 },
    width: 100,
    height: 100,
    backdropFx: { presetId: "com.cartcut.pixelate", params: {}, intensity: 100 },
    ...over,
    option: { fillColor: "#00ff00", fillOpacity: 0, ...(over.option ?? {}) },
  });
}

/** The frame mirrored left to right, landed whole. Records who asked. */
function mirrorPort(calls: string[] = []): BackdropFxPort {
  return (elementId, source, land) => {
    calls.push(elementId);
    const out = createCanvas(source.width, source.height);
    const o = out.getContext("2d");
    o.translate(source.width, 0);
    o.scale(-1, 1);
    o.drawImage(source as any, 0, 0);
    land(out as unknown as CanvasImageSource);
    return true;
  };
}

/** A port with nothing planned for this frame: a preset that cannot run. */
const decliningPort: BackdropFxPort = () => false;

/** The red/blue step, which is what every backdrop here is drawn over. */
function stepFrame() {
  const { canvas, ctx } = scene(SIZE, SIZE);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, SIZE / 2, SIZE);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(SIZE / 2, 0, SIZE / 2, SIZE);
  return { canvas, ctx };
}

function draw(
  element: ShapeElementType,
  options: {
    port?: BackdropFxPort | null;
    isolated?: boolean;
    outer?: Surface["canvas"] | null;
  } = {},
) {
  const { canvas, ctx } = stepFrame();
  const port = options.port === undefined ? mirrorPort() : options.port;
  renderElement(ctx, "face", element, 0, false, renderShape, {
    elements: { face: element },
    backdropFx: port,
    isolated: options.isolated,
    outerBackdrop: options.outer,
  });
  return canvas;
}

function rgb(canvas: ReturnType<typeof scene>["canvas"], x: number, y: number) {
  const { r, g, b } = pixel(canvas, x, y);
  return { r, g, b };
}

/** A mask far larger than the box, which cuts nothing and forces isolation. */
function coversEverything(): MaskType {
  return {
    ...defaultMask("rectangle"),
    location: { x: 50, y: 50 },
    size: { width: 2000, height: 2000 },
  };
}

describe("a shape's backdrop through renderElement", () => {
  it("lands the preset's picture inside the outline, in register", () => {
    const canvas = draw(mosaic());
    // Inside the shape, the step reversed.
    expect(rgb(canvas, 60, 100)).toEqual(BLUE);
    expect(rgb(canvas, 140, 100)).toEqual(RED);
    // Outside it, on every side, the frame as it was.
    expect(rgb(canvas, 20, 100)).toEqual(RED);
    expect(rgb(canvas, 180, 100)).toEqual(BLUE);
    expect(rgb(canvas, 60, 20)).toEqual(RED);
    expect(rgb(canvas, 140, 180)).toEqual(BLUE);
  });

  it("asks the port for this shape, once", () => {
    const calls: string[] = [];
    draw(mosaic(), { port: mirrorPort(calls) });
    expect(calls).toEqual(["face"]);
  });

  it("reads the frame through the isolated path, to the same picture", () => {
    // A mask sends the clip to a transparent layer. A port handed that layer
    // would mirror nothing, and the region would come out as a hole. The mask
    // covers everything, so the two paths have to agree to the byte.
    const fast = draw(mosaic());
    const layered = draw(mosaic({ mask: coversEverything() }));
    expect(
      Buffer.from(layered.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(
      Buffer.from(fast.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    );
  });

  it("is cut by a mask, like the rest of the clip", () => {
    const masked = draw(
      mosaic({
        mask: {
          ...defaultMask("rectangle"),
          location: { x: 25, y: 50 },
          size: { width: 50, height: 100 },
        },
      }),
    );
    // The mask keeps the shape's left half: reversed there, untouched beyond.
    expect(rgb(masked, 60, 100)).toEqual(BLUE);
    expect(rgb(masked, 140, 100)).toEqual(BLUE);
  });

  it("is faded by the clip's opacity", () => {
    // Half strength over the sharp original, the frost's rule: fading the clip
    // fades what it does to the frame.
    const { r, b } = rgb(draw(mosaic({ opacity: 50 })), 60, 100);
    expect(r).toBeGreaterThan(110);
    expect(r).toBeLessThan(145);
    expect(b).toBeGreaterThan(110);
    expect(b).toBeLessThan(145);
  });

  it("is tinted by a translucent fill drawn over it", () => {
    const canvas = draw(mosaic({ option: { fillColor: "#00ff00", fillOpacity: 50 } }));
    const { r, g, b } = rgb(canvas, 60, 100);
    // Half green over the reversed step's blue.
    expect(r).toBe(0);
    expect(g).toBeGreaterThan(110);
    expect(b).toBeGreaterThan(110);
  });
});

describe("a backdrop that cannot land", () => {
  // The fill is drawn solid, whatever `fillOpacity` says. A mosaic is made with
  // its fill switched off, and one that failed to run would otherwise leave
  // the face it is there to hide in plain view.

  it("fills solid when there is no port", () => {
    // A host with no compositor: no WebGL, the rasteriser, a template's inner
    // timeline.
    expect(rgb(draw(mosaic(), { port: null }), 60, 100)).toEqual(GREEN);
  });

  it("fills solid when the port has nothing planned for it", () => {
    // A preset that is not installed, or not one a backdrop can carry.
    expect(rgb(draw(mosaic(), { port: decliningPort }), 60, 100)).toEqual(GREEN);
  });

  it("fills solid inside a transition with no frame to read", () => {
    expect(rgb(draw(mosaic(), { isolated: true }), 60, 100)).toEqual(GREEN);
  });

  it("fills solid when the frame it was given is out of register", () => {
    const small = createCanvas(SIZE / 2, SIZE / 2) as unknown as Surface["canvas"];
    expect(
      rgb(draw(mosaic(), { isolated: true, outer: small }), 60, 100),
    ).toEqual(GREEN);
  });
});

describe("a backdrop inside a transition", () => {
  it("reads the frame the transition is drawn over", () => {
    // `compositor.ts#renderClip` draws the clip alone into a cleared buffer.
    // The frame beneath the transition is complete by then, and that is what
    // the backdrop reads: a mosaic that stopped for a dissolve would show the
    // face it hides.
    const outer = stepFrame().canvas;
    const { canvas: clip, ctx } = scene(SIZE, SIZE);
    const element = mosaic();
    renderElement(ctx, "face", element, 0, false, renderShape, {
      elements: { face: element },
      backdropFx: mirrorPort(),
      isolated: true,
      outerBackdrop: outer as unknown as Surface["canvas"],
    });
    expect(rgb(clip, 60, 100)).toEqual(BLUE);
    expect(rgb(clip, 140, 100)).toEqual(RED);
    // Nothing outside the shape: the buffer holds this clip alone.
    expect(pixel(clip, 20, 100).a).toBe(0);
  });
});

describe("a shape with no backdrop", () => {
  it("never asks the port", () => {
    const calls: string[] = [];
    draw(shapeElement({ location: { x: 50, y: 50 } }), { port: mirrorPort(calls) });
    expect(calls).toEqual([]);
  });

  it("draws a translucent fill when `fillOpacity` asks for one", () => {
    const canvas = draw(
      shapeElement({
        location: { x: 50, y: 50 },
        option: { fillColor: "#00ff00", fillOpacity: 50 },
      }),
    );
    const { r, g, b } = rgb(canvas, 60, 100);
    expect(r).toBeGreaterThan(110);
    expect(r).toBeLessThan(145);
    expect(g).toBeGreaterThan(110);
    expect(b).toBe(0);
  });

  it("draws an absent `fillOpacity` and 100 as the same pixels", () => {
    const absent = draw(shapeElement({ location: { x: 50, y: 50 } }));
    const full = draw(
      shapeElement({
        location: { x: 50, y: 50 },
        option: { fillColor: "#ff0000", fillOpacity: 100 },
      }),
    );
    expect(
      Buffer.from(full.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(
      Buffer.from(absent.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    );
  });

  it("draws nothing at all at `fillOpacity` 0", () => {
    const canvas = draw(
      shapeElement({
        location: { x: 50, y: 50 },
        option: { fillColor: "#00ff00", fillOpacity: 0 },
      }),
    );
    expect(rgb(canvas, 60, 100)).toEqual(RED);
    expect(rgb(canvas, 140, 100)).toEqual(BLUE);
  });
});
