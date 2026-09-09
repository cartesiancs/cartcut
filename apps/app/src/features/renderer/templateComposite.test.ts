import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ImageElementType,
  TemplateElementType,
  Timeline,
} from "../../@types/timeline";
import type { TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import { createTemplateElement } from "../timeline/templateOps";
import { renderElement } from "./element";
import {
  namedLayer,
  resetLayers,
  setSurfaceFactory,
  type Surface,
} from "./surface";
import { imageElement, pixel, scene } from "./testing";
import {
  innerCursorOf,
  installTemplateResolver,
  renderTemplate,
} from "./template";
import type { TimelineRenderers } from "./timeline";

/**
 * A template through the real `renderElement`, asserted on bytes.
 *
 * Three things this pins, and the first is the one that would be invisible
 * until someone put a template over a picture: **the nested render must not
 * paint a background.** `renderTimelineAtTime` fills its whole frame before
 * drawing, and a template that passed the project's background colour through
 * would blank everything beneath it and look, at a glance, exactly like a
 * template that was simply full-bleed.
 *
 * `testing.ts` installs the Skia surface factory on import, so the layer
 * allocation here is the one the app performs.
 */

const skiaFactory = (width: number, height: number): Surface => {
  const canvas = createCanvas(width, height);
  return {
    canvas: canvas as unknown as Surface["canvas"],
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
};

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

const innerRenderers = {
  image: fillBox("#ff0000"),
  video: () => {},
  gif: () => {},
  text: () => {},
  shape: () => {},
  template: () => {},
} as unknown as TimelineRenderers;

/** A template 100×100 whose whole frame is red for its first two seconds. */
function redTemplate(over: Partial<TemplateData> = {}): TemplateData {
  const elements = {
    fill: imageElement({
      key: "fill",
      priority: 1,
      startTime: 0,
      duration: 2000,
      width: 100,
      height: 100,
      location: { x: 0, y: 0 },
    }),
  } as Timeline;
  return {
    id: "red",
    name: "Red",
    size: { w: 100, h: 100 },
    durationMs: 2000,
    elements,
    slots: slotsOf(elements),
    ...over,
  };
}

function placed(over: Partial<TemplateElementType> = {}): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: "red",
      name: "Red",
      durationMs: 2000,
      size: { w: 100, h: 100 },
      frame: { w: 100, h: 100 },
    }),
    key: "tpl",
    ...over,
  } as TemplateElementType;
}

function install(resolve: (id: string) => TemplateData | null) {
  installTemplateResolver(resolve, innerRenderers);
}

afterEach(() => {
  setSurfaceFactory(skiaFactory);
  resetLayers();
  install(() => null);
});

/** Draw one template onto a 100×100 scene with a known backdrop. */
function draw(
  element: TemplateElementType,
  cursor = 0,
  backdrop = "#0000ff",
): { ctx: CanvasRenderingContext2D; canvas: any } {
  const { ctx, canvas } = scene(100, 100);
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, 100, 100);
  renderElement(
    ctx,
    "tpl",
    element as any,
    cursor,
    false,
    renderTemplate as any,
    { elements: { tpl: element } as Timeline },
  );
  return { ctx, canvas };
}

describe("a template that resolves", () => {
  it("draws its composition into the element's box", () => {
    install(() => redTemplate());
    const { canvas } = draw(placed());
    expect(pixel(canvas, 50, 50)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("draws nothing outside its box", () => {
    install(() => redTemplate());
    const { canvas } = draw(
      placed({ width: 40, height: 40, location: { x: 0, y: 0 } }),
    );
    expect(pixel(canvas, 10, 10)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    // Beyond 40px the backdrop must survive.
    expect(pixel(canvas, 60, 60)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("does not paint a background over what is beneath it", () => {
    // The one that would be invisible: an inner clip covering only half the
    // template must leave the other half showing the scene, not black.
    install(() =>
      redTemplate({
        elements: {
          half: imageElement({
            key: "half",
            priority: 1,
            duration: 2000,
            width: 100,
            height: 50,
            location: { x: 0, y: 0 },
          }),
        } as Timeline,
      }),
    );
    const { canvas } = draw(placed());
    expect(pixel(canvas, 50, 10)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(canvas, 50, 90)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("moves with the element's location", () => {
    install(() => redTemplate());
    const { canvas } = draw(
      placed({ width: 20, height: 20, location: { x: 60, y: 60 } }),
    );
    expect(pixel(canvas, 70, 70)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(canvas, 10, 10)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("scales its native size onto the element's box", () => {
    // The template composes at 100×100 and is placed at 50×50, so the whole
    // composition has to land inside those fifty pixels rather than be cropped.
    install(() =>
      redTemplate({
        elements: {
          corner: imageElement({
            key: "corner",
            priority: 1,
            duration: 2000,
            width: 100,
            height: 100,
            location: { x: 0, y: 0 },
          }),
        } as Timeline,
      }),
    );
    const { canvas } = draw(
      placed({ width: 50, height: 50, location: { x: 0, y: 0 } }),
    );
    expect(pixel(canvas, 45, 45)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(canvas, 55, 55)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("fades with the element's opacity", () => {
    install(() => redTemplate());
    const { canvas } = draw(placed({ opacity: 50 }), 0, "#000000");
    const { r, g, b } = pixel(canvas, 50, 50);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(136);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });
});

describe("the inner clock", () => {
  it("reads the template's own time, offset by where it sits", () => {
    // The clip inside runs 0..1000 of template time. Placed at 5000, it must
    // be visible at 5500 on the real timeline and gone at 6500.
    install(() =>
      redTemplate({
        durationMs: 2000,
        elements: {
          brief: imageElement({
            key: "brief",
            priority: 1,
            startTime: 0,
            duration: 1000,
            width: 100,
            height: 100,
          }),
        } as Timeline,
      }),
    );
    const element = placed({ startTime: 5000, duration: 2000 });
    expect(pixel(draw(element, 5500).canvas, 50, 50)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 255,
    });
    expect(pixel(draw(element, 6500).canvas, 50, 50)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });
});

describe("a template that does not resolve", () => {
  it("draws nothing and does not throw", () => {
    // The contract a missing LUT already has. A project opened without its
    // templates installed shows the scene, not a hole and not an exception.
    install(() => null);
    const { canvas } = draw(placed());
    expect(pixel(canvas, 50, 50)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("draws nothing when no resolver has been installed at all", () => {
    installTemplateResolver(() => null, null as any);
    expect(() => draw(placed())).not.toThrow();
  });

  it("draws nothing for a template claiming no size", () => {
    install(() => redTemplate({ size: { w: 0, h: 0 } }));
    const { canvas } = draw(placed());
    expect(pixel(canvas, 50, 50)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });
});

describe("innerCursorOf", () => {
  it("is a straight offset from where the template sits", () => {
    expect(innerCursorOf(placed({ startTime: 5000 }), 5500, 2000)).toBe(500);
  });

  it("has no speed term, because a template's rate is fixed with its length", () => {
    // A template carries no `speed`, so there is no `duration / speed` to
    // divide by — the arithmetic every other clip needs is absent by design.
    const element = placed({ startTime: 0, duration: 2000 });
    expect(innerCursorOf(element, 1234, 2000)).toBe(1234);
  });

  it("clamps to the composition's own span at both ends", () => {
    const element = placed({ startTime: 1000 });
    expect(innerCursorOf(element, 0, 2000)).toBe(0);
    expect(innerCursorOf(element, 99_000, 2000)).toBe(2000);
  });
});

describe("two templates in one frame", () => {
  it("each draw their own composition, side by side", () => {
    // Each gets a named layer of its own, keyed on the element id, sized to
    // its own native resolution. One shared buffer would be reallocated
    // between them every frame — and `namedLayer` clears on every hand-out,
    // so a second caller would wipe a first that had not blitted yet.
    const red = redTemplate();
    const blue = redTemplate({
      id: "blue",
      size: { w: 20, h: 20 },
      elements: {
        fill: imageElement({
          key: "fill",
          priority: 1,
          duration: 2000,
          width: 20,
          height: 20,
          location: { x: 0, y: 0 },
        }),
      } as Timeline,
    });

    installTemplateResolver((id) => (id === "red" ? red : blue), {
      ...innerRenderers,
      image: fillBox("#00ff00"),
    } as unknown as TimelineRenderers);

    const { ctx, canvas } = scene(100, 100);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 0, 100, 100);

    const left = placed({ key: "a", width: 50, height: 100 });
    const right = placed({
      key: "b",
      templateId: "blue",
      width: 50,
      height: 100,
      location: { x: 50, y: 0 },
    });
    const elements = { a: left, b: right } as unknown as Timeline;

    for (const [id, element] of [
      ["a", left],
      ["b", right],
    ] as const) {
      renderElement(ctx, id, element as any, 0, false, renderTemplate as any, {
        elements,
      });
    }

    expect(pixel(canvas, 25, 50)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(pixel(canvas, 75, 50)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("gives each a layer at its own native size", () => {
    const small = redTemplate({ id: "small", size: { w: 20, h: 20 } });
    const large = redTemplate({ id: "large", size: { w: 400, h: 400 } });
    installTemplateResolver(
      (id) => (id === "small" ? small : large),
      innerRenderers,
    );

    const { ctx } = scene(100, 100);
    const a = placed({ key: "a", templateId: "small" });
    const b = placed({ key: "b", templateId: "large" });
    const elements = { a, b } as unknown as Timeline;

    for (const [id, element] of [
      ["a", a],
      ["b", b],
    ] as const) {
      renderElement(ctx, id, element as any, 0, false, renderTemplate as any, {
        elements,
      });
    }

    expect(namedLayer("a", 20, 20).canvas.width).toBe(20);
    expect(namedLayer("b", 400, 400).canvas.width).toBe(400);
  });
});
