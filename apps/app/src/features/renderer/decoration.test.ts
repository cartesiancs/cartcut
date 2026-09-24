/**
 * A border and a drop shadow on a shape, an image and a video.
 *
 * Element renderers receive a context already placed in the element's local
 * space by `renderElement`, so these draw at the origin and assert there.
 *
 * Two habits from the rest of the renderer suite are worth keeping in mind
 * while reading it. Every claim is checked against a **pixel**, not against the
 * call the renderer made — a stroke that set `strokeStyle` and never stroked
 * would satisfy a spy and fail here. And where a default could make a test pass
 * for the wrong reason, the two sides are handed different inputs and required
 * to disagree.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { inkBounds, pixel, scene, shapeElement, solid } from "./testing";

const store = { getImage: vi.fn<[string], unknown>() };

vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderShape } = await import("./shape");
const { renderImage } = await import("./image");
const { isDecorated, shadowOf, strokeOf } = await import("./decoration");

/** A red square filling 0,0..100,100 in element space. */
function square(over: Record<string, unknown> = {}) {
  return shapeElement({
    width: 100,
    height: 100,
    option: { fillColor: "#ff0000" },
    ...over,
  } as any);
}

const GREEN_STROKE = {
  enable: true,
  width: 6,
  color: "#00ff00",
  opacity: 100,
  align: "center" as const,
};

beforeEach(() => {
  store.getImage.mockReset();
});

describe("the read guards", () => {
  it("answer null for a clip with nothing on it", () => {
    expect(strokeOf(square() as any)).toBeNull();
    expect(shadowOf(square() as any)).toBeNull();
    expect(isDecorated(square() as any)).toBe(false);
  });

  it("answer null for a decoration switched off", () => {
    expect(
      strokeOf(square({ stroke: { ...GREEN_STROKE, enable: false } }) as any),
    ).toBeNull();
  });

  it("answer null for a stroke that would paint nothing", () => {
    // Zero width and zero opacity both mean "draw nothing", and answering
    // `null` for them is what keeps `renderElement`'s fast path open for a
    // clip whose border is dialled all the way down.
    expect(strokeOf(square({ stroke: { ...GREEN_STROKE, width: 0 } }) as any)).toBeNull();
    expect(
      strokeOf(square({ stroke: { ...GREEN_STROKE, opacity: 0 } }) as any),
    ).toBeNull();
  });

  it("answer null for a shadow with no offset and no blur", () => {
    // It would paint a hard copy of the clip exactly underneath it: invisible,
    // and a whole extra pass.
    expect(
      shadowOf(
        square({
          shadow: {
            enable: true,
            offsetX: 0,
            offsetY: 0,
            blur: 0,
            color: "#000000",
            opacity: 100,
          },
        }) as any,
      ),
    ).toBeNull();
  });

  it("never throw on a hand-edited file", () => {
    for (const junk of [null, 3, "yes", [], { enable: "true" }]) {
      expect(() => strokeOf({ stroke: junk } as any)).not.toThrow();
      expect(() => shadowOf({ shadow: junk } as any)).not.toThrow();
    }
  });

  it("floors a negative blur, which the canvas throws on", () => {
    const read = shadowOf(
      square({
        shadow: {
          enable: true,
          offsetX: 10,
          offsetY: 10,
          blur: -5,
          color: "#000000",
          opacity: 100,
        },
      }) as any,
    );
    expect(read?.blur).toBe(0);
  });
});

describe("renderShape with a stroke", () => {
  it("draws nothing extra without one", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(ctx, "s", square(), 0);

    // The fill alone: red inside, background outside.
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 110, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("straddles the outline when centred", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(ctx, "s", square({ stroke: GREEN_STROKE }), 0);

    // Half the 6px line inside the edge, half outside.
    expect(pixel(canvas, 50, 98)).toMatchObject({ g: 255 });
    expect(pixel(canvas, 50, 102)).toMatchObject({ g: 255 });
    // Well clear of it, the background is untouched.
    expect(pixel(canvas, 50, 110)).toMatchObject({ r: 0, g: 0, b: 0 });
    // Well inside, the fill still shows.
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("stays inside the outline when inner", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(
      ctx,
      "s",
      square({ stroke: { ...GREEN_STROKE, align: "inner" } }),
      0,
    );

    expect(pixel(canvas, 50, 97)).toMatchObject({ g: 255 });
    // Outside the edge is background, not stroke — this is the claim that
    // separates `inner` from `center`.
    expect(pixel(canvas, 50, 103)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("stays outside the outline when outer", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(
      ctx,
      "s",
      square({ stroke: { ...GREEN_STROKE, align: "outer" } }),
      0,
    );

    expect(pixel(canvas, 50, 103)).toMatchObject({ g: 255 });
    // Inside the edge is the fill, undisturbed.
    expect(pixel(canvas, 50, 97)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("puts the three alignments in three different places", () => {
    // Without this the suite would pass against an implementation that
    // ignored `align` and centred everything.
    const reach = (align: "inner" | "center" | "outer") => {
      const { canvas, ctx } = scene(200, 200, "#000000");
      renderShape(ctx, "s", square({ stroke: { ...GREEN_STROKE, align } }), 0);
      return inkBounds(canvas).maxY;
    };

    expect(reach("inner")).toBeLessThan(reach("center"));
    expect(reach("center")).toBeLessThan(reach("outer"));
  });

  it("follows a rounded rectangle's corners rather than its bounding box", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(
      ctx,
      "s",
      square({
        geometry: { kind: "rectangle", radius: 40 },
        stroke: { ...GREEN_STROKE, align: "inner" },
      }),
      0,
    );

    // The corner is cut away, so neither the fill nor its border reaches it.
    expect(pixel(canvas, 2, 2)).toMatchObject({ r: 0, g: 0, b: 0 });
    // The middle of an edge still carries the border.
    expect(pixel(canvas, 50, 97)).toMatchObject({ g: 255 });
  });
});

describe("renderShape with a drop shadow", () => {
  const SHADOW = {
    enable: true,
    offsetX: 20,
    offsetY: 20,
    blur: 0,
    color: "#0000ff",
    opacity: 100,
  };

  it("lays ink down and to the right, under the picture", () => {
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(ctx, "s", square({ shadow: SHADOW }), 0);

    // Offset by 20, so 110,110 is shadow and 50,50 is still the fill.
    expect(pixel(canvas, 110, 110)).toMatchObject({ r: 0, g: 0, b: 255 });
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    // Up and to the left of the clip, nothing.
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("follows the offset it is given", () => {
    const at = (offsetX: number) => {
      const { canvas, ctx } = scene(200, 200, "#000000");
      renderShape(ctx, "s", square({ shadow: { ...SHADOW, offsetX } }), 0);
      return inkBounds(canvas).maxX;
    };

    // Handed different offsets the two must disagree, or this suite would pass
    // against a shadow nailed to one place.
    expect(at(40)).toBeGreaterThan(at(20));
  });

  it("paints only the shadow, never a second copy of the body", () => {
    // `paintShadowOnly` exists for this: a pass that also painted the source
    // would print the fill twice and a translucent clip would come out darker
    // than asked for.
    const { canvas, ctx } = scene(200, 200, "#000000");
    renderShape(
      ctx,
      "s",
      square({ shadow: { ...SHADOW, offsetX: 0, offsetY: 0, blur: 8 } }),
      0,
    );

    // The body is red, not a blue-red mix: the shadow under it did not add ink
    // on top of the fill.
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
  });
});

describe("renderImage with decoration", () => {
  it("borders the box", () => {
    store.getImage.mockReturnValue(solid(10, 10, "#ff0000"));

    const { canvas, ctx } = scene(200, 200, "#000000");
    renderImage(
      ctx,
      "i",
      {
        ...(square() as any),
        filetype: "image",
        localpath: "/a.png",
        stroke: { ...GREEN_STROKE, align: "inner" },
      },
      0,
    );

    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 50, 97)).toMatchObject({ g: 255 });
  });

  it("draws the picture unchanged with no decoration", () => {
    store.getImage.mockReturnValue(solid(10, 10, "#ff0000"));

    const { canvas, ctx } = scene(200, 200, "#000000");
    renderImage(
      ctx,
      "i",
      { ...(square() as any), filetype: "image", localpath: "/a.png" },
      0,
    );

    expect(pixel(canvas, 1, 1)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 110, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
