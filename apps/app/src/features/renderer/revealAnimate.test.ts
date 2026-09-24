/**
 * The text animator, drawn.
 *
 * `text/reveal.test.ts` pins what the plan *says*; this pins that the renderer
 * does it. The two are worth separating because the interesting half of the
 * feature is a canvas trick: an arriving unit is drawn by painting the whole
 * prefix under a transform and clipping to that unit's own band, so the kerning
 * stays the font's own and neighbours never bleed into the band.
 *
 * Element renderers receive a context already in the element's local space, so
 * these draw at the origin and assert there.
 */

import { describe, expect, it } from "vitest";

import { inkBounds, scene, textElement } from "./testing";
import { renderText } from "./text";

/** A clip mid-reveal, so there is always something in flight to look at. */
function draw(reveal: Record<string, unknown>, progress: number) {
  const { canvas, ctx } = scene(400, 200, "#000000");
  renderText(
    ctx,
    "t",
    textElement({
      text: "AB CD EF",
      fontsize: 40,
      width: 380,
      textcolor: "#ffffff",
      reveal: { unit: "word", progress, ...reveal },
    } as any),
    0,
    undefined,
  );
  return { canvas, ink: inkBounds(canvas) };
}

describe("a reveal with no animator", () => {
  it("draws the same ink at rest as one that never had a reveal", () => {
    const { ink: withReveal } = draw({}, 100);

    const { canvas, ctx } = scene(400, 200, "#000000");
    renderText(
      ctx,
      "t",
      textElement({
        text: "AB CD EF",
        fontsize: 40,
        width: 380,
        textcolor: "#ffffff",
      } as any),
      0,
      undefined,
    );

    // A finished reveal must be indistinguishable from no reveal, or a static
    // frame would depend on the feature.
    expect(withReveal).toEqual(inkBounds(canvas));
  });
});

describe("a reveal with an animator", () => {
  it("settles to exactly the same picture", () => {
    // The claim that makes the animator safe to add: at rest it changes
    // nothing, so no existing project's last frame moves.
    const plain = draw({}, 100).ink;
    const animated = draw(
      { animate: { scale: 180, offsetY: 40, window: 2 } },
      100,
    ).ink;
    expect(animated).toEqual(plain);
  });

  it("puts an arriving word somewhere a plain reveal would not", () => {
    // Handed the same progress, the two must disagree — otherwise this suite
    // would pass against a renderer that ignored `move` entirely.
    const plain = draw({ fade: 1 }, 30).ink;
    const lifted = draw(
      { animate: { offsetY: 60, window: 1, opacity: 100 } },
      30,
    ).ink;

    expect(lifted.minY).not.toBe(plain.minY);
    // Lifted downwards, so the ink reaches further down the frame.
    expect(lifted.maxY).toBeGreaterThan(plain.maxY);
  });

  it("scales an arriving word about its own centre", () => {
    const plain = draw({ fade: 1 }, 30).ink;
    const grown = draw(
      { animate: { scale: 200, window: 1, opacity: 100 } },
      30,
    ).ink;

    // Bigger in both directions than the settled version of the same words.
    expect(grown.maxY - grown.minY).toBeGreaterThan(plain.maxY - plain.minY);
  });

  it("keeps the settled words exactly where they were", () => {
    // The whole point of scaling about the unit's own centre: an arriving word
    // must not shove the ones already in place. The first word is settled at
    // this progress under both.
    const at = (animate: Record<string, unknown> | null) => {
      const { canvas } = draw(animate == null ? { fade: 1 } : { animate }, 55);
      return inkBounds(canvas).minX;
    };

    expect(at({ scale: 200, window: 1, opacity: 100 })).toBe(at(null));
  });

  it("blurs an arriving word", () => {
    const sharpCount = draw(
      { animate: { offsetY: 0, scale: 120, window: 1, opacity: 100 } },
      30,
    ).ink.count;
    const blurredCount = draw(
      { animate: { offsetY: 0, scale: 120, blur: 6, window: 1, opacity: 100 } },
      30,
    ).ink.count;

    // A blur spreads ink over more pixels than it started on.
    expect(blurredCount).toBeGreaterThan(sharpCount);
  });

  it("draws every frame of the reveal without throwing", () => {
    // An overshooting easing takes the interpolation outside 0-1, and a
    // negative blur radius or a mirrored scale would throw inside the paint
    // loop — which is a blank frame, not a wrong one.
    for (let progress = 0; progress <= 100; progress += 2) {
      expect(() =>
        draw(
          {
            animate: {
              scale: 160,
              offsetY: 30,
              rotation: 12,
              blur: 4,
              window: 3,
              easing: "overshoot",
            },
          },
          progress,
        ),
      ).not.toThrow();
    }
  });
});
