/**
 * Property links, drawn.
 *
 * `animation/link.test.ts` pins what a link *resolves to*; this pins that the
 * picture follows. They are worth separating because the resolution is pure
 * and the injection is not: a link reaches the canvas through three seams —
 * the element's own transform, its opacity, and the world matrix its children
 * inherit — and a link that resolved correctly while missing one of them would
 * pass the pure suite and be invisible in the app.
 */

import { describe, it, expect } from "vitest";

import { renderElement } from "./element";
import { imageElement, inkBounds, pixel, scene } from "./testing";
import type { ImageElementType, Timeline } from "../../@types/timeline";

/** A renderer that fills the element's local box, so the transform is visible. */
const fillBox = (color: string) =>
  (ctx: CanvasRenderingContext2D, _id: string, element: ImageElementType) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

function draw(elements: Timeline, id: string, cursor = 0) {
  const { canvas, ctx } = scene(400, 400, "#000000");
  renderElement(
    ctx,
    id,
    elements[id] as any,
    cursor,
    false,
    fillBox("#ff0000") as any,
    { elements },
  );
  return canvas;
}

/** A null object at a given rotation, for a link to read. */
function nullAt(rotation: number) {
  return {
    ...imageElement({ width: 0, height: 0 }),
    filetype: "group",
    rotation,
  } as any;
}

function card(over: Record<string, unknown> = {}) {
  return imageElement({
    width: 80,
    height: 80,
    location: { x: 100, y: 100 },
    ...over,
  } as any);
}

describe("a linked opacity", () => {
  const linkFade = (offset = 0) => ({
    opacity: {
      from: { elementId: "spin", property: "rotation" },
      in: [-90, 0, 90],
      out: [0, 100, 0],
      ...(offset === 0 ? {} : { offset }),
    },
  });

  it("reaches the picture", () => {
    const full = draw({ spin: nullAt(0), card: card({ link: linkFade() }) }, "card");
    const gone = draw({ spin: nullAt(90), card: card({ link: linkFade() }) }, "card");

    // At the centre of the map the card is opaque; at the edge it is gone.
    expect(pixel(full, 140, 140).r).toBeGreaterThan(200);
    expect(pixel(gone, 140, 140).r).toBeLessThan(20);
  });

  it("follows the source when the source moves", () => {
    // This is the whole difference between a link and a bake: change the
    // driver and everything derived from it changes with it.
    const at = (rotation: number) =>
      pixel(
        draw({ spin: nullAt(rotation), card: card({ link: linkFade() }) }, "card"),
        140,
        140,
      ).r;

    expect(at(0)).toBeGreaterThan(at(45));
    expect(at(45)).toBeGreaterThan(at(80));
  });

  it("gives a row of clips one shape and many phases", () => {
    // The card wheel: one description, one offset per card, one call.
    const elements: Timeline = { spin: nullAt(0) } as any;
    for (let i = 0; i < 3; i += 1) {
      (elements as any)[`card${i}`] = card({ link: linkFade(i * -45) });
    }

    const brightness = [0, 1, 2].map(
      (i) => pixel(draw(elements, `card${i}`), 140, 140).r,
    );
    expect(brightness[0]).toBeGreaterThan(brightness[1]);
    expect(brightness[1]).toBeGreaterThan(brightness[2]);
  });

  it("replaces the clip's own keyframes rather than multiplying with them", () => {
    // A link *is* the value, the way an expression is in After Effects. If it
    // multiplied, a clip whose opacity track said 50 would come out at half.
    const keyed = card({
      link: linkFade(),
      opacity: 50,
      animation: {
        opacity: { isActivate: true, x: [], ax: [[0, 20]] },
      },
    });
    const canvas = draw({ spin: nullAt(0), card: keyed }, "card");
    expect(pixel(canvas, 140, 140).r).toBeGreaterThan(200);
  });
});

describe("a linked transform", () => {
  it("moves the clip", () => {
    const link = {
      position: {
        from: { elementId: "spin", property: "rotation" },
        in: [0, 90],
        out: [0, 200],
      },
    };
    const at = (rotation: number) =>
      inkBounds(draw({ spin: nullAt(rotation), card: card({ link }) }, "card")).minX;

    // Handed different source values the two must disagree, or this suite
    // would pass against a renderer that ignored the link.
    expect(at(90)).toBeGreaterThan(at(0));
  });

  it("scales the clip", () => {
    const link = {
      scale: {
        from: { elementId: "spin", property: "rotation" },
        in: [0, 90],
        out: [10, 20],
      },
    };
    const size = (rotation: number) => {
      const box = inkBounds(
        draw({ spin: nullAt(rotation), card: card({ link }) }, "card"),
      );
      return box.maxX - box.minX;
    };

    expect(size(90)).toBeGreaterThan(size(0));
  });
});

describe("a clip with no links", () => {
  it("draws exactly what it drew before", () => {
    // The claim that makes this safe to add: an unlinked clip takes the same
    // path it always took, which is what keeps `golden.test.ts` green.
    const plain = card();
    const withMap = draw({ card: plain } as any, "card");
    const withoutMap = (() => {
      const { canvas, ctx } = scene(400, 400, "#000000");
      renderElement(ctx, "card", plain as any, 0, false, fillBox("#ff0000") as any);
      return canvas;
    })();

    expect(inkBounds(withMap)).toEqual(inkBounds(withoutMap));
  });
});
