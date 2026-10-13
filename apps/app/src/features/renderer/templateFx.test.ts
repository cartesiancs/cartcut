import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ImageElementType,
  TemplateElementType,
  Timeline,
} from "../../@types/timeline";
import type { TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import { createTemplateElement } from "../timeline/templateOps";
import { nestedFxRuntime, type FxRuntime } from "./fx/runtime";
import { resetLayers, setSurfaceFactory, type Surface } from "./surface";
import { installTemplateResolver, renderTemplate } from "./template";
import { effectElement, imageElement, pixel, scene } from "./testing";
import {
  activeCompositeFx,
  renderTimelineAtTime,
  type TimelineRenderers,
} from "./timeline";

/**
 * An effect inside a template, in main's picture.
 *
 * The template's contents are drawn by a nested composite from inside the
 * outer one's paint. That nested composite used to be handed no effects
 * runtime at all, so an effect authored in the template's own project showed
 * there and vanished once the template was placed. It is now handed the
 * outer runtime's child. A fake runtime stands in for WebGL: its "effect"
 * paints the target green, which is enough to see where it ran.
 */

const skiaFactory = (width: number, height: number): Surface => {
  const canvas = createCanvas(width, height);
  return {
    canvas: canvas as unknown as Surface["canvas"],
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
};

const fillBox =
  (color: string) =>
  (ctx: CanvasRenderingContext2D, _id: string, element: ImageElementType) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

const renderers = {
  image: fillBox("#ff0000"),
  video: () => {},
  gif: () => {},
  text: () => {},
  shape: () => {},
  template: renderTemplate,
} as unknown as TimelineRenderers;

const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

type Ran = { by: string; id: string };

/** A runtime whose compositor paints an effect's whole target green. */
function fakeRuntime(ran: Ran[]): FxRuntime {
  const compositor = (name: string, nested: boolean): any => {
    let child: any = null;
    return {
      name,
      scratchCtx: () => null,
      flushScratch: () => {},
      drawTransition: () => {},
      filterBackdrop: () => false,
      applyEffect: (
        target: CanvasRenderingContext2D,
        active: { id: string },
        _preset: unknown,
        width: number,
        height: number,
      ) => {
        ran.push({ by: name, id: active.id });
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.fillStyle = "#00ff00";
        target.fillRect(0, 0, width, height);
        target.restore();
      },
      child: () => {
        if (nested) {
          return null;
        }
        child ??= compositor(`${name}/child`, true);
        return child;
      },
    };
  };
  return {
    compositor: compositor("outer", false),
    fps: 30,
    // "overlay" runs without a scratch canvas, which this fake has none of.
    modeOf: () => "overlay",
    presetOf: () => ({ id: "fake", render: { type: "overlay" } }) as any,
    backdropModeOf: () => null,
    lutFor: () => null,
    overlayFrameFor: () => null,
  };
}

/** A 100x100 template: a red box, and an effect over all of it for 2s. */
function template(): TemplateData {
  const elements = {
    box: imageElement({
      key: "box",
      priority: 1,
      startTime: 0,
      duration: 2000,
      width: 100,
      height: 100,
      location: { x: 0, y: 0 },
    }),
    grade: effectElement({ key: "grade", priority: 2, startTime: 0, duration: 2000 }),
  } as Timeline;
  return {
    id: "graded",
    name: "Graded",
    size: { w: 100, h: 100 },
    durationMs: 2000,
    elements,
    slots: slotsOf(elements),
  };
}

/** The template placed in the left half of a 100x100 frame. */
function placed(): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: "graded",
      name: "Graded",
      durationMs: 2000,
      size: { w: 100, h: 100 },
      frame: { w: 100, h: 100 },
    }),
    key: "tpl",
    priority: 1,
    width: 50,
    height: 100,
    location: { x: 0, y: 0 },
  } as TemplateElementType;
}

function drawMain(fx: FxRuntime | null) {
  const { ctx, canvas } = scene(100, 100);
  renderTimelineAtTime(
    ctx,
    { tpl: placed() } as Timeline,
    500,
    renderers,
    "#0000ff",
    100,
    100,
    undefined,
    undefined,
    fx,
  );
  return canvas;
}

beforeEach(() => {
  setSurfaceFactory(skiaFactory);
  installTemplateResolver(() => template(), renderers);
});

afterEach(() => {
  resetLayers();
  installTemplateResolver(() => null, renderers);
});

describe("an effect inside a template", () => {
  it("runs in main's composite, through the outer runtime's child", () => {
    const ran: Ran[] = [];
    const canvas = drawMain(fakeRuntime(ran));
    expect(ran).toEqual([{ by: "outer/child", id: "tpl::grade" }]);
    // Inside the template's box: the effect's green over the red box.
    expect(pixel(canvas, 25, 50)).toEqual(GREEN);
    // Outside it: main's own background, untouched by the template's effect.
    expect(pixel(canvas, 75, 50)).toEqual(BLUE);
  });

  it("did not run with no runtime, which is how it used to draw", () => {
    // The harness measures something: without the runtime the box is red.
    const canvas = drawMain(null);
    expect(pixel(canvas, 25, 50)).toEqual(RED);
  });

  it("names the composite's runtime only while the composite runs", () => {
    expect(activeCompositeFx()).toBeNull();
    const fx = fakeRuntime([]);
    let seen: FxRuntime | null = null;
    const watching = {
      ...renderers,
      image: (ctx: CanvasRenderingContext2D, id: string, element: ImageElementType) => {
        seen = activeCompositeFx();
        fillBox("#ff0000")(ctx, id, element);
      },
    } as unknown as TimelineRenderers;
    const { ctx } = scene(10, 10);
    renderTimelineAtTime(
      ctx,
      { a: imageElement({ priority: 1, duration: 1000 }) } as Timeline,
      0,
      watching,
      "#000",
      10,
      10,
      undefined,
      undefined,
      fx,
    );
    expect(seen).toBe(fx);
    expect(activeCompositeFx()).toBeNull();
  });

  it("gives back the outer runtime after a throw", () => {
    const fx = fakeRuntime([]);
    const throwing = {
      ...renderers,
      image: () => {
        throw new Error("mid-paint");
      },
    } as unknown as TimelineRenderers;
    const { ctx } = scene(10, 10);
    expect(() =>
      renderTimelineAtTime(
        ctx,
        { a: imageElement({ priority: 1, duration: 1000 }) } as Timeline,
        0,
        throwing,
        "#000",
        10,
        10,
        undefined,
        undefined,
        fx,
      ),
    ).toThrow();
    expect(activeCompositeFx()).toBeNull();
  });
});

describe("nestedFxRuntime", () => {
  it("is the same runtime around the child compositor, once per runtime", () => {
    const fx = fakeRuntime([]);
    const nested = nestedFxRuntime(fx)!;
    expect(nested.compositor).toBe((fx.compositor as any).child());
    expect(nested.fps).toBe(fx.fps);
    expect(nestedFxRuntime(fx)).toBe(nested);
  });

  it("is null for no runtime, and inside a template", () => {
    expect(nestedFxRuntime(null)).toBeNull();
    const nested = nestedFxRuntime(fakeRuntime([]));
    expect(nestedFxRuntime(nested)).toBeNull();
  });
});
